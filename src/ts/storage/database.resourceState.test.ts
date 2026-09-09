import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../process/modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

import {
  collectionsResourceState,
  charactersResourceState,
  resetServerResourceState,
  replaceResourceDatabase,
  settingsResourceState,
} from '../server/resourceState.svelte'

import { applyServerResourceDatabase, setDatabase, setDatabaseLite, type Database } from './database.svelte'
import { getDatabase, getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

function databaseFixture(name = 'Ada'): Database {
  return {
    language: 'en',
    characters: [{ chaId: 'char-a', name, chats: [] }],
    characterOrder: ['char-a'],
    currentChar: 0,
    modules: [],
    plugins: [],
    modelPresets: [],
    promptPresets: [],
    botPresets: [],
    promptTemplate: [],
    personas: [],
    loadouts: [],
    loreBook: [],
    translatorPresets: [],
    hypaV3Presets: [],
    pluginCustomStorage: {},
    agentPresets: [],
    customSidebarItems: [],
    chatGenerationTogglePresets: [],
  } as unknown as Database
}

beforeEach(() => {
  resetServerResourceState()
})

afterEach(() => {
  resetServerResourceState()
})

describe('test database adapter over resource state', () => {
  it('routes the test adapter through resource slices', () => {
    replaceResourceDatabase(databaseFixture())

    expect(getDatabase()).toBe(getResourceDatabase())
    expect(settingsResourceState.value.language).toBe('en')
    expect(collectionsResourceState.values.modules).toEqual([])
    expect(charactersResourceState.characters[0]?.name).toBe('Ada')

    getDatabase().language = 'ko'
    expect(settingsResourceState.value.language).toBe('ko')

    const snapshot = getDatabase({ snapshot: true })
    snapshot.language = 'fr'
    expect(getDatabase().language).toBe('ko')
  })

  it('makes setDatabase and setDatabaseLite replace the resource-backed database', () => {
    setDatabase(databaseFixture('Normalized'))
    expect(getDatabase().characters[0]?.name).toBe('Normalized')
    expect(settingsResourceState.status).toBe('ready')

    setDatabaseLite(databaseFixture('Lite'))
    expect(getDatabase().characters[0]?.name).toBe('Lite')
    expect(charactersResourceState.characters[0]?.name).toBe('Lite')
  })

  it('seeds resource revisions on an authoritative replacement', () => {
    applyServerResourceDatabase(databaseFixture('Projected'), 17)

    expect(getDatabase().characters[0]?.name).toBe('Projected')
    expect(settingsResourceState.revision).toBe(17)
    expect(collectionsResourceState.fullRevision).toBe(17)
    expect(charactersResourceState.listRevision).toBe(17)
  })

  it('backfills post-launch display settings when an authoritative database predates them', () => {
    const database = databaseFixture()

    applyServerResourceDatabase(database)

    expect(getDatabase().chatScreenWidth).toBe(900)
    expect(getDatabase().autoTranslateNotificationDeferCapSeconds).toBe(180)
    expect(getDatabase().desktopSidebarColumns).toBe(1)
    expect(getDatabase().mobileSidebarColumns).toBe(1)
  })

  it('removes unsupported legacy database-key sidebar rows during resource normalization', () => {
    const database = databaseFixture()
    database.customSidebarItems = [
      {
        id: 'legacy-database-key',
        type: 'databaseKey',
        subType: 'temperature',
        label: 'Temperature',
      },
      {
        id: 'loadout',
        type: 'loadout',
        subType: 'none',
        label: 'Loadouts',
      },
    ] as Database['customSidebarItems']

    applyServerResourceDatabase(database)

    expect(getDatabase().customSidebarItems).toEqual([
      {
        id: 'loadout',
        type: 'loadout',
        subType: 'none',
        label: 'Loadouts',
      },
    ])
  })
})
