import { get } from 'svelte/store'
import type { character, Chat } from '../storage/database.svelte'
import { selectedCharID } from '../stores.svelte'
import { alertInput, alertMd, alertNormal, alertSelect } from '../alert'
import { sayTTS } from './tts'
import { risuChatParser } from '../parser/parser.svelte'
import { loadLoreBookV3Prompt } from './lorebook.svelte'
import { clearManualTriggerAbortController, createManualTriggerAbortController, runTrigger } from './triggers'
import {
  captureActiveChatTarget,
  clearCurrentChatMessagesBeforeSend,
  appendCurrentChatUserMessageForSend,
  mutateChatWithScopedCommand,
  dispatchPatchChatScriptstateScoped,
  isActiveChatTargetFresh,
  type ChatScriptstateSnapshot,
} from '../chatCommands'
import { coordinateAcceptedChatSend } from './acceptedSendCoordinator.svelte'
import { canUseGenerationOperationProtocol } from '../server/generationOperations'
import { selectCharacterOwner } from '../characterState'
import {
  applyChatScriptstateOwnerValue,
  charactersResourceState,
  getCharacterResourceOwner,
  getChatMetadataOwnerState,
  getChatScriptstateOwnerSnapshot,
} from '../server/resourceState.svelte'
import { getChatMessageOwnerState } from '../server/chatMessageHydration.svelte'
import { safeStructuredClone } from '../polyfill'
import { captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'

interface CommandChatOwner {
  selectedIndex: number
  chatPage: number
  character: character
  chat: Chat
  chatId: string
}

export async function processMultiCommand(command: string, clientGeneration = captureClientSessionGeneration()) {
  if (!isClientWriteOperationCurrent(clientGeneration)) return false
  let pipe = ''
  const splited: string[] = []
  let lastIndex = 0
  let quoteDepth = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '"') {
      quoteDepth = !quoteDepth
    } else if (char === '|' && quoteDepth === false && command[i - 1] !== '|' && command[i + 1] !== '|') {
      splited.push(command.slice(lastIndex, i))
      lastIndex = i + 1
    }
  }
  splited.push(command.slice(lastIndex))
  for (let i = 0; i < splited.length; i++) {
    const result = await processCommand(splited[i].trim(), pipe, clientGeneration)
    if (!isClientWriteOperationCurrent(clientGeneration)) return false
    if (result === false) {
      return false
    } else {
      pipe = result
    }
  }
  return pipe
}

async function processCommand(command: string, pipe: string, clientGeneration: number): Promise<false | string> {
  const isCurrent = () => isClientWriteOperationCurrent(clientGeneration)
  if (!isCurrent()) return false
  const owner = selectedCommandChatOwner()
  const currentChar = owner?.character
  let { commandName, arg, namedArg } = commandParser(command, pipe)

  if (!arg) {
    arg = pipe
  }

  arg = risuChatParser(arg, {
    chara: currentChar?.type === 'character' ? currentChar : null,
  })

  const namedArgKeys = Object.keys(namedArg)
  for (const key of namedArgKeys) {
    namedArg[key] = risuChatParser(namedArg[key], {
      chara: currentChar?.type === 'character' ? currentChar : null,
    })
  }
  if (!isCurrent()) return false

  switch (commandName) {
    //STScript compatibility commands
    case 'input': {
      pipe = await alertInput(arg)
      if (!isCurrent()) return false
      return pipe
    }
    case 'echo':
    case 'popup': {
      alertNormal(arg)
      return pipe
    }
    case 'pass': {
      pipe = arg
      return pipe
    }
    case 'buttons': {
      if (namedArg.labels) {
        try {
          const JSONLabels = JSON.parse(namedArg.labels)
          if (Array.isArray(JSONLabels)) {
            const selection = await alertSelect(JSONLabels)
            if (!isCurrent()) return false
            if (selection !== null) pipe = selection
          }
        } catch (error) {}
      }
      return pipe
    }
    case 'setinput': {
      // The STScript `setinput` compatibility command is unsupported.
      return false
    }
    case 'speak': {
      if (currentChar?.type === 'character') {
        await sayTTS(currentChar, arg)
        if (!isCurrent()) return false
      }
      return pipe
    }
    case 'send': {
      mutateCurrentChatMessages(owner, (chat) => {
        chat.message.push({
          role: 'user',
          data: arg,
        })
      })
      return pipe
    }
    case 'sendas': {
      // `/sendas` uses the active character; it does not accept a speaker name.
      mutateCurrentChatMessages(owner, (chat) => {
        chat.message.push({
          role: 'char',
          data: arg,
        })
      })
      return pipe
    }
    case 'comment': {
      //works differently, but its close enough
      const addition = `<Comment>\n${arg}\n</Comment>`
      mutateCurrentChatMessages(owner, (chat) => {
        chat.message[chat.message.length - 1].data += addition
      })
      return pipe
    }
    case 'cut': {
      mutateCurrentChatMessages(owner, (chat) => {
        const range = /^(\d+)\s*-\s*(\d+)$/.exec(arg.trim())
        if (range) {
          const start = Number.parseInt(range[1], 10)
          const end = Number.parseInt(range[2], 10)
          if (start <= end) {
            chat.message.splice(start, end - start + 1)
          }
        } else if (/^\d+$/.test(arg.trim())) {
          chat.message.splice(Number.parseInt(arg.trim(), 10), 1)
        } else {
          // Risu extension: accept a stable message id as well as STScript's
          // zero-based index/range syntax. UUID ids contain hyphens, so only a
          // fully numeric `start-end` string is treated as a range.
          const id = arg
          chat.message = chat.message.filter((e) => e.chatId !== id)
        }
      })
      return pipe
    }
    case 'del': {
      const size = /^\d+$/.test(arg.trim()) ? Number.parseInt(arg.trim(), 10) : Number.NaN
      if (Number.isInteger(size) && size > 0) {
        mutateCurrentChatMessages(owner, (chat) => {
          chat.message = chat.message.slice(0, Math.max(0, chat.message.length - size))
        })
      }
      return pipe
    }
    case 'len': {
      try {
        const parsed = JSON.parse(arg)
        if (Array.isArray(parsed)) {
          pipe = parsed.length.toString()
        }
      } catch (error) {}
      return pipe
    }
    case 'multisend': {
      const splited = arg.split('|||')
      let clearMode = false
      if (splited[0] && splited[0].trim() === 'clear') {
        clearMode = true
        splited.shift()
      }
      const activeTarget = captureActiveChatTarget()
      if (!activeTarget) {
        return ''
      }
      for (const e of splited) {
        if (!isCurrent()) return false
        if (!isActiveChatTargetFresh(activeTarget)) {
          break
        }
        if (clearMode && !(await clearCurrentChatMessagesBeforeSend(activeTarget))) {
          break
        }
        if (!isCurrent()) return false
        const outcome = canUseGenerationOperationProtocol()
          ? await coordinateAcceptedChatSend({ target: activeTarget, message: e, clientGeneration })
          : await (async () => {
              const appended = await appendCurrentChatUserMessageForSend(e, { expectedTarget: activeTarget })
              if (appended.status === 'error') return { status: 'append_failed' as const }
              // The coordinator still observes exact append settlement after
              // writer loss, using this pipeline's original generation.
              return coordinateAcceptedChatSend({ target: activeTarget, append: appended, clientGeneration })
            })()
        if (!isCurrent()) return false
        if (outcome.status !== 'generated') break
        if (!isActiveChatTargetFresh(activeTarget)) {
          break
        }
      }
      return ''
    }
    case 'setvar': {
      const stateKey = '$' + namedArg['key']
      if (owner) {
        const previous = commandScriptstateSnapshot(owner)
        if (previous && applyChatScriptstateOwnerValue(owner.character.chaId, owner.chatId, stateKey, arg)) {
          dispatchPatchChatScriptstateScoped(owner.chatId, { [stateKey]: arg }, [], previous)
        }
      }
      return ''
    }
    case 'addvar': {
      const stateKey = '$' + namedArg['key']
      if (owner) {
        const previous = commandScriptstateSnapshot(owner)
        if (!previous) return ''
        const newValue = (Number(previous.scriptstate?.[stateKey]) + Number(arg)).toString()
        if (applyChatScriptstateOwnerValue(owner.character.chaId, owner.chatId, stateKey, newValue)) {
          dispatchPatchChatScriptstateScoped(owner.chatId, { [stateKey]: newValue }, [], previous)
        }
      }
      return ''
    }
    case 'getvar': {
      const scriptstate = owner
        ? getChatScriptstateOwnerSnapshot(owner.character.chaId, owner.chatId)?.scriptstate
        : undefined
      pipe = scriptstate?.['$' + namedArg['key']]?.toString() ?? 'null'
      return pipe
    }
    case 'test_lorebook': {
      const p = await loadLoreBookV3Prompt()
      if (!isCurrent()) return false
      alertNormal(p.actives.map((e) => e.prompt).join('§'))
      return JSON.stringify(p)
    }
    case 'trigger': {
      if (!owner || !currentChar) return ''
      const transcript = getChatMessageOwnerState(owner.chatId)
      if (!transcript) return ''
      const currentChat = safeStructuredClone(owner.chat)
      currentChat.message = safeStructuredClone(transcript.messages)
      const target = captureActiveChatTarget()
      if (!target || target.characterId !== currentChar.chaId || target.chatId !== owner.chatId) return ''
      const triggerController = createManualTriggerAbortController()
      try {
        const triggerResult = await runTrigger(currentChar, 'manual', {
          chat: currentChat,
          manualName: arg,
          signal: triggerController.signal,
        })
        if (!isCurrent()) return false

        const freshOwner = selectedCommandChatOwner()
        if (
          triggerResult?.chat.id === owner.chatId &&
          isActiveChatTargetFresh(target) &&
          freshOwner &&
          freshOwner.character.chaId === owner.character.chaId &&
          freshOwner.chatId === owner.chatId
        ) {
          mutateChatWithScopedCommand((chat) => replaceChatRecord(chat, triggerResult.chat), {
            selectedChar: freshOwner.selectedIndex,
            selectedChat: freshOwner.chatPage,
          })
        }
      } finally {
        clearManualTriggerAbortController(triggerController)
      }
      return
    }
    case '?': {
      alertMd(`
            # /input [text]
            - Show input dialog
            - Return input text
            - Example: /input Hello World
            # /echo [text]
            - Show alert dialog
            - Return input text
            - Example: /echo Hello World
            # /popup [text]
            - Show alert dialog
            - Return input text
            - Example: /popup Hello World
            # /pass [text]
            - Return input text
            - Example: /pass Hello World
            # /buttons [labels]
            - Show select dialog
            - Return selected label
            - Example: /buttons Yes§No
            # /speak [text]
            - Speak text
            - Example: /speak Hello World
            # /send [text]
            - Send text to chat
            - Example: /send Hello World
            # /sendas [text]
            - Send text to chat as character
            - Example: /sendas Hello World
            # /comment [text]
            - Add comment to chat
            - Example: /comment Hello World
            # /cut [index]
            - Cut chat message
            - Example: /cut 1
            # /del [size]
            - Delete chat message
            - Example: /del 1
            # /len [array]
            - Return length of array
            - Example: /len Hello§World
            # /setvar key=[key] [value]
            - Set variable
            - Example: /setvar key=hello world
            # /addvar key=[key] [value]
            - Add value to variable
            - Example: /addvar key=damage 10
            # /getvar key=[key]
            - Get variable
            - Example: /getvar key=damage
            # /trigger [name]
            - Run trigger
            # /?
            - Show help
            `)
      return 'help'
    }
  }
  return false
}

function selectedCommandChatOwner(): CommandChatOwner | null {
  if (charactersResourceState.status !== 'ready') return null
  const selectedIndex = get(selectedCharID)
  const character = selectCharacterOwner(charactersResourceState.characters, selectedIndex)
  const characterId = character?.chaId
  if (!characterId || getCharacterResourceOwner(characterId) !== character) return null

  const chatPage = character.chatPage
  const chat = Number.isInteger(chatPage) && chatPage >= 0 ? character.chats?.[chatPage] : undefined
  const chatId = chat?.id
  if (!chat || !stableOwnerId(chatId) || !getChatMetadataOwnerState(chatId)) return null
  return { selectedIndex, chatPage, character, chat, chatId }
}

function commandScriptstateSnapshot(owner: CommandChatOwner): ChatScriptstateSnapshot | undefined {
  const snapshot = getChatScriptstateOwnerSnapshot(owner.character.chaId, owner.chatId)
  if (!snapshot) return undefined
  return {
    characterId: snapshot.characterId,
    chatId: snapshot.chatId,
    selectedCharID: owner.selectedIndex,
    scriptstate: snapshot.scriptstate ? { ...snapshot.scriptstate } : undefined,
  }
}

// The durable chat command owns optimistic projection and rollback. This
// compatibility parser supplies only the exact stable character/chat target.
function mutateCurrentChatMessages(owner: CommandChatOwner | null, mutate: (chat: Chat) => void): boolean {
  if (!owner) return false
  return mutateChatWithScopedCommand((chat) => mutate(chat), {
    selectedChar: owner.selectedIndex,
    selectedChat: owner.chatPage,
  })
}

function replaceChatRecord(target: Chat, replacement: Chat): void {
  const targetRecord = target as unknown as Record<string, unknown>
  const replacementRecord = safeStructuredClone(replacement) as unknown as Record<string, unknown>
  for (const key of Object.keys(targetRecord)) {
    if (!(key in replacementRecord)) delete targetRecord[key]
  }
  Object.assign(targetRecord, replacementRecord)
}

function stableOwnerId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function commandParser(command: string, pipe: string) {
  if (command.startsWith('/')) {
    command = command.slice(1)
  }
  const sliced = command.split(' ').filter((e) => e != '')
  const commandName = sliced[0]
  let argArray: string[] = []
  let namedArg: { [key: string]: string } = {}
  for (let i = 1; i < sliced.length; i++) {
    if (sliced[i].includes('=')) {
      const [key, value] = sliced[i].split('=')
      namedArg[key] = value
    } else {
      argArray.push(sliced[i])
    }
  }
  const arg = argArray
    .join(' ')
    .replace('{{pipe}}', pipe) //STScript compatibility
    .replace('{{slot}}', pipe) //Risu default
  return { commandName, arg, namedArg }
}
