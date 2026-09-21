import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  patchServerBackedSettings,
  patchSettingsGroup,
  patchSettingsObjectFieldsCommand,
  settingsGroupForKey,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'
import { createDestructiveRefreshToken } from './staleStateGuards'

describe('settings command adapters', () => {
  it('patches grouped scalar settings with the auth header and baseRevision', async () => {
    const event = { type: 'settings.updated', revision: 3, resource: 'settings' }
    const commandFetch = makeCommandFetch(() => ({ revision: 3, event }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'light', zoomsize: 90 },
    })

    expect(result).toEqual({ status: 'ok', revision: 3, event })
    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/display',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        writerSessionHeader: 'command-test-writer',
        contentType: 'application/json',
        body: {
          baseRevision: 2,
          patch: { theme: 'light', zoomsize: 90 },
        },
      },
    ])
  })

  it('exposes the canonical settings patch as a response-confirmed local effect', async () => {
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'display',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      acknowledgedKeys: ['theme', 'zoomsize'],
      settings: { theme: 'light' },
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'LIGHT', zoomsize: 90 },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 12,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { theme: 'LIGHT', zoomsize: 90 },
        settings: { theme: 'light', zoomsize: 90 },
        settingsProjectionEpoch: 12,
      },
    ])
  })

  it('reconstructs omitted large verbatim settings in the local effect', async () => {
    const customCSS = `/* large */${'x'.repeat(64 * 1024)}`
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'display',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      acknowledgedKeys: ['customCSS'],
      settings: {},
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { customCSS },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 13,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { customCSS },
        settings: { customCSS },
        settingsProjectionEpoch: 13,
      },
    ])
  })

  it('requires opt-in and a projection epoch before acknowledging a settings patch locally', async () => {
    const commandFetch = makeCommandFetch((_url, init) => {
      const request = JSON.parse(String(init?.body)) as { baseRevision: number }
      const revision = request.baseRevision + 1
      return {
        revision,
        event: {
          type: 'settings.updated',
          revision,
          resource: 'settings',
          id: 'display',
        },
        acknowledgedKeys: ['theme'],
        settings: { theme: 'light' },
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    setCachedServerCommandRevision(1)
    const observedEffects: ServerCommandLocalEffect[][] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push([...localEffects.values()])
    })

    await patchServerBackedSettings({ patch: { theme: 'LIGHT' } })
    await patchServerBackedSettings({ patch: { theme: 'LIGHT' }, acknowledgeOptimistic: true })
    await patchServerBackedSettings({
      patch: { theme: 'LIGHT' },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: { display: 7 },
    })

    expect(observedEffects).toEqual([
      [],
      [],
      [
        {
          kind: 'settingsPatch',
          group: 'display',
          attemptedPatch: { theme: 'LIGHT' },
          settings: { theme: 'light' },
          settingsProjectionEpoch: 7,
        },
      ],
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 1, patch: { theme: 'LIGHT' } },
      { baseRevision: 2, patch: { theme: 'LIGHT' } },
      { baseRevision: 3, patch: { theme: 'LIGHT' } },
    ])
    expect(commandFetch.calls[2]?.body).not.toHaveProperty('acknowledgeOptimistic')
    expect(commandFetch.calls[2]?.body).not.toHaveProperty('optimisticProjectionEpochs')
  })

  it('sends only shallow object changes while reconstructing the full optimistic settings value locally', async () => {
    const attemptedObject = {
      width: 832,
      height: 768,
      vibe_data: { thumbnail: 'x'.repeat(64 * 1024) },
    }
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'media',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      group: 'media',
      key: 'NAIImgConfig',
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['width'],
      deletedKeys: [],
      canonicalValues: {},
      canonicalDeletedKeys: [],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsObjectFieldsCommand({
      group: 'media',
      key: 'NAIImgConfig',
      baseRevision: 2,
      update: { patch: { width: 832 } },
      attemptedObject,
      optimisticProjectionEpoch: 12,
    })

    expect(commandFetch.calls).toEqual([
      {
        url: '/api/v1/commands/settings/media/objects/NAIImgConfig',
        method: 'PATCH',
        authHeader: 'test-auth-token',
        writerSessionHeader: 'command-test-writer',
        contentType: 'application/json',
        body: { baseRevision: 2, patch: { width: 832 } },
      },
    ])
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'media',
        attemptedPatch: { NAIImgConfig: attemptedObject },
        settings: { NAIImgConfig: attemptedObject },
        settingsProjectionEpoch: 12,
      },
    ])
  })

  it('applies a masked secret override from a compact shallow settings acknowledgement', async () => {
    const attemptedObject = { key: 'new-secret', model: 'flux' }
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'media',
    }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      group: 'media',
      key: 'wavespeedImage',
      certificate: 'settings-object-patch-v1',
      patchedKeys: ['key'],
      deletedKeys: [],
      canonicalValues: { key: '__RISU_SECRET_MASKED__' },
      canonicalDeletedKeys: [],
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    await patchSettingsObjectFieldsCommand({
      group: 'media',
      key: 'wavespeedImage',
      baseRevision: 2,
      update: { patch: { key: 'new-secret' } },
      attemptedObject,
      optimisticProjectionEpoch: 4,
    })

    expect(commandFetch.calls[0].body).toEqual({ baseRevision: 2, patch: { key: 'new-secret' } })
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'media',
        attemptedPatch: { wavespeedImage: attemptedObject },
        settings: { wavespeedImage: { key: '__RISU_SECRET_MASKED__', model: 'flux' } },
        settingsProjectionEpoch: 4,
      },
    ])
  })

  it('keeps malformed shallow settings acknowledgements on the authoritative fallback path', async () => {
    const event = {
      type: 'settings.updated',
      revision: 3,
      resource: 'settings',
      id: 'media',
    }
    const malformedBodies = [
      {
        revision: 3,
        event,
        group: 'media',
        key: 'NAIImgConfig',
        certificate: 'settings-object-patch-v1',
        patchedKeys: ['height'],
        deletedKeys: [],
        canonicalValues: {},
        canonicalDeletedKeys: [],
      },
      {
        revision: 3,
        event,
        group: 'media',
        key: 'NAIImgConfig',
        certificate: 'settings-object-patch-v1',
        patchedKeys: ['width'],
        deletedKeys: [],
        canonicalValues: { height: 900 },
        canonicalDeletedKeys: [],
      },
    ]
    let responseIndex = 0
    const commandFetch = makeCommandFetch(() => malformedBodies[responseIndex++])
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffectCounts: number[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffectCounts.push(localEffects.size)
    })

    for (const _body of malformedBodies) {
      await patchSettingsObjectFieldsCommand({
        group: 'media',
        key: 'NAIImgConfig',
        baseRevision: 2,
        update: { patch: { width: 832 } },
        attemptedObject: { width: 832, height: 768 },
        optimisticProjectionEpoch: 1,
      })
    }

    expect(observedEffectCounts).toEqual([0, 0])
  })

  it('accepts an exact value-free compact settings acknowledgement', async () => {
    const event = { type: 'settings.updated', revision: 3, resource: 'settings', id: 'display' }
    const commandFetch = makeCommandFetch(() => ({
      revision: 3,
      event,
      acknowledgedKeys: ['theme', 'zoomsize'],
      settings: {},
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    const result = await patchSettingsGroup({
      group: 'display',
      baseRevision: 2,
      patch: { theme: 'light', zoomsize: 90 },
      acknowledgeOptimistic: true,
      optimisticProjectionEpoch: 12,
    })

    expect(result.status).toBe('ok')
    expect(observedEffects).toEqual([
      {
        kind: 'settingsPatch',
        group: 'display',
        attemptedPatch: { theme: 'light', zoomsize: 90 },
        settings: { theme: 'light', zoomsize: 90 },
        settingsProjectionEpoch: 12,
      },
    ])
  })

  it.each([
    { label: 'missing acknowledgement key', overrides: { acknowledgedKeys: ['theme'] } },
    { label: 'duplicate acknowledgement key', overrides: { acknowledgedKeys: ['theme', 'theme', 'zoomsize'] } },
    { label: 'foreign canonical override', overrides: { settings: { customCSS: 'not acknowledged' } } },
    { label: 'non-JSON canonical override', overrides: { settings: { theme: Number.NaN } } },
    {
      label: 'wrong event type',
      overrides: { event: { type: 'settings.other', revision: 3, resource: 'settings', id: 'display' } },
    },
    {
      label: 'parent-scoped event',
      overrides: {
        event: { type: 'settings.updated', revision: 3, resource: 'settings', id: 'display', parentId: 'unexpected' },
      },
    },
  ])(
    'keeps malformed compact settings acknowledgements on the authoritative fallback path: $label',
    async ({ overrides }) => {
      const body = {
        revision: 3,
        event: { type: 'settings.updated', revision: 3, resource: 'settings', id: 'display' },
        acknowledgedKeys: ['theme', 'zoomsize'],
        settings: {},
        ...overrides,
      }
      // Preserve the non-JSON override so this case exercises validation, not JSON's NaN-to-null conversion.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 200, ok: true, json: async () => body }) as Response),
      )
      const reconciliations: Array<{ event: unknown; effects: ServerCommandLocalEffect[] }> = []
      setServerCommandSuccessReconciler((event, _events, localEffects) => {
        reconciliations.push({ event, effects: [...localEffects.values()] })
      })

      const result = await patchSettingsGroup({
        group: 'display',
        baseRevision: 2,
        patch: { theme: 'light', zoomsize: 90 },
        acknowledgeOptimistic: true,
        optimisticProjectionEpoch: 12,
      })

      expect(result.status).toBe('ok')
      expect(reconciliations).toEqual([{ event: body.event, effects: [] }])
    },
  )

  it('maps projection-sweep toggles to server-backed settings groups', () => {
    expect(settingsGroupForKey('notification')).toBe('display')
    expect(settingsGroupForKey('useAutoSuggestions')).toBe('runtime')
    expect(settingsGroupForKey('useAutoTranslateInput')).toBe('language')
    expect(settingsGroupForKey('translatorExcludeThoughts')).toBe('language')
    expect(settingsGroupForKey('globalChatVariables')).toBe('sidebar')
    expect(settingsGroupForKey('jailbreakToggle')).toBe('sidebar')
    expect(settingsGroupForKey('customSidebarItems')).toBe('sidebar')
    expect(settingsGroupForKey('ooba')).toBe('providers')
    expect(settingsGroupForKey('reverseProxyOobaArgs')).toBe('providers')
    expect(settingsGroupForKey('localStopStrings')).toBe('runtime')
    expect(settingsGroupForKey('NAIsettings')).toBe('providers')
    expect(settingsGroupForKey('ainconfig')).toBe('providers')
    expect(settingsGroupForKey('bias')).toBe('providers')
    expect(settingsGroupForKey('additionalParams')).toBe('providers')
    expect(settingsGroupForKey('aiModel')).toBe('providers')
    expect(settingsGroupForKey('subModel')).toBe('providers')
    expect(settingsGroupForKey('google')).toBe('providers')
    expect(settingsGroupForKey('vertexClientEmail')).toBe('providers')
    expect(settingsGroupForKey('vertexPrivateKey')).toBe('providers')
    expect(settingsGroupForKey('vertexAccessToken')).toBe('providers')
    expect(settingsGroupForKey('vertexAccessTokenExpires')).toBe('providers')
    expect(settingsGroupForKey('vertexRegion')).toBe('providers')
    expect(settingsGroupForKey('novelai')).toBe('providers')
    expect(settingsGroupForKey('OaiCompAPIKeys')).toBe('providers')
    expect(settingsGroupForKey('hordeConfig')).toBe('providers')
    expect(settingsGroupForKey('ollamaCloudModel')).toBe('providers')
    expect(settingsGroupForKey('ollamaCloudModelName')).toBe('providers')
    expect(settingsGroupForKey('nanogptRequestModel')).toBe('providers')
    expect(settingsGroupForKey('nanogptRequestModelName')).toBe('providers')
    expect(settingsGroupForKey('openrouterRequestModel')).toBe('providers')
    expect(settingsGroupForKey('openrouterFallback')).toBe('providers')
    expect(settingsGroupForKey('openrouterMiddleOut')).toBe('providers')
    expect(settingsGroupForKey('openrouterProvider')).toBe('providers')
    expect(settingsGroupForKey('useInstructPrompt')).toBe('providers')
    expect(settingsGroupForKey('instructChatTemplate')).toBe('providers')
    expect(settingsGroupForKey('JinjaTemplate')).toBe('providers')
    expect(settingsGroupForKey('providerCredentials')).toBe('providers')
    expect(settingsGroupForKey('modelProfiles')).toBe('providers')
    expect(settingsGroupForKey('modelRoleProfiles')).toBe('providers')
    expect(settingsGroupForKey('modelRuntimeDefaults')).toBe('providers')
    expect(settingsGroupForKey('modelRoles')).toBe('providers')
    expect(settingsGroupForKey('seperateModels')).toBe('runtime')
    expect(settingsGroupForKey('seperateModelsForAxModels')).toBe('runtime')
    expect(settingsGroupForKey('doNotChangeSeperateModels')).toBe('runtime')
    expect(settingsGroupForKey('seperateParameters')).toBe('runtime')
    expect(settingsGroupForKey('seperateParametersByModel')).toBe('runtime')
    expect(settingsGroupForKey('seperateParametersEnabled')).toBe('runtime')
    expect(settingsGroupForKey('disableSeperateParameterChangeOnPresetChange')).toBe('runtime')
    expect(settingsGroupForKey('epEnabled')).toBe('runtime')
    expect(settingsGroupForKey('streamGeminiThoughts')).toBe('runtime')
    expect(settingsGroupForKey('verbosity')).toBe('runtime')
    expect(settingsGroupForKey('doNotWarnExternalServers')).toBe('advanced')
    expect(settingsGroupForKey('pluginCompatibilityMode')).toBe('advanced')
    expect(settingsGroupForKey('strictScriptCheck')).toBe('advanced')
    expect(settingsGroupForKey('regexOutputSizeLimitMiB')).toBe('advanced')
    expect(settingsGroupForKey('sdProvider')).toBe('media')
    expect(settingsGroupForKey('webUiUrl')).toBe('media')
    expect(settingsGroupForKey('sdSteps')).toBe('media')
    expect(settingsGroupForKey('sdCFG')).toBe('media')
    expect(settingsGroupForKey('sdConfig')).toBe('media')
    expect(settingsGroupForKey('NAIImgUrl')).toBe('media')
    expect(settingsGroupForKey('NAIApiKey')).toBe('media')
    expect(settingsGroupForKey('NAIImgModel')).toBe('media')
    expect(settingsGroupForKey('NAII2I')).toBe('media')
    expect(settingsGroupForKey('NAIImgConfig')).toBe('media')
    expect(settingsGroupForKey('dallEQuality')).toBe('media')
    expect(settingsGroupForKey('stabilityKey')).toBe('media')
    expect(settingsGroupForKey('stabilityModel')).toBe('media')
    expect(settingsGroupForKey('stabllityStyle')).toBe('media')
    expect(settingsGroupForKey('comfyConfig')).toBe('media')
    expect(settingsGroupForKey('comfyUiUrl')).toBe('media')
    expect(settingsGroupForKey('falToken')).toBe('media')
    expect(settingsGroupForKey('falModel')).toBe('media')
    expect(settingsGroupForKey('falLora')).toBe('media')
    expect(settingsGroupForKey('falLoraScale')).toBe('media')
    expect(settingsGroupForKey('ImagenModel')).toBe('media')
    expect(settingsGroupForKey('ImagenImageSize')).toBe('media')
    expect(settingsGroupForKey('ImagenAspectRatio')).toBe('media')
    expect(settingsGroupForKey('ImagenPersonGeneration')).toBe('media')
    expect(settingsGroupForKey('openaiCompatImage')).toBe('media')
    expect(settingsGroupForKey('wavespeedImage')).toBe('media')
    expect(settingsGroupForKey('ttsAutoSpeech')).toBe('media')
    expect(settingsGroupForKey('elevenLabKey')).toBe('media')
    expect(settingsGroupForKey('voicevoxUrl')).toBe('media')
    expect(settingsGroupForKey('huggingfaceKey')).toBe('providers')
    expect(settingsGroupForKey('fishSpeechKey')).toBe('media')
    expect(settingsGroupForKey('emotionProcesser')).toBe('media')
    expect(settingsGroupForKey('hypaV3')).toBe('memory')
    expect(settingsGroupForKey('hypaV3Presets')).toBe('memory')
    expect(settingsGroupForKey('hypaV3PresetId')).toBe('memory')
    expect(settingsGroupForKey('hypaModel')).toBe('memory')
    expect(settingsGroupForKey('hypaV3Key')).toBe('memory')
    expect(settingsGroupForKey('hypaCustomSettings')).toBe('memory')
    expect(settingsGroupForKey('voyageApiKey')).toBe('memory')
    expect(settingsGroupForKey('enableCustomFlags')).toBe('advanced')
    expect(settingsGroupForKey('customFlags')).toBe('advanced')
    expect(settingsGroupForKey('enabledModules')).toBe('modules')
  })

  it('does not map retired Context Agent settings to command groups', () => {
    expect(settingsGroupForKey('agentContextEnabled')).toBeNull()
    expect(settingsGroupForKey('agentContextPrompt')).toBeNull()
    expect(settingsGroupForKey('agentContextMaxOutput')).toBeNull()
    expect(settingsGroupForKey('agentContextMaxToolRounds')).toBeNull()
  })

  it('patches mixed server-backed settings by group with the latest revision', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 10 }
      if (url.endsWith('/settings/providers')) {
        return {
          revision: 11,
          event: { type: 'settings.updated', revision: 11, resource: 'settings', id: 'providers' },
          acknowledgedKeys: ['aiModel'],
          settings: {},
        }
      }
      return {
        revision: 12,
        event: { type: 'settings.updated', revision: 12, resource: 'settings', id: 'runtime' },
        acknowledgedKeys: ['maxContext'],
        settings: {},
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })

    const result = await patchServerBackedSettings({
      patch: {
        aiModel: 'openrouter',
        maxContext: 12000,
      },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: { providers: 20, runtime: 30 },
    })

    expect(result).toEqual({
      status: 'ok',
      revision: 12,
      event: { type: 'settings.updated', revision: 12, resource: 'settings', id: 'runtime' },
      acknowledgedKeys: ['maxContext'],
      settings: {},
    })
    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/bootstrap',
        body: null,
      },
      {
        url: '/api/v1/commands/settings/providers',
        body: {
          baseRevision: 10,
          patch: { aiModel: 'openrouter' },
        },
      },
      {
        url: '/api/v1/commands/settings/runtime',
        body: {
          baseRevision: 11,
          patch: { maxContext: 12000 },
        },
      },
    ])
    expect(observedEffects).toEqual([])
  })

  it('keeps earlier accepted groups authoritative when a later settings group fails', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 10 }
      if (url.endsWith('/settings/providers')) {
        return {
          revision: 11,
          event: { type: 'settings.updated', revision: 11, resource: 'settings', id: 'providers' },
          acknowledgedKeys: ['aiModel'],
          settings: {},
        }
      }
      return jsonResponse({ error: 'maxContext must be a number' }, 400)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const rollback = vi.fn()
    const reconciliations: Array<{ revisions: number[]; localEffects: ServerCommandLocalEffect[] }> = []
    setServerCommandSuccessReconciler((_event, events, localEffects) => {
      reconciliations.push({
        revisions: events.map((event) => event.revision),
        localEffects: [...localEffects.values()],
      })
    })

    const result = await patchServerBackedSettings({
      patch: { aiModel: 'openrouter', maxContext: 'invalid' },
      acknowledgeOptimistic: true,
      optimisticProjectionEpochs: { providers: 20, runtime: 30 },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'maxContext must be a number',
      reason: 'invalid-request',
    })
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(reconciliations).toEqual([{ revisions: [11], localEffects: [] }])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      null,
      { baseRevision: 10, patch: { aiModel: 'openrouter' } },
      { baseRevision: 11, patch: { maxContext: 'invalid' } },
    ])
  })

  it('routes residual manual settings through existing settings groups', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 20 }
      if (url.endsWith('/settings/display')) {
        return {
          revision: 21,
          event: { type: 'settings.updated', revision: 21, resource: 'settings' },
        }
      }
      if (url.endsWith('/settings/providers')) {
        return {
          revision: 22,
          event: { type: 'settings.updated', revision: 22, resource: 'settings' },
        }
      }
      return {
        revision: 23,
        event: { type: 'settings.updated', revision: 23, resource: 'settings' },
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchServerBackedSettings({
      patch: {
        colorSchemeName: 'custom',
        textScreenColor: null,
        promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
        customModels: [{ id: 'model-a', name: 'Model A' }],
        bias: [['token', -10]],
        additionalParams: [['stop', 'value']],
        moduleIntergration: 'module-ns',
        globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
        banCharacterset: ['Latn'],
        allowAllExtentionFiles: true,
        auxModelUnderModelSettings: true,
        showUnrecommended: true,
        enableCustomFlags: true,
        customFlags: [8],
      },
    })

    expect(result).toEqual({
      status: 'ok',
      revision: 23,
      event: { type: 'settings.updated', revision: 23, resource: 'settings' },
    })
    expect(commandFetch.calls.map((call) => ({ url: call.url, body: call.body }))).toEqual([
      {
        url: '/api/v1/bootstrap',
        body: null,
      },
      {
        url: '/api/v1/commands/settings/display',
        body: {
          baseRevision: 20,
          patch: {
            colorSchemeName: 'custom',
            textScreenColor: null,
            promptDiffPrefs: { diffStyle: 'line', contextRadius: 2 },
          },
        },
      },
      {
        url: '/api/v1/commands/settings/providers',
        body: {
          baseRevision: 21,
          patch: {
            customModels: [{ id: 'model-a', name: 'Model A' }],
            bias: [['token', -10]],
            additionalParams: [['stop', 'value']],
          },
        },
      },
      {
        url: '/api/v1/commands/settings/advanced',
        body: {
          baseRevision: 22,
          patch: {
            moduleIntergration: 'module-ns',
            globalscript: [{ id: 'script-a', in: 'foo', out: 'bar', type: 'editinput' }],
            banCharacterset: ['Latn'],
            allowAllExtentionFiles: true,
            auxModelUnderModelSettings: true,
            showUnrecommended: true,
            enableCustomFlags: true,
            customFlags: [8],
          },
        },
      },
    ])
  })

  it('surfaces server-backed settings patch conflicts without retrying', async () => {
    let providerAttempts = 0
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 4 }
      if (url.endsWith('/settings/providers')) {
        providerAttempts += 1
        if (providerAttempts === 1) {
          return jsonResponse({ error: 'revision_conflict', currentRevision: 8 }, 409)
        }
        throw new Error('unexpected retry')
      }
      return { revision: 10 }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      patchServerBackedSettings({
        patch: { openrouterKey: 'secret' },
      }),
    ).resolves.toEqual({ status: 'conflict', currentRevision: 8 })

    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      null,
      { baseRevision: 4, patch: { openrouterKey: 'secret' } },
    ])
  })

  it('rolls back optimistic settings when a server-backed patch fails', async () => {
    const rollback = vi.fn()
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 1 }
      return jsonResponse({ error: 'aiModel must be a string' }, 400)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchServerBackedSettings({
      patch: { aiModel: 1 },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'aiModel must be a string',
      reason: 'invalid-request',
    })
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('skips settings rollback when a destructive refresh lands before patch failure', async () => {
    const liveSettings = { aiModel: 'attempted' }
    const rollback = vi.fn(() => {
      if (liveSettings.aiModel === 'attempted') liveSettings.aiModel = 'before'
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url === '/api/v1/bootstrap') return { revision: 1 }
      createDestructiveRefreshToken('test-full-settings-restore')
      liveSettings.aiModel = 'attempted'
      return jsonResponse({ error: 'aiModel must be a string' }, 400)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const result = await patchServerBackedSettings({
      patch: { aiModel: 1 },
      rollback,
    })

    expect(result).toEqual({
      status: 'error',
      error: 'aiModel must be a string',
      reason: 'invalid-request',
    })
    expect(rollback).not.toHaveBeenCalled()
    expect(liveSettings.aiModel).toBe('attempted')
  })
})
