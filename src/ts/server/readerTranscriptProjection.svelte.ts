import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { captureClientSessionGeneration, clientSessionStore, getClientSessionSnapshot } from '../clientSession'
import type { character, Chat, Database, Message } from '../storage/database.svelte'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'
import { mergeChatMessageRange, type ChatMessageRangeMergeInput } from './chatMessageRangeMerge'
import { SERVER_UNLOADED_CHAT_MESSAGE_MARKER } from './chatMessagePlaceholders'
import { DISPLAY_PAINT_SETTING_KEYS } from '../gui/displaySettingsCache'

// Only display inputs belong here. In particular, no prompts, credentials,
// editor drafts, executable module definitions, or optimistic transcript bodies are copied.
const characterKeys = [
  'chaId',
  'chatIds',
  'type',
  'name',
  'displayName',
  'creatorNotes',
  'trashTime',
  'chatCount',
  'pinnedChats',
  'chatFolders',
  'backgroundHTML',
  'viewScreen',
  'inlayViewScreen',
  'image',
  'largePortrait',
  'firstMessage',
  'alternateGreetings',
  'additionalAssets',
  'emotionImages',
  'modules',
  'prebuiltAssetStyle',
  'hideChatIcon',
  SERVER_CHARACTER_SHELL_MARKER,
] as const
const chatKeys = [
  'id',
  'name',
  'fmIndex',
  'pinned',
  'folderId',
  'lastDate',
  'bindedPersona',
  'bilingualDisplay',
  'autoTranslate',
  'lastMemory',
  'bookmarks',
  'bookmarkNames',
  'modules',
] as const
const personaKeys = ['id', 'name', 'displayName', 'icon', 'largePortrait', 'modules'] as const
const chatGenerationDisplayKeys = ['personaId', 'promptPresetId', 'agentPresetId'] as const
const personaSettingKeys = ['selectedPersonaId', 'selectedPersona', 'username', 'userIcon'] as const

// Explicit passive display inputs, not the Display/Sidebar groups wholesale:
// those groups also contain executable UI and authoring preferences.
export const READER_NAVIGATION_SETTING_KEYS = [
  ...DISPLAY_PAINT_SETTING_KEYS,
  'language',
  'customCSS',
  'menuSideBar',
  'showFolderName',
  'desktopSidebarColumns',
  'mobileSidebarColumns',
  'hamburgerButtonBottom',
  'chatLoadInitialPages',
  'chatLoadAdditionalPages',
  'chatDisplayTailCount',
  'autoScrollToNewMessage',
  'alwaysScrollToNewMessage',
  'showMemoryLimit',
  'useChatCopy',
  'paragraphBreakBySentences',
  'paragraphBreakSentenceCount',
  'hideAllImages',
  'blockquoteStyling',
  'unformatQuotes',
  'customQuotes',
  'customQuotesData',
  'showFirstMessagePages',
  'useChatSticker',
  'showTranslationLoading',
  'translateBeforeHTMLFormatting',
  'legacyMediaFindings',
  'assetMaxDifference',
  'newImageHandlingBeta',
] as const satisfies readonly (keyof Database)[]
let navigationSettings = $state.raw<Partial<Database>>({})
let characterOrder = $state.raw<Database['characterOrder']>([])

export function getReaderNavigationSettings(): Partial<Database> {
  return navigationSettings
}

export function getReaderCharacterOrder(): Database['characterOrder'] {
  return characterOrder
}

/** Called only by accepted resource/receipt consumers before pending overlays. */
export function recordReaderNavigationSettings(
  source: object,
  keys: readonly string[] = READER_NAVIGATION_SETTING_KEYS,
): void {
  if (!READER_NAVIGATION_SETTING_KEYS.some((key) => keys.includes(key))) return
  const next = { ...navigationSettings } as Record<string, unknown>
  for (const key of READER_NAVIGATION_SETTING_KEYS) {
    if (!keys.includes(key)) continue
    if (Object.hasOwn(source, key)) next[key] = clone((source as Record<string, unknown>)[key])
    else delete next[key]
  }
  navigationSettings = next as Partial<Database>
}

/** Passive module metadata and activation inputs, with no mutable writer fallback. */
export function getReaderModuleDisplayDatabase(): Partial<Database> {
  return {
    modules: displayModules,
    promptPresets: displayPromptPresets,
    enabledModules: [],
    moduleIntergration: '',
    agentPresets: [],
    agentPresetDefaultId: null,
    ...moduleSettings,
  }
}

/** Accepted collections are copied before any pending writer projection is restored. */
export function recordReaderModuleCollection(name: string, source: unknown): void {
  if (name === 'modules') {
    displayModules = Array.isArray(source)
      ? (source.map((module) => pick(module, moduleDisplayKeys)) as unknown as Database['modules'])
      : []
  } else if (name === 'promptPresets') {
    displayPromptPresets = Array.isArray(source)
      ? (source.map((preset) => pick(preset, presetModuleKeys)) as Database['promptPresets'])
      : []
  } else return
  requiredModuleReads.delete(name)
}

export function recordReaderModuleSettings(source: object, keys: readonly string[] = READER_MODULE_SETTING_KEYS): void {
  if (!READER_MODULE_SETTING_KEYS.some((key) => keys.includes(key))) return
  const next = { ...moduleSettings } as Record<string, unknown>
  for (const key of READER_MODULE_SETTING_KEYS) {
    if (!keys.includes(key)) continue
    const value = (source as Record<string, unknown>)[key]
    if (!Object.hasOwn(source, key)) delete next[key]
    else if (key === 'agentPresets') {
      next[key] = Array.isArray(value) ? value.map((preset) => pick(preset, agentPresetModuleKeys)) : []
    } else next[key] = clone(value)
    requiredModuleReads.delete(key)
  }
  moduleSettings = next as Partial<Database>
}

/** Compact mutation acknowledgements cannot certify the resident optimistic fields. */
export function requireReaderModuleRefresh(keys: readonly string[]): void {
  for (const key of keys) requiredModuleReads.add(key)
}

export function isReaderModuleReadRequired(key: string): boolean {
  return requiredModuleReads.has(key)
}

/** Response PATCH fields certify only this attempted preset, never its live siblings. */
export function recordReaderPromptPresetModulePatch(presetId: string, patch: object): void {
  const certified = pick(
    patch,
    presetModuleKeys.filter((key) => key !== 'id'),
  )
  if (Object.keys(certified).length === 0) return
  if (displayPromptPresets.filter((preset) => preset.id === presetId).length !== 1) {
    requireReaderModuleRefresh(['promptPresets'])
    return
  }
  displayPromptPresets = displayPromptPresets.map((preset) =>
    preset.id === presetId ? { ...preset, ...certified } : preset,
  )
}

export function recordReaderAgentPresetModuleFields(
  presetId: string,
  fields: Record<string, { canonical: { present: boolean; value?: unknown } }>,
): void {
  const entries = Object.entries(fields).filter(([key]) => ['moduleIntergration', 'enabled'].includes(key))
  if (entries.length === 0) return
  const presets = moduleSettings.agentPresets ?? []
  if (presets.filter((preset) => preset.id === presetId).length !== 1) {
    requireReaderModuleRefresh(['agentPresets'])
    return
  }
  moduleSettings = {
    ...moduleSettings,
    agentPresets: presets.map((preset) => {
      if (preset.id !== presetId) return preset
      const next = { ...preset } as Record<string, unknown>
      for (const [key, field] of entries) {
        if (field.canonical.present) next[key] = clone(field.canonical.value)
        else delete next[key]
      }
      return next as unknown as Database['agentPresets'][number]
    }),
  }
}

export function recordReaderCharacterOrder(source: Database['characterOrder']): void {
  characterOrder = source.map((entry) =>
    typeof entry === 'string'
      ? entry
      : (pick(entry, [
          'id',
          'name',
          'data',
          'color',
          'img',
          'imgFile',
          'expanded',
          'askBeforeOpening',
        ]) as unknown as Database['characterOrder'][number]),
  )
}

let characters = $state.raw<character[]>([])
let personas = $state.raw<Database['personas']>([])
let personaSettings = $state.raw<Record<string, unknown>>({})
const requiredPersonaReads = new SvelteSet<string>()
const requiredModuleReads = new SvelteSet<string>()
const moduleDisplayKeys = ['id', 'name', 'namespace', 'assets', 'backgroundEmbedding', 'hideIcon'] as const
const presetModuleKeys = ['id', 'moduleIntergration'] as const
const agentPresetModuleKeys = [...presetModuleKeys, 'enabled'] as const
export const READER_MODULE_SETTING_KEYS = [
  'enabledModules',
  'moduleIntergration',
  'agentPresets',
  'agentPresetDefaultId',
] as const satisfies readonly (keyof Database)[]
let displayModules = $state.raw<Database['modules']>([])
let displayPromptPresets = $state.raw<Database['promptPresets']>([])
let moduleSettings = $state.raw<Partial<Database>>({})
const characterRevisions = new Map<string, number | null>()
const details = new SvelteMap<string, character>()
const chatIncarnations = new SvelteMap<string, { characterId: string; value: number }>()
let nextChatIncarnation = 0
let messageGeneration = $state(0)
const messages = new SvelteMap<
  string,
  {
    characterId: string
    messages: Message[]
    projectionEpoch: number
    generation: number
    sessionGeneration: number
  }
>()

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, clone(source[key])]))
}

function displayCharacter(value: character): character {
  return {
    ...pick(value, characterKeys),
    chatFolders: (value.chatFolders ?? []).map((folder) => pick(folder, ['id', 'name', 'color', 'folded'])),
    chats: (value.chats ?? []).map((chat) => ({
      ...pick(chat, chatKeys),
      // Presence changes persona fallback semantics, even without a bound id.
      ...(chat.generationSettings === undefined
        ? {}
        : { generationSettings: pick(chat.generationSettings, chatGenerationDisplayKeys) }),
      message: [],
    })),
  } as unknown as character
}

export function getReaderTranscriptCharacters(): character[] {
  return characters
}

function isShell(character: character): boolean {
  return (character as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] === true
}

function chatIds(character: character): string[] {
  return isShell(character)
    ? ((character as unknown as { chatIds?: string[] }).chatIds ?? [])
    : (character.chats ?? []).flatMap((chat) => (chat.id ? [chat.id] : []))
}

const displayCharacters = $derived(
  characters.map((character) => {
    const detail = details.get(character.chaId)
    if (!isShell(character) || !detail) return character
    const merged = { ...detail, ...character, chats: detail.chats }
    delete (merged as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER]
    return merged
  }),
)

/** A sparse shell is a refresh-in-progress, not evidence that certified details disappeared. */
export function getReaderTranscriptDisplayCharacters(): character[] {
  return displayCharacters
}

export function getReaderTranscriptPersona(): Pick<
  Database,
  'personas' | 'selectedPersonaId' | 'selectedPersona' | 'username' | 'userIcon'
> {
  return { personas, selectedPersonaId: null, selectedPersona: -1, username: 'User', userIcon: '', ...personaSettings }
}

export function recordReaderPersonaSettings(source: object, keys: readonly string[] = personaSettingKeys): void {
  if (!personaSettingKeys.some((key) => keys.includes(key))) return
  const next = { ...personaSettings }
  for (const key of personaSettingKeys) {
    if (!keys.includes(key)) continue
    if (Object.hasOwn(source, key)) next[key] = clone((source as Record<string, unknown>)[key])
    else delete next[key]
    requiredPersonaReads.delete(key)
  }
  personaSettings = next
}

export function recordReaderPersonas(source: unknown): void {
  personas = Array.isArray(source) ? (source.map((persona) => pick(persona, personaKeys)) as Database['personas']) : []
  requiredPersonaReads.delete('personas')
}

/** A PATCH receipt certifies these fields only; other optimistic row fields are not evidence. */
export function recordReaderPersonaPatch(personaId: string, patch: object): boolean {
  const certified = pick(
    patch,
    personaKeys.filter((key) => key !== 'id'),
  )
  if (Object.keys(certified).length === 0) return true
  if (personas.filter((persona) => persona.id === personaId).length !== 1) return false
  personas = personas.map((persona) => (persona.id === personaId ? { ...persona, ...certified } : persona))
  return true
}

/** Compact structure receipts have revision/write flags, but no certified reader values. */
export function requireReaderPersonaRefresh(input: { collection?: boolean; settings?: boolean }): void {
  if (input.collection) requiredPersonaReads.add('personas')
  if (input.settings) for (const key of personaSettingKeys) requiredPersonaReads.add(key)
}

export function isReaderPersonaReadRequired(key: string): boolean {
  return requiredPersonaReads.has(key)
}

const chatOwners = $derived.by(() => {
  const characterCounts = new Map<string, number>()
  for (const character of characters)
    characterCounts.set(character.chaId, (characterCounts.get(character.chaId) ?? 0) + 1)
  const owners = new Map<string, { characterId: string; chat: Chat } | undefined>()
  for (const character of characters) {
    for (const chatId of chatIds(character)) {
      const chat =
        (isShell(character) ? details.get(character.chaId)?.chats : character.chats)?.find(
          (chat) => chat.id === chatId,
        ) ?? ({ id: chatId, message: [] } as unknown as Chat)
      owners.set(
        chatId,
        owners.has(chatId) || characterCounts.get(character.chaId) !== 1
          ? undefined
          : { characterId: character.chaId, chat },
      )
    }
  }
  return owners
})

function uniqueChat(chatId: string): { characterId: string; chat: Chat } | undefined {
  return chatOwners.get(chatId)
}

/** Changes synchronously at authoritative membership boundaries, even before a Svelte flush. */
function reconcileChatIncarnations(): void {
  for (const [chatId, incarnation] of chatIncarnations) {
    if (uniqueChat(chatId)?.characterId !== incarnation.characterId) chatIncarnations.delete(chatId)
  }
  for (const [chatId, owner] of chatOwners) {
    if (owner && !chatIncarnations.has(chatId)) {
      chatIncarnations.set(chatId, { characterId: owner.characterId, value: ++nextChatIncarnation })
    }
  }
}

export function getReaderChatIncarnation(characterId: string, chatId: string): number | null {
  const incarnation = chatIncarnations.get(chatId)
  return incarnation?.characterId === characterId ? incarnation.value : null
}

function pruneMessages(): void {
  for (const [chatId, projection] of messages) {
    if (uniqueChat(chatId)?.characterId !== projection.characterId) messages.delete(chatId)
  }
}

/** Called with accepted server rows, before any resident-body or pending overlays. */
export function recordReaderCharacters(source: readonly character[], revision: number | null): void {
  const previous = new Map<string, character | undefined>()
  for (const character of characters) {
    previous.set(character.chaId, previous.has(character.chaId) ? undefined : character)
  }
  for (const [characterId, character] of previous) {
    if (character && !isShell(character)) details.set(characterId, character)
  }
  characters = source.map((character) => {
    const existing = previous.get(character.chaId)
    return (character as unknown as Record<string, unknown>)[SERVER_CHARACTER_SHELL_MARKER] &&
      existing &&
      characterRevisions.get(character.chaId) === revision
      ? existing
      : displayCharacter(character)
  })
  // Retire removed metadata as well as bodies. Reintroducing the same id must
  // never make a previously deleted conversation's details available again.
  const currentById = new Map<string, character | undefined>()
  for (const character of characters)
    currentById.set(character.chaId, currentById.has(character.chaId) ? undefined : character)
  for (const [characterId, detail] of details) {
    const current = currentById.get(characterId)
    if (!current) details.delete(characterId)
    else if (isShell(current)) {
      const membership = new Set(chatIds(current))
      details.set(characterId, { ...detail, chats: detail.chats.filter((chat) => chat.id && membership.has(chat.id)) })
    }
  }
  for (const [characterId, character] of currentById) {
    if (character && !isShell(character)) details.set(characterId, character)
  }
  characterRevisions.clear()
  for (const character of source) characterRevisions.set(character.chaId, revision)
  reconcileChatIncarnations()
  pruneMessages()
}

export function recordReaderCharacter(source: character, revision: number): void {
  if (characters.filter((character) => character.chaId === source.chaId).length !== 1) return
  const next = displayCharacter(source)
  characters = characters.map((character) => (character.chaId === source.chaId ? next : character))
  details.set(source.chaId, next)
  characterRevisions.set(source.chaId, revision)
  reconcileChatIncarnations()
  pruneMessages()
}

export function recordReaderCharacterPatch(characterId: string, patch: object): void {
  const certified = pick(patch, characterKeys)
  characters = characters.map((character) =>
    character.chaId === characterId ? ({ ...character, ...certified } as character) : character,
  )
  const detail = details.get(characterId)
  if (detail) details.set(characterId, { ...detail, ...certified })
}

export function recordReaderChatPatch(characterId: string, chatId: string, patch: object): void {
  const certified = pick(patch, chatKeys)
  const update = (character: character): character =>
    character.chaId === characterId
      ? {
          ...character,
          chats: character.chats.map((chat) => (chat.id === chatId ? ({ ...chat, ...certified } as Chat) : chat)),
        }
      : character
  characters = characters.map(update)
  const detail = details.get(characterId)
  if (detail) details.set(characterId, update(detail))
}

export function recordReaderChatPersona(characterId: string, chatId: string, settings: object): void {
  if (uniqueChat(chatId)?.characterId !== characterId) return
  const update = (character: character): character =>
    character.chaId === characterId
      ? {
          ...character,
          chats: character.chats.map((chat) =>
            chat.id === chatId
              ? ({ ...chat, generationSettings: pick(settings, chatGenerationDisplayKeys) } as Chat)
              : chat,
          ),
        }
      : character
  characters = characters.map(update)
  const detail = details.get(characterId)
  if (detail) details.set(characterId, update(detail))
}

/** Merge only certified rows; never use the mutable writer message graph as a prefix. */
export function recordReaderChatMessages(
  chatId: string,
  incoming: readonly Message[],
  projectionEpoch: number,
  range?: ChatMessageRangeMergeInput,
): void {
  const owner = uniqueChat(chatId)
  if (!owner) return
  const previous = messages.get(chatId)
  const resident = previous?.generation === messageGeneration ? previous.messages : []
  const copied = clone(incoming) as Message[]
  const merged = range
    ? mergeChatMessageRange(
        [...resident],
        copied,
        range,
        () =>
          ({
            role: 'char',
            data: '',
            isComment: true,
            disabled: true,
            [SERVER_UNLOADED_CHAT_MESSAGE_MARKER]: true,
          }) as Message,
      )?.messages
    : copied
  if (!merged) return
  messages.set(chatId, {
    characterId: owner.characterId,
    messages: merged,
    projectionEpoch,
    generation: messageGeneration,
    sessionGeneration: captureClientSessionGeneration(),
  })
}

export function getReaderChatMessages(chatId: string):
  | {
      messages: Message[]
      projectionEpoch: number
      current: boolean
      incarnation: number
    }
  | undefined {
  const owner = uniqueChat(chatId)
  if (!owner) return undefined
  const incarnation = getReaderChatIncarnation(owner.characterId, chatId)
  if (incarnation === null) return undefined
  const projection = messages.get(chatId)
  return projection
    ? {
        ...projection,
        incarnation,
        current:
          projection.generation === messageGeneration &&
          projection.sessionGeneration === captureClientSessionGeneration(),
      }
    : {
        messages: owner.chat.message,
        incarnation,
        projectionEpoch: -1,
        current: false,
      }
}

/** Keep the last usable view through same-lineage refresh, but merge new ranges from an empty baseline. */
export function resetReaderChatMessages(): void {
  messageGeneration += 1
  const session = getClientSessionSnapshot()
  if (!session.managed || !session.authenticated) messages.clear()
  reconcileChatIncarnations()
  pruneMessages()
}

export function clearReaderTranscriptProjection(): void {
  characters = []
  personas = []
  personaSettings = {}
  navigationSettings = {}
  characterOrder = []
  requiredPersonaReads.clear()
  requiredModuleReads.clear()
  displayModules = []
  displayPromptPresets = []
  moduleSettings = {}
  characterRevisions.clear()
  details.clear()
  chatIncarnations.clear()
  messages.clear()
  messageGeneration += 1
}

let lineage: string | null = null
clientSessionStore.subscribe((session) => {
  if (!session.authenticated || session.databaseLineage !== lineage) clearReaderTranscriptProjection()
  lineage = session.databaseLineage
})
