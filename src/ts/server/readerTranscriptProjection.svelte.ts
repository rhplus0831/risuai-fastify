import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { captureClientSessionGeneration, clientSessionStore, getClientSessionSnapshot } from '../clientSession'
import type { character, Chat, Database, Message } from '../storage/database.svelte'
import { SERVER_CHARACTER_SHELL_MARKER } from '@risuai/protocol/character-summary-resource'
import { mergeChatMessageRange, type ChatMessageRangeMergeInput } from './chatMessageRangeMerge'
import { SERVER_UNLOADED_CHAT_MESSAGE_MARKER } from './chatMessagePlaceholders'

// Only display inputs belong here. In particular, no prompts, credentials,
// editor drafts, module definitions, or optimistic transcript bodies are copied.
const characterKeys = [
  'chaId',
  'chatIds',
  'type',
  'name',
  'displayName',
  'image',
  'largePortrait',
  'firstMessage',
  'alternateGreetings',
  'additionalAssets',
  'emotionImages',
  SERVER_CHARACTER_SHELL_MARKER,
] as const
const chatKeys = [
  'id',
  'name',
  'fmIndex',
  'bindedPersona',
  'bilingualDisplay',
  'autoTranslate',
  'lastMemory',
  'bookmarks',
  'bookmarkNames',
] as const
const personaKeys = ['id', 'name', 'displayName', 'icon', 'largePortrait'] as const
const personaSettingKeys = ['selectedPersonaId', 'selectedPersona', 'username', 'userIcon'] as const

let characters = $state.raw<character[]>([])
let personas = $state.raw<Database['personas']>([])
let personaSettings = $state.raw<Record<string, unknown>>({})
const requiredPersonaReads = new SvelteSet<string>()
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
    chats: (value.chats ?? []).map((chat) => ({
      ...pick(chat, chatKeys),
      // Presence changes persona fallback semantics, even without a bound id.
      ...(chat.generationSettings === undefined
        ? {}
        : { generationSettings: pick(chat.generationSettings, ['personaId']) }),
      message: [],
    })),
  } as character
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
  characters = characters.map((character) =>
    character.chaId === characterId ? ({ ...character, ...pick(patch, characterKeys) } as character) : character,
  )
}

export function recordReaderChatPatch(characterId: string, chatId: string, patch: object): void {
  characters = characters.map((character) =>
    character.chaId === characterId
      ? {
          ...character,
          chats: character.chats.map((chat) =>
            chat.id === chatId ? ({ ...chat, ...pick(patch, chatKeys) } as Chat) : chat,
          ),
        }
      : character,
  )
}

export function recordReaderChatPersona(characterId: string, chatId: string, settings: object): void {
  if (uniqueChat(chatId)?.characterId !== characterId) return
  characters = characters.map((character) =>
    character.chaId === characterId
      ? {
          ...character,
          chats: character.chats.map((chat) =>
            chat.id === chatId ? ({ ...chat, generationSettings: pick(settings, ['personaId']) } as Chat) : chat,
          ),
        }
      : character,
  )
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
  requiredPersonaReads.clear()
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
