import { describe, expect, it } from 'vitest'
import { SERVER_SETTINGS_KEYS_BY_GROUP } from '@risuai/shared-core/settings-groups'
import { READABLE_SETTINGS_GROUPS, SETTINGS_GROUP_KEYS, SETTINGS_GROUPS } from '../src/routes/commands.js'

describe('settings group parity', () => {
  it('lets the client accept every key returned by a readable settings group', () => {
    for (const group of READABLE_SETTINGS_GROUPS) {
      const endpointKeys = [
        ...SETTINGS_GROUP_KEYS[group].filter((key) => key !== 'hypaV3Presets'),
        ...(group === 'language' ? ['translatorPresetId'] : []),
        ...(group === 'advanced' ? ['igpPrompt'] : []),
      ]

      for (const key of endpointKeys) {
        expect(SERVER_SETTINGS_KEYS_BY_GROUP[group], `${group} response key ${key}`).toContain(key)
      }
    }
  })

  it('assigns every generically writable setting to exactly one canonical group', () => {
    const owners = new Map<string, string[]>()
    for (const group of SETTINGS_GROUPS) {
      const keys = SETTINGS_GROUP_KEYS[group]
      expect(new Set(keys).size, `${group} contains duplicate keys`).toBe(keys.length)
      for (const key of keys) {
        owners.set(key, [...(owners.get(key) ?? []), group])
      }
    }

    expect(
      [...owners.entries()].filter(([, groups]) => groups.length > 1),
      "writable settings must not advance a different group's revision fence",
    ).toEqual([])
  })

  it('keeps the dedicated Agent and Agent Preset projection readable but not generically writable', () => {
    expect(READABLE_SETTINGS_GROUPS).toContain('agents')
    expect(SETTINGS_GROUPS).not.toContain('agents')
    expect(SETTINGS_GROUP_KEYS.agents).toEqual(['agents', 'agentPresets', 'agentPresetDefaultId'])
    const clientGroups = SERVER_SETTINGS_KEYS_BY_GROUP as Record<string, string[]>
    expect(clientGroups.agents).toEqual([...SETTINGS_GROUP_KEYS.agents])
  })

  it('keeps the model profile projection exact, read-only, and provider-write compatible', () => {
    const modelProfileSettingsKeys = [
      'providerCredentials',
      'modelProfiles',
      'modelProfileOrder',
      'modelRoleProfiles',
      'modelRuntimeDefaults',
    ]
    expect(READABLE_SETTINGS_GROUPS).toContain('models')
    expect(SETTINGS_GROUPS).not.toContain('models')
    expect(SETTINGS_GROUP_KEYS.models).toEqual(modelProfileSettingsKeys)
    const clientGroups = SERVER_SETTINGS_KEYS_BY_GROUP as Record<string, string[]>
    expect(clientGroups.models).toEqual(modelProfileSettingsKeys)

    for (const key of modelProfileSettingsKeys) {
      expect(SETTINGS_GROUP_KEYS.providers).toContain(key)
      expect(clientGroups.providers).toContain(key)
    }
  })

  it('keeps named settings in their canonical server and client projections', () => {
    const expectedSettings = [
      ['advanced', 'inputHooks'],
      ['providers', 'openAIFlexProcessing'],
      ['display', 'chatScreenWidth'],
      ['display', 'customColorScheme'],
      ['display', 'chatLoadInitialPages'],
      ['display', 'chatLoadAdditionalPages'],
      ['display', 'autoTranslateNotificationDeferCapSeconds'],
      ['display', 'paragraphBreakBySentences'],
      ['display', 'paragraphBreakSentenceCount'],
      ['memory', 'bardWiki'],
    ] as const

    for (const [group, key] of expectedSettings) {
      expect(SETTINGS_GROUP_KEYS[group], `server projection for ${key}`).toContain(key)
      expect(SERVER_SETTINGS_KEYS_BY_GROUP[group], `client projection for ${key}`).toContain(key)
    }
  })

  it('keeps retired settings out of both canonical projections', () => {
    const retiredSettings = [
      ['providers', 'claudeBatching'],
      ['providers', 'claudeRetrivalCaching'],
      ['advanced', 'forceProxyAsOpenAI'],
      ['memory', 'removePunctuationHypa'],
      ['runtime', 'antiServerOverloads'],
      ['runtime', 'localNetworkMode'],
      ['runtime', 'localNetworkTimeoutSec'],
      ['runtime', 'googleClaudeTokenizing'],
      ['language', 'autoTranslate'],
    ] as const

    for (const [group, key] of retiredSettings) {
      expect(SETTINGS_GROUP_KEYS[group], `server projection for retired ${key}`).not.toContain(key)
      expect(SERVER_SETTINGS_KEYS_BY_GROUP[group], `client projection for retired ${key}`).not.toContain(key)
    }
  })

  it('exposes retained IGP configuration for effects without a generic write owner', () => {
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.advanced).toContain('igpPrompt')
    for (const group of SETTINGS_GROUPS) expect(SETTINGS_GROUP_KEYS[group]).not.toContain('igpPrompt')
  })
})
