import { describe, expect, it } from 'vitest'
import {
  MODEL_PROFILE_SETTINGS_KEYS,
  SERVER_SETTINGS_GROUP_BY_KEY,
  SERVER_SETTINGS_KEYS_BY_GROUP,
  SETTINGS_GROUPS,
  isSettingsGroup,
} from './settingsGroups'

describe('settings group contracts', () => {
  it('exposes Agents and Agent Presets through a dedicated read-only group', () => {
    expect(SETTINGS_GROUPS).toContain('agents')
    expect(isSettingsGroup('agents')).toBe(true)
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.agents).toEqual(['agents', 'agentPresets', 'agentPresetDefaultId'])

    // Dedicated Agent and Agent Preset commands own these values. Keeping them out of
    // the generic write-owner map prevents compatibility settings patches
    // from routing around that validation.
    expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty('agents')
    expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty('agentPresets')
    expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty('agentPresetDefaultId')
  })

  it('exposes model profile records through a dedicated read group while retaining provider write ownership', () => {
    expect(SETTINGS_GROUPS).toContain('models')
    expect(isSettingsGroup('models')).toBe(true)
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.models).toEqual([...MODEL_PROFILE_SETTINGS_KEYS])

    for (const key of MODEL_PROFILE_SETTINGS_KEYS) {
      expect(SERVER_SETTINGS_GROUP_BY_KEY[key]).toBe('providers')
      expect(SERVER_SETTINGS_KEYS_BY_GROUP.providers).toContain(key)
    }
  })

  it('exposes the Translator Preset selection only through language reads', () => {
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.language).toContain('translatorPresetId')
    expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty('translatorPresetId')
  })

  it('keeps stable Hypa V3 selection in the memory settings owner', () => {
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.memory).toEqual(
      expect.arrayContaining(['hypaV3Presets', 'selectedHypaV3PresetId', 'hypaV3PresetId']),
    )
  })

  it('persists reduced motion through the display settings group', () => {
    expect(SERVER_SETTINGS_GROUP_BY_KEY.reducedMotion).toBe('display')
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.display).toContain('reducedMotion')
  })

  it('persists the all-model additional-parameters opt-in with provider settings', () => {
    expect(SERVER_SETTINGS_GROUP_BY_KEY.applyAdditionalParamsToAll).toBe('providers')
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.providers).toContain('applyAdditionalParamsToAll')
  })

  it('persists the floating chat input through the sidebar settings group', () => {
    expect(SERVER_SETTINGS_GROUP_BY_KEY.floatingChatInput).toBe('sidebar')
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.sidebar).toContain('floatingChatInput')
  })

  it('persists sentence paragraph preferences through the display settings group', () => {
    for (const key of ['paragraphBreakBySentences', 'paragraphBreakSentenceCount']) {
      expect(SERVER_SETTINGS_GROUP_BY_KEY[key]).toBe('display')
      expect(SERVER_SETTINGS_KEYS_BY_GROUP.display).toContain(key)
    }
  })

  it('persists writer sidebar column preferences through the display settings group', () => {
    for (const key of ['desktopSidebarColumns', 'mobileSidebarColumns']) {
      expect(SERVER_SETTINGS_GROUP_BY_KEY[key]).toBe('display')
      expect(SERVER_SETTINGS_KEYS_BY_GROUP.display).toContain(key)
    }
  })

  it('does not expose retired Mood Light state as a server-backed setting', () => {
    expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty('moodLightMembership')
    expect(SERVER_SETTINGS_KEYS_BY_GROUP.sidebar).not.toContain('moodLightMembership')
    expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty('moodLightMode')
  })
})
