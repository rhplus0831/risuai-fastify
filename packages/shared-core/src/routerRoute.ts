/** Framework-neutral route contract shared by the browser and integration smoke. */
export type AppRoute =
  | { kind: 'home'; path: string }
  | { kind: 'settings'; path: string; section: string; index: number; personaId?: string }
  | { kind: 'playground'; path: string; tool: string; index: number }
  | { kind: 'inlay'; path: string }
  | { kind: 'grid'; path: string }
  | { kind: 'character'; path: string; chaId: string; chatId?: string }
  | { kind: 'not-found'; path: string }

export interface StateRouteInput {
  currentRouteKind: AppRoute['kind']
  settingsOpen: boolean
  settingsMenuIndex: number
  selectedCharID: number
  playgroundStore: number
  personaId?: string
  characterId?: string
  chatId?: string
}

const DEFAULT_SETTINGS_INDEX = 17
const DEFAULT_PLAYGROUND_INDEX = 1
const PLAYGROUND_CHARACTER_ID = '§playground'

const settingIndexBySlug = new Map<string, number>([
  ['backup', 0],
  ['backup-restore', 0],
  ['request-history', 21],
  ['requesthistory', 21],
  ['user', 0],
  ['chat-bot', 1],
  ['chatbot', 1],
  ['bot', 1],
  ['bot-preset', 1],
  ['botpreset', 1],
  ['preset', 1],
  ['presets', 1],
  ['model', 17],
  ['model-settings', 17],
  ['models', 17],
  ['memory', 2],
  ['other-bots', 2],
  ['otherbots', 2],
  ['bardwiki', 23],
  ['display', 3],
  ['plugin', 4],
  ['plugins', 4],
  ['advanced', 6],
  ['advanced-settings', 6],
  ['community', 7],
  ['communities', 7],
  ['global-lorebook', 8],
  ['lorebook', 8],
  ['lore', 8],
  ['global-regex', 9],
  ['regex', 9],
  ['language', 10],
  ['accessibility', 11],
  ['interaction', 24],
  ['persona', 12],
  ['prompt', 13],
  ['prompt-template', 13],
  ['agent-preset', 19],
  ['agent-presets', 19],
  ['input-hooks', 20],
  ['prompt-settings', 18],
  ['prompt-preset', 18],
  ['prompt-presets', 18],
  ['prompts', 18],
  ['modules', 14],
  ['module', 14],
  ['hotkey', 15],
  ['hotkeys', 15],
  ['source-code', 22],
  ['sourcecode', 22],
  ['supporter', 77],
  ['thanks', 77],
])

const settingSlugByIndex = new Map<number, string>([
  [0, 'backup'],
  [1, 'bot-preset'],
  [2, 'memory'],
  [3, 'display'],
  [4, 'plugins'],
  [6, 'advanced'],
  [7, 'communities'],
  [8, 'global-lorebook'],
  [9, 'global-regex'],
  [10, 'language'],
  [11, 'accessibility'],
  [12, 'persona'],
  [13, 'prompt'],
  [14, 'modules'],
  [15, 'hotkeys'],
  [17, 'model'],
  [18, 'prompt-settings'],
  [19, 'agent-presets'],
  [20, 'input-hooks'],
  [21, 'request-history'],
  [22, 'source-code'],
  [23, 'bardwiki'],
  [24, 'interaction'],
  [77, 'supporter'],
])

const playgroundIndexBySlug = new Map<string, number>([
  ['menu', 1],
  ['chat', 2],
  ['embedding', 3],
  ['tokenizer', 4],
  ['syntax', 5],
  ['jinja', 6],
  ['image-gen', 7],
  ['image-generation', 7],
  ['parser', 8],
  ['subtitle', 9],
  ['subtitles', 9],
  ['image-trans', 10],
  ['image-translation', 10],
  ['translation', 11],
  ['translator', 11],
  ['mcp', 12],
  ['cbs', 13],
  ['docs', 13],
  ['inlay', 14],
  ['inlays', 14],
  ['tool-conversion', 101],
  ['tools', 101],
])

const playgroundSlugByIndex = new Map<number, string>([
  [1, ''],
  [2, 'chat'],
  [3, 'embedding'],
  [4, 'tokenizer'],
  [5, 'syntax'],
  [6, 'jinja'],
  [7, 'image-gen'],
  [8, 'parser'],
  [9, 'subtitles'],
  [10, 'image-trans'],
  [11, 'translation'],
  [12, 'mcp'],
  [13, 'cbs'],
  [14, 'inlays'],
  [101, 'tools'],
])

export function parseRoute(pathname: string): AppRoute {
  const path = normalizePath(pathname)
  const parts = splitPath(path)

  if (parts.length === 0) return { kind: 'home', path }

  if (parts[0] === 'settings') {
    const section = normalizeSlug(parts[1] ?? '')
    if (!section) return { kind: 'settings', path, section: '', index: -1 }
    if (section === 'context-agent' || section === 'contextagent') return { kind: 'not-found', path }

    const index = settingIndexBySlug.get(section) ?? numericSettingIndex(section)
    return {
      kind: 'settings',
      path,
      section,
      index: index ?? DEFAULT_SETTINGS_INDEX,
      ...(section === 'persona' && parts[2] ? { personaId: decodeSegment(parts[2]) } : {}),
    }
  }

  if (parts[0] === 'playground') {
    const tool = normalizeSlug(parts[1] ?? '')
    const index = playgroundIndexBySlug.get(tool) ?? numericPlaygroundIndex(tool)
    return {
      kind: 'playground',
      path,
      tool: tool || playgroundSlugByIndex.get(DEFAULT_PLAYGROUND_INDEX) || '',
      index: index ?? DEFAULT_PLAYGROUND_INDEX,
    }
  }

  if (parts[0] === 'inlay' || parts[0] === 'inlays') return { kind: 'inlay', path }
  if (parts[0] === 'grid' || (parts[0] === 'characters' && parts.length === 1)) return { kind: 'grid', path }

  if (parts[0] === 'character' && parts[1]) {
    return {
      kind: 'character',
      path,
      chaId: decodeSegment(parts[1]),
      chatId: parts[2] ? decodeSegment(parts[2]) : undefined,
    }
  }

  if (parts[0] === 'characters' && parts[1]) {
    return {
      kind: 'character',
      path,
      chaId: decodeSegment(parts[1]),
      chatId: parts[2] === 'chats' && parts[3] ? decodeSegment(parts[3]) : undefined,
    }
  }

  return { kind: 'not-found', path }
}

export function characterRoutePath(characterId: string, chatId?: string): string {
  const encodedCharacterId = encodeURIComponent(characterId)
  return chatId ? `/character/${encodedCharacterId}/${encodeURIComponent(chatId)}` : `/character/${encodedCharacterId}`
}

export function personaSettingsRoutePath(personaId?: string): string {
  return typeof personaId === 'string' && personaId.trim()
    ? `/settings/persona/${encodeURIComponent(personaId)}`
    : '/settings/persona'
}

export function routePathFromState(input: StateRouteInput): string {
  if (input.settingsOpen) {
    if (input.settingsMenuIndex < 0) return '/settings'
    if (input.settingsMenuIndex === 12) return personaSettingsRoutePath(input.personaId)
    return `/settings/${settingSlugByIndex.get(input.settingsMenuIndex) ?? 'model'}`
  }

  if (input.selectedCharID >= 0 && input.characterId) {
    if (input.characterId === PLAYGROUND_CHARACTER_ID) return '/playground/chat'
    return characterRoutePath(input.characterId, input.chatId)
  }

  if (input.playgroundStore > 0) {
    if (input.playgroundStore === 14) return '/inlay'
    const slug = playgroundSlugByIndex.get(input.playgroundStore)
    return slug ? `/playground/${slug}` : '/playground'
  }

  if (input.currentRouteKind === 'grid') return '/grid'
  return '/'
}

export function normalizePath(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/u)[0] || '/'
  const withLeadingSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, '') : '/'
}

export function routeKey(route: AppRoute): string {
  switch (route.kind) {
    case 'settings':
      return `${route.kind}:${route.index}:${route.personaId ?? ''}`
    case 'playground':
      return `${route.kind}:${route.index}`
    case 'character':
      return `${route.kind}:${route.chaId}:${route.chatId ?? ''}`
    default:
      return route.kind
  }
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function normalizeSlug(segment: string): string {
  return decodeSegment(segment).trim().toLowerCase().replaceAll('_', '-')
}

function numericSettingIndex(slug: string): number | undefined {
  const value = Number(slug)
  return Number.isInteger(value) && settingSlugByIndex.has(value) ? value : undefined
}

function numericPlaygroundIndex(slug: string): number | undefined {
  const value = Number(slug)
  return Number.isInteger(value) && playgroundSlugByIndex.has(value) ? value : undefined
}
