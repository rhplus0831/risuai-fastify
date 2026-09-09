import { describe, expect, it } from 'vitest'
import {
  SERVER_SHELL_PAYLOAD_KEYS,
  SERVER_SHELL_PROTOCOL_VERSION,
  SERVER_SHELL_SETTINGS_KEYS,
  isServerShellPayload,
  type ServerShellSettings,
} from '@risuai/protocol/shell-resource'
import {
  SERVER_CHARACTER_SHELL_MARKER,
  SERVER_CHARACTER_SUMMARY_VERSION,
} from '@risuai/protocol/character-summary-resource'

function shellSettings(): ServerShellSettings {
  return {
    language: 'en',
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

function shellPayload() {
  return {
    protocolVersion: SERVER_SHELL_PROTOCOL_VERSION,
    revision: 4,
    settings: shellSettings(),
    characters: {
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 4,
      characters: [
        {
          [SERVER_CHARACTER_SHELL_MARKER]: true,
          chaId: 'char-a',
          type: 'character',
          name: 'Ada',
          displayName: 'Ada Lovelace',
          image: 'asset://ada',
          creatorNotes: '',
          trashTime: null,
          creation_date: 1,
          modification_date: 2,
          lastInteraction: 3,
          chatCount: 0,
          activeChatId: null,
          chatIds: [],
          pinnedChats: [],
        },
      ],
      characterOrder: ['char-a'],
      currentChar: 0,
    },
  }
}

describe('server shell protocol', () => {
  it('accepts the exact versioned coherent shell shape', () => {
    const payload = shellPayload()
    expect(Object.keys(payload)).toEqual(SERVER_SHELL_PAYLOAD_KEYS)
    expect(Object.keys(payload.settings)).toEqual(SERVER_SHELL_SETTINGS_KEYS)
    expect(isServerShellPayload(payload)).toBe(true)
  })

  it('rejects unknown, missing, and malformed shell settings', () => {
    const extra = shellPayload()
    ;(extra.settings as Record<string, unknown>).openAIKey = 'secret'
    expect(isServerShellPayload(extra)).toBe(false)

    const missing = shellPayload()
    delete (missing.settings as Partial<Record<string, unknown>>).language
    expect(isServerShellPayload(missing)).toBe(false)

    const malformed = shellPayload()
    malformed.settings.sideBarSize = Number.NaN
    expect(isServerShellPayload(malformed)).toBe(false)

    const malformedColumns = shellPayload()
    malformedColumns.settings.desktopSidebarColumns = 5
    expect(isServerShellPayload(malformedColumns)).toBe(false)
  })

  it('rejects unsupported versions and incoherent nested revisions', () => {
    const unsupported = shellPayload()
    ;(unsupported as { protocolVersion: number }).protocolVersion = SERVER_SHELL_PROTOCOL_VERSION + 1
    expect(isServerShellPayload(unsupported)).toBe(false)

    const mismatched = shellPayload()
    mismatched.characters.revision += 1
    expect(isServerShellPayload(mismatched)).toBe(false)
  })

  it('rejects route detail smuggled into character summaries', () => {
    const payload = shellPayload()
    ;(payload.characters.characters[0] as Record<string, unknown>).chats = []
    expect(isServerShellPayload(payload)).toBe(false)
  })
})
