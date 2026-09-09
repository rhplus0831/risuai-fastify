import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { ServerCharactersSummaryPayloadSchema, isServerCharactersSummaryPayload } from './characterSummaryResource.js'

export const SERVER_SHELL_PROTOCOL_VERSION = 1 as const

/**
 * Exact settings needed to paint and interact with the root shell before any
 * route-owned settings group is hydrated.
 */
export const SERVER_SHELL_SETTINGS_KEYS = [
  'language',
  'username',
  'colorScheme',
  'colorSchemeName',
  'textTheme',
  'customTextTheme',
  'font',
  'customFont',
  'customCSS',
  'animationSpeed',
  'reducedMotion',
  'heightMode',
  'sideBarSize',
  'desktopSidebarColumns',
  'mobileSidebarColumns',
  'roundIcons',
  'menuSideBar',
  'showFolderName',
  'showSavingIcon',
  'hamburgerButtonBottom',
  'botSettingAtStart',
  'enableDevTools',
  'doNotWarnExternalServers',
  'keepSessionAlive',
] as const

export type ServerShellSettingName = (typeof SERVER_SHELL_SETTINGS_KEYS)[number]

export const ServerShellColorSchemeSchema = Type.Object({
  bgcolor: Type.String(),
  darkbg: Type.String(),
  borderc: Type.String(),
  selected: Type.String(),
  draculared: Type.String(),
  textcolor: Type.String(),
  textcolor2: Type.String(),
  darkBorderc: Type.String(),
  darkbutton: Type.String(),
  type: Type.Union([Type.Literal('light'), Type.Literal('dark')]),
})

export const ServerShellTextThemeSchema = Type.Object({
  FontColorStandard: Type.String(),
  FontColorBold: Type.String(),
  FontColorItalic: Type.String(),
  FontColorItalicBold: Type.String(),
  FontColorQuote1: Type.String(),
  FontColorQuote2: Type.String(),
})

export const ServerShellSettingsSchema = Type.Object(
  {
    language: Type.String(),
    username: Type.String(),
    colorScheme: ServerShellColorSchemeSchema,
    colorSchemeName: Type.String(),
    textTheme: Type.String(),
    customTextTheme: ServerShellTextThemeSchema,
    font: Type.String(),
    customFont: Type.String(),
    customCSS: Type.String(),
    animationSpeed: Type.Number(),
    reducedMotion: Type.Boolean(),
    heightMode: Type.String(),
    sideBarSize: Type.Number(),
    desktopSidebarColumns: Type.Integer({ minimum: 1, maximum: 4 }),
    mobileSidebarColumns: Type.Integer({ minimum: 1, maximum: 2 }),
    roundIcons: Type.Boolean(),
    menuSideBar: Type.Boolean(),
    showFolderName: Type.Boolean(),
    showSavingIcon: Type.Boolean(),
    hamburgerButtonBottom: Type.Boolean(),
    botSettingAtStart: Type.Boolean(),
    enableDevTools: Type.Boolean(),
    doNotWarnExternalServers: Type.Boolean(),
    keepSessionAlive: Type.Union([Type.Literal('off'), Type.Literal('sound')]),
  },
  { additionalProperties: false },
)

export const SERVER_SHELL_PAYLOAD_KEYS = ['protocolVersion', 'revision', 'settings', 'characters'] as const

export const ServerShellPayloadSchema = Type.Object(
  {
    protocolVersion: Type.Literal(SERVER_SHELL_PROTOCOL_VERSION),
    revision: Type.Integer({ minimum: 0 }),
    settings: ServerShellSettingsSchema,
    characters: ServerCharactersSummaryPayloadSchema,
  },
  { additionalProperties: false },
)

export type ServerShellSettings = Static<typeof ServerShellSettingsSchema>
export type ServerShellPayload = Static<typeof ServerShellPayloadSchema>

export function isServerShellPayload(value: unknown): value is ServerShellPayload {
  if (!Value.Check(ServerShellPayloadSchema, value)) return false
  if (!Number.isSafeInteger(value.revision)) return false
  if (!isServerCharactersSummaryPayload(value.characters)) return false
  return value.characters.revision === value.revision
}

export function isServerShellSettings(value: unknown): value is ServerShellSettings {
  return Value.Check(ServerShellSettingsSchema, value)
}
