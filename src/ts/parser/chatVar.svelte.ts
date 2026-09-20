import { resolveUniquePromptPreset } from '@risuai/shared-core/effective-prompt-template'
import { projectSidebarTogglesToGlobalChatVariables } from '@risuai/shared-core/chat-generation-settings'
import { parseKeyValue } from '../util'
import { setChatVarBackend } from './chatVarBackend'
import { setParserStateBackend } from './parserStateBackend'
import { dispatchPatchChatScriptstateScoped, type ChatScriptstateSnapshot } from '../chatCommands'
import {
  applyChatScriptstateOwnerValue,
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  getChatScriptstateOwnerSnapshot,
  settingsResourceState,
  type ChatScriptstateOwnerSnapshot,
} from '../server/resourceState.svelte'
import type { Database } from '../storage/database.svelte'

function currentChatScriptstateOwner(): ChatScriptstateOwnerSnapshot | undefined {
  const character = charactersResourceState.characters[charactersResourceState.currentChar]
  if (!character?.chaId) return undefined
  const chat = character.chats?.[character.chatPage]
  if (!chat?.id) return undefined
  return getChatScriptstateOwnerSnapshot(character.chaId, chat.id)
}

function currentTemplateDefaultVariables(): string {
  const presetStatus = collectionsResourceState.statuses.promptPresets
  const selectionStatus = settingsResourceState.standaloneStatuses.promptPresetsId
  const promptOwnersReady = presetStatus === 'ready' && selectionStatus === 'ready'
  if (!promptOwnersReady) return ''

  const presets = collectionsResourceState.values.promptPresets
  const selectedIndex = (settingsResourceState.value as Record<string, unknown>).promptPresetsId
  if (!Array.isArray(presets) || !Number.isInteger(selectedIndex) || (selectedIndex as number) < 0) return ''
  const candidate = presets[selectedIndex as number]
  if (!candidate || typeof candidate.id !== 'string') return ''
  const owner = resolveUniquePromptPreset(presets, candidate.id)
  return owner === candidate && typeof owner.templateDefaultVariables === 'string' ? owner.templateDefaultVariables : ''
}

export function getChatVar(key: string): string {
  if (charactersResourceState.status !== 'ready') return 'null'
  const owner = currentChatScriptstateOwner()
  const char = owner ? getCharacterResourceOwner(owner.characterId) : undefined
  if (!char) return 'null'
  const state = owner?.scriptstate?.['$' + key]
  if (state === undefined || state === null) {
    const defaultVariables = parseKeyValue(char.defaultVariables).concat(
      parseKeyValue(currentTemplateDefaultVariables()),
    )
    const findResult = defaultVariables.find((f) => {
      return f[0] === key
    })
    if (findResult) {
      return findResult[1]
    }
    return 'null'
  }
  return state.toString()
}

export function setChatVar(key: string, value: string): boolean {
  if (charactersResourceState.status !== 'ready') return false
  const owner = currentChatScriptstateOwner()
  const stateKey = '$' + key
  if (!owner || owner.scriptstate?.[stateKey] === value) return false
  if (!applyChatScriptstateOwnerValue(owner.characterId, owner.chatId, stateKey, value)) return false
  const previous: ChatScriptstateSnapshot = {
    characterId: owner.characterId,
    chatId: owner.chatId,
    selectedCharID: charactersResourceState.currentChar,
    scriptstate: owner.scriptstate,
  }
  dispatchPatchChatScriptstateScoped(owner.chatId, { [stateKey]: value }, [], previous)
  return true
}

export function getGlobalChatVar(key: string): string {
  const owner = charactersResourceState.status === 'ready' ? currentChatScriptstateOwner() : undefined
  const character = owner ? getCharacterResourceOwner(owner.characterId) : undefined
  const chat = character?.chats.find((candidate) => candidate.id === owner?.chatId)
  const globalChatVariables =
    settingsResourceState.groupStatuses.sidebar === 'error'
      ? undefined
      : (settingsResourceState.value as Record<string, unknown>).globalChatVariables
  const value = projectSidebarTogglesToGlobalChatVariables(
    globalChatVariables,
    chat?.generationSettings?.sidebarToggles,
  )[key]
  return typeof value === 'string' ? value : 'null'
}

setChatVarBackend({ getChatVar, setChatVar, getGlobalChatVar })
setParserStateBackend({
  // The parser only consults `characters` for its optional accurate-tokenizer
  // fallback, so keep this adapter narrow instead of exposing the aggregate
  // resource database.
  getDefaultDatabase: () =>
    charactersResourceState.status === 'ready'
      ? ({ characters: charactersResourceState.characters } as Database)
      : null,
  getDefaultSelectedCharID: () =>
    charactersResourceState.status === 'ready' ? charactersResourceState.currentChar : -1,
})
