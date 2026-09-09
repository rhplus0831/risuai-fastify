import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRoute } from '../routerRoute'
import {
  PLAYGROUND_RESOURCE_SURFACE_BY_INDEX,
  RESOURCE_COLLECTION_NAMES,
  RESOURCE_PROJECTION_NAMES,
  RESOURCE_PURPOSES,
  RESOURCE_SURFACE_MANIFEST,
  SETTINGS_RESOURCE_SURFACE_BY_INDEX,
  STANDALONE_SETTING_NAMES,
  resolveResourceRequirements,
  resourceRequirementIdentity,
  resourceSurfacesForRoute,
  type ResourceRequirement,
  type ResourceSurfaceId,
} from './resourceManifest'
import { SERVER_COLLECTION_NAMES } from './resourceState.svelte'
import { SERVER_SETTINGS_GROUP_BY_KEY, SERVER_SETTINGS_KEYS_BY_GROUP, SETTINGS_GROUPS } from './settingsGroups'
import { SERVER_SHELL_SETTINGS_KEYS } from '@risuai/protocol/shell-resource'
import { SERVER_STANDALONE_SETTING_NAMES } from '@risuai/protocol/standalone-settings'

const canonicalSettingsRoutes = [
  ['/settings/backup', 0],
  ['/settings/bot-preset', 1],
  ['/settings/memory', 2],
  ['/settings/display', 3],
  ['/settings/plugins', 4],
  ['/settings/advanced', 6],
  ['/settings/communities', 7],
  ['/settings/global-lorebook', 8],
  ['/settings/global-regex', 9],
  ['/settings/language', 10],
  ['/settings/accessibility', 11],
  ['/settings/persona', 12],
  ['/settings/prompt', 13],
  ['/settings/modules', 14],
  ['/settings/hotkeys', 15],
  ['/settings/model', 17],
  ['/settings/prompt-settings', 18],
  ['/settings/agent-presets', 19],
  ['/settings/input-hooks', 20],
  ['/settings/request-history', 21],
  ['/settings/source-code', 22],
  ['/settings/bardwiki', 23],
  ['/settings/supporter', 77],
] as const

const canonicalPlaygroundRoutes = [
  ['/playground', 1],
  ['/playground/chat', 2],
  ['/playground/embedding', 3],
  ['/playground/tokenizer', 4],
  ['/playground/syntax', 5],
  ['/playground/jinja', 6],
  ['/playground/image-gen', 7],
  ['/playground/parser', 8],
  ['/playground/subtitles', 9],
  ['/playground/image-trans', 10],
  ['/playground/translation', 11],
  ['/playground/mcp', 12],
  ['/playground/cbs', 13],
  ['/playground/inlays', 14],
  ['/playground/tools', 101],
] as const

describe('route resource manifest', () => {
  it('keeps shared resource vocabularies aligned with their application and protocol owners', () => {
    expect(RESOURCE_COLLECTION_NAMES).toEqual(SERVER_COLLECTION_NAMES)
    expect(STANDALONE_SETTING_NAMES).toEqual(SERVER_STANDALONE_SETTING_NAMES)
  })

  it('declares valid resources, purposes, and source owners for every surface', () => {
    const purposes = new Set(RESOURCE_PURPOSES)
    const settingsGroups = new Set(SETTINGS_GROUPS)
    const collections = new Set(SERVER_COLLECTION_NAMES)
    const standaloneSettings = new Set(STANDALONE_SETTING_NAMES)
    const projections = new Set(RESOURCE_PROJECTION_NAMES)

    for (const [surfaceId, surface] of Object.entries(RESOURCE_SURFACE_MANIFEST)) {
      expect(surface.owners.length, `${surfaceId} has no declared consumer`).toBeGreaterThan(0)
      for (const owner of surface.owners) {
        expect(existsSync(owner), `${surfaceId} owner does not exist: ${owner}`).toBe(true)
      }

      const identities = surface.requirements.map(resourceRequirementIdentity)
      expect(new Set(identities).size, `${surfaceId} repeats a requirement`).toBe(identities.length)

      for (const requirement of surface.requirements) {
        expect(requirement.purposes.length, `${surfaceId} requirement has no purpose`).toBeGreaterThan(0)
        for (const purpose of requirement.purposes) expect(purposes.has(purpose)).toBe(true)

        switch (requirement.kind) {
          case 'settings-group':
            expect(settingsGroups.has(requirement.group)).toBe(true)
            if (requirement.keys) {
              expect(requirement.keys.length).toBeGreaterThan(0)
              for (const key of requirement.keys) {
                expect(
                  SERVER_SETTINGS_KEYS_BY_GROUP[requirement.group].includes(key),
                  `${surfaceId} assigns ${key} to ${requirement.group}`,
                ).toBe(true)
              }
            }
            break
          case 'collection':
            expect(collections.has(requirement.collection)).toBe(true)
            break
          case 'standalone-setting':
            expect(standaloneSettings.has(requirement.setting)).toBe(true)
            break
          case 'projection':
            expect(projections.has(requirement.projection)).toBe(true)
            break
        }
      }
    }
  })

  it('keeps granular-read contract gaps explicit', () => {
    const declaredStandaloneSettings = new Set(
      Object.values(RESOURCE_SURFACE_MANIFEST).flatMap((surface) =>
        surface.requirements.flatMap((requirement) =>
          requirement.kind === 'standalone-setting' ? [requirement.setting] : [],
        ),
      ),
    )

    for (const setting of STANDALONE_SETTING_NAMES) {
      expect(SERVER_SETTINGS_GROUP_BY_KEY).not.toHaveProperty(setting)
      for (const keys of Object.values(SERVER_SETTINGS_KEYS_BY_GROUP)) expect(keys).not.toContain(setting)
      expect(declaredStandaloneSettings).toContain(setting)
    }
  })

  it.each(canonicalSettingsRoutes)('maps %s to its declared settings surface', (path, index) => {
    const route = parseRoute(path)
    expect(route).toMatchObject({ kind: 'settings', index })
    expect(resourceSurfacesForRoute(route)).toEqual([
      'shared:app-shell',
      'shared:settings-shell',
      SETTINGS_RESOURCE_SURFACE_BY_INDEX[index],
    ])
  })

  it.each(['/settings/other-bots', '/settings/otherbots'])(
    'keeps the legacy Memory alias %s on the canonical Memory resource surface',
    (path) => {
      const route = parseRoute(path)
      expect(route).toMatchObject({ kind: 'settings', index: 2 })
      expect(resourceSurfacesForRoute(route)).toEqual(['shared:app-shell', 'shared:settings-shell', 'settings:memory'])
    },
  )

  it('keeps the standalone BardWiki settings surface narrowly hydrated', () => {
    expect(RESOURCE_SURFACE_MANIFEST['settings:bardwiki'].requirements).toEqual([
      {
        kind: 'settings-group',
        group: 'memory',
        keys: ['bardWiki'],
        purposes: ['render', 'interact', 'mutate'],
      },
      {
        kind: 'settings-group',
        group: 'providers',
        keys: ['modelProfiles'],
        purposes: ['render', 'interact'],
      },
      {
        kind: 'collection',
        collection: 'promptPresets',
        purposes: ['render', 'interact'],
      },
    ])
  })

  it.each([
    ['settings:memory', 'hypaV3ProgressOpenChatOnly', 'mutate'],
    ['settings:memory', 'loreBookDepth', 'mutate'],
    ['settings:memory', 'localActivationInGlobalLorebook', 'mutate'],
    ['settings:display', 'keepSessionAlive', 'mutate'],
    ['settings:bot-model-prompt', 'gptVisionQuality', 'mutate'],
    ['settings:language', 'useExperimental', 'render'],
    ['settings:prompt-template', 'additionalPrompt', 'mutate'],
  ] as const)('hydrates relocated setting %s / %s for %s', (surfaceId, key, purpose) => {
    const group = SERVER_SETTINGS_GROUP_BY_KEY[key]
    const surface = RESOURCE_SURFACE_MANIFEST[surfaceId]
    const requirement = surface.requirements.find(
      (candidate) => candidate.kind === 'settings-group' && candidate.group === group,
    )

    expect(requirement).toBeTruthy()
    expect(requirement?.purposes).toContain(purpose)
    if (requirement?.kind === 'settings-group' && requirement.keys) expect(requirement.keys).toContain(key)
  })

  it.each(canonicalPlaygroundRoutes)('maps %s to its declared Playground surface', (path, index) => {
    const route = parseRoute(path)
    expect(route).toMatchObject({ kind: 'playground', index })
    const expected: ResourceSurfaceId[] = [
      'shared:app-shell',
      'shared:playground-shell',
      PLAYGROUND_RESOURCE_SURFACE_BY_INDEX[index],
    ]
    if (index === 2) expected.push('runtime:chat-display', 'runtime:chat-generation')
    expect(resourceSurfacesForRoute(route)).toEqual(expected)
  })

  it('maps every non-indexed route family and distinguishes an open chat', () => {
    expect(resourceSurfacesForRoute(parseRoute('/'))).toEqual(['shared:app-shell', 'route:home'])
    expect(resourceSurfacesForRoute(parseRoute('/grid'))).toEqual(['shared:app-shell', 'route:grid'])
    expect(resourceSurfacesForRoute(parseRoute('/inlay'))).toEqual(['shared:app-shell', 'route:inlay'])
    expect(resourceSurfacesForRoute(parseRoute('/missing'))).toEqual(['shared:app-shell', 'route:not-found'])
    expect(resourceSurfacesForRoute(parseRoute('/character/a'))).toEqual(['shared:app-shell', 'route:character'])
    expect(resourceSurfacesForRoute(parseRoute('/character/a/chat-b'))).toEqual([
      'shared:app-shell',
      'route:character',
      'route:character-chat',
      'runtime:chat-display',
      'runtime:chat-generation',
    ])
  })

  it('keeps the app shell free of route collections and detail projections', () => {
    const shellRequirements: readonly ResourceRequirement[] = RESOURCE_SURFACE_MANIFEST['shared:app-shell'].requirements
    expect(shellRequirements.some((requirement) => requirement.kind === 'collection')).toBe(false)

    const shellProjections = shellRequirements.flatMap((requirement) =>
      requirement.kind === 'projection' ? [requirement.projection] : [],
    )
    expect(shellProjections).toEqual(['character-summaries', 'character-selection'])
    expect(shellProjections).not.toContain('selected-character')
    expect(shellProjections).not.toContain('selected-chat')
    expect(shellProjections).not.toContain('inlay-catalog')

    const shellSettingKeys = shellRequirements.flatMap((requirement) =>
      requirement.kind === 'settings-group' ? (requirement.keys ?? []) : [],
    )
    expect(new Set(shellSettingKeys)).toEqual(new Set(SERVER_SHELL_SETTINGS_KEYS))
  })

  it('hydrates the complete persona owner before rendering a character chat', () => {
    const requirements = resolveResourceRequirements(
      resourceSurfacesForRoute(parseRoute('/character/character-a/chat-a')),
    )
    const standaloneSettings = requirements.flatMap((requirement) =>
      requirement.kind === 'standalone-setting' ? [requirement.setting] : [],
    )
    const account = requirements.find(
      (requirement) => requirement.kind === 'settings-group' && requirement.group === 'account',
    )

    expect(standaloneSettings).toEqual(
      expect.arrayContaining(['selectedPersonaId', 'selectedPersona', 'personaPrompt', 'userIcon', 'userNote']),
    )
    expect(account).toMatchObject({ keys: ['username'], purposes: ['render'] })
    expect(
      requirements.some((requirement) => requirement.kind === 'collection' && requirement.collection === 'personas'),
    ).toBe(true)
  })

  it('declares generation selection pointers outside the minimal shell', () => {
    const requirements: readonly ResourceRequirement[] =
      RESOURCE_SURFACE_MANIFEST['runtime:chat-generation'].requirements
    const collections = requirements.flatMap((requirement) =>
      requirement.kind === 'collection' ? [requirement.collection] : [],
    )
    const standaloneSettings = requirements.flatMap((requirement) =>
      requirement.kind === 'standalone-setting' ? [requirement.setting] : [],
    )

    expect(collections).toEqual(expect.arrayContaining(['botPresets', 'modelPresets', 'promptPresets']))
    expect(standaloneSettings).toEqual(
      expect.arrayContaining([
        'botPresetsId',
        'modelPresetsId',
        'promptPresetsId',
        'selectedPersonaId',
        'selectedPersona',
      ]),
    )
  })

  it('deduplicates inherited requirements and combines purposes and exact keys', () => {
    const requirements = resolveResourceRequirements(['shared:settings-shell', 'settings:global-regex'])
    const identities = requirements.map(resourceRequirementIdentity)
    expect(new Set(identities).size).toBe(identities.length)

    const advanced = requirements.find(
      (requirement) => requirement.kind === 'settings-group' && requirement.group === 'advanced',
    )
    expect(advanced).toMatchObject({
      kind: 'settings-group',
      group: 'advanced',
      keys: ['doNotWarnExternalServers', 'showGlobalLorebookAndRegex', 'globalscript'],
      purposes: ['render', 'interact', 'mutate'],
    })
  })

  it('lets a complete group requirement dominate inherited exact-key requirements', () => {
    const requirements = resolveResourceRequirements(['shared:app-shell', 'settings:display'])
    const display = requirements.find(
      (requirement) => requirement.kind === 'settings-group' && requirement.group === 'display',
    )
    expect(display).toMatchObject({ kind: 'settings-group', group: 'display' })
    expect(display).not.toHaveProperty('keys')
  })

  it('uses the provider superset read when a surface also declares model profiles', () => {
    const requirements = resolveResourceRequirements(['runtime:plugins', 'runtime:chat-generation'])
    const providers = requirements.find(
      (requirement) => requirement.kind === 'settings-group' && requirement.group === 'providers',
    )

    expect(providers).toMatchObject({ purposes: ['interact', 'generate'] })
    expect(providers).not.toHaveProperty('keys')
    expect(
      requirements.some((requirement) => requirement.kind === 'settings-group' && requirement.group === 'models'),
    ).toBe(false)
  })
})
