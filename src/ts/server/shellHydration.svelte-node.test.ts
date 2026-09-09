import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { character } from '../storage/databaseTypes'

const languageSideEffects = vi.hoisted(() => ({ change: vi.fn() }))

vi.mock('../../lang', () => ({ changeLanguage: languageSideEffects.change }))

import { clearAppliedServerResourceRevision, peekAppliedServerResourceRevision } from './commands'
import {
  applyCharacterResource,
  applyCharactersResource,
  applySettingsGroupResource,
  charactersResourceState,
  resetServerResourceState,
  settingsResourceState,
} from './resourceState.svelte'
import { applyServerShellResource } from './shellHydration'
import { SERVER_SHELL_PROTOCOL_VERSION, type ServerShellSettings } from '@risuai/protocol/shell-resource'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

function shellSettings(language = 'en'): ServerShellSettings {
  return {
    language,
    username: 'User',
    colorScheme: {
      bgcolor: '#111111',
      darkbg: '#000000',
      borderc: '#222222',
      selected: '#333333',
      draculared: '#ff0000',
      textcolor: '#ffffff',
      textcolor2: '#cccccc',
      darkBorderc: '#444444',
      darkbutton: '#555555',
      type: 'dark',
    },
    colorSchemeName: 'custom',
    textTheme: 'standard',
    customTextTheme: {
      FontColorStandard: '#ffffff',
      FontColorBold: '#ffffff',
      FontColorItalic: '#cccccc',
      FontColorItalicBold: '#cccccc',
      FontColorQuote1: '#00ffff',
      FontColorQuote2: '#ffaa00',
    },
    font: 'default',
    customFont: '',
    customCSS: '',
    animationSpeed: 0.4,
    reducedMotion: false,
    heightMode: 'percent',
    sideBarSize: 0,
    desktopSidebarColumns: 1,
    mobileSidebarColumns: 1,
    roundIcons: false,
    menuSideBar: false,
    showFolderName: true,
    showSavingIcon: true,
    hamburgerButtonBottom: false,
    botSettingAtStart: false,
    enableDevTools: false,
    doNotWarnExternalServers: false,
    keepSessionAlive: 'off',
  }
}

function characterShell(id: string, name: string): character {
  return {
    __serverCharacterShell: true,
    chaId: id,
    type: 'character',
    name,
    chats: [],
    chatPage: 0,
    chatFolders: [],
  } as unknown as character
}

function shellResource(revision: number, language = 'en') {
  return {
    protocolVersion: SERVER_SHELL_PROTOCOL_VERSION,
    revision,
    settings: shellSettings(language),
    characters: {
      version: 1 as const,
      revision,
      characters: [characterShell('char-a', 'Ada')],
      characterOrder: ['char-a'],
      currentChar: 0,
    },
  }
}

beforeEach(() => {
  withTestDatabaseWrite(resetServerResourceState)
  clearAppliedServerResourceRevision()
  languageSideEffects.change.mockClear()
})

describe('coherent shell hydration', () => {
  it('applies shell settings and summaries under the write guard and advances the applied revision', () => {
    expect(applyServerShellResource(shellResource(5, 'ko'))).toBe(true)

    expect(getResourceDatabase()).toMatchObject({
      language: 'ko',
      username: 'User',
      characterOrder: ['char-a'],
      currentChar: 0,
      characters: [{ chaId: 'char-a', name: 'Ada' }],
    })
    expect(settingsResourceState).toMatchObject({
      revision: 5,
      shellRevision: 5,
      fullRevision: null,
      status: 'ready',
    })
    expect(charactersResourceState).toMatchObject({
      revision: 5,
      listRevision: 5,
      orderRevision: 5,
      selectionRevision: 5,
      status: 'ready',
    })
    expect(languageSideEffects.change).toHaveBeenCalledWith('ko')
    expect(peekAppliedServerResourceRevision()).toBe(5)
    expect(getResourceDatabase().language).toBe('ko')
  })

  it('rejects a stale shell atomically when a newer character projection is resident', () => {
    expect(applyServerShellResource(shellResource(5, 'en'))).toBe(true)
    withTestDatabaseWrite(() =>
      applyCharactersResource({
        version: 1,
        revision: 7,
        characters: [characterShell('char-b', 'Bea')],
        characterOrder: ['char-b'],
        currentChar: 0,
      }),
    )

    expect(applyServerShellResource(shellResource(6, 'ko'))).toBe(false)
    expect(getResourceDatabase()).toMatchObject({
      language: 'en',
      characterOrder: ['char-b'],
      characters: [{ chaId: 'char-b' }],
    })
    expect(settingsResourceState.shellRevision).toBe(5)
    expect(peekAppliedServerResourceRevision()).toBe(5)
  })

  it('replaces observer-era detail with the authoritative promotion shell', () => {
    expect(applyServerShellResource(shellResource(5, 'en'))).toBe(true)
    expect(
      withTestDatabaseWrite(() =>
        applyCharacterResource({
          revision: 5,
          character: {
            chaId: 'char-a',
            type: 'character',
            name: 'Observer detail',
            desc: 'stale observer-only body',
            chats: [{ id: 'chat-a', name: 'Observer chat', message: [] }],
            chatPage: 0,
            chatFolders: [],
          } as character,
        }),
      ),
    ).toBe(true)
    expect(getResourceDatabase().characters[0]?.desc).toBe('stale observer-only body')

    expect(applyServerShellResource(shellResource(6, 'ko'))).toBe(true)

    expect(getResourceDatabase().characters[0]).toMatchObject({
      __serverCharacterShell: true,
      chaId: 'char-a',
      name: 'Ada',
      chats: [],
    })
    expect(getResourceDatabase().characters[0]?.desc).toBeUndefined()
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('fences settings-group responses older than the shell without claiming a full settings read', () => {
    expect(applyServerShellResource(shellResource(5))).toBe(true)

    expect(
      withTestDatabaseWrite(() =>
        applySettingsGroupResource({ revision: 4, group: 'display', settings: { theme: 'old' } }, ['theme']),
      ),
    ).toBe(false)
    expect(
      withTestDatabaseWrite(() =>
        applySettingsGroupResource({ revision: 5, group: 'display', settings: { theme: 'current' } }, ['theme']),
      ),
    ).toBe(true)
    expect(getResourceDatabase().theme).toBe('current')
    expect(settingsResourceState.fullRevision).toBeNull()
  })
})
