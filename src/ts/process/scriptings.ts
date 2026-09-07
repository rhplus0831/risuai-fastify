import { clientSessionStore, isClientReadOnly, isClientSessionManaged } from '../clientSession'
import {
  captureClientWriteOperation,
  assertClientWriteOperation,
  isClientWriteOperationCurrent,
  awaitClientWriteOperation,
} from '../clientWriteOperation'
import { asBuffer } from 'src/ts/util'
import { sha256Hex } from '../sha256Fallback'
import { getChatVar, getGlobalChatVar, setChatVar } from '../parser/chatVar.svelte'
import { hasher, type simpleCharacterArgument, risuChatParser } from '../parser/parser.svelte'
import { LuaEngine, LuaFactory } from 'wasmoon'
import { get } from 'svelte/store'
import { type Chat, type character, type triggerscript } from '../storage/database.svelte'
import { reloadChatAt, reloadGuiDisplay, selectedCharID } from '../stores.svelte'
import { alertSelect, alertError, alertInput, alertNormal, alertConfirm } from '../alert'
import { HypaProcesser } from './memory/hypamemory'
import { generateAIImage } from './stableDiff'
import { writeInlayImage, getInlayAsset } from './files/inlays'
import type { OpenAIChat, MultiModal } from './index.svelte'
import { requestChatData, type StreamResponseChunk } from './request/request'
import {
  normalizeScriptModelOverrides,
  scriptModelOverrideProfileId,
  type ScriptModelOverrides,
} from '@risuai/shared-core/script-model-overrides'
import { v4 } from 'uuid'
import { createNonSecurityUuid } from '../nonSecurityUuid'
import { getModuleLorebooks, getModuleTriggerOwner, getModuleTriggers } from './modules'
import { Mutex } from '../mutex'
import { tokenize } from '../tokenizer'
import { fetchNative, readImage } from '../globalApi.svelte'
import { loadLoreBookV3Prompt } from './lorebook.svelte'
import { parseKeyValue } from '../util'
import { getPersonaPrompt, getUserIcon, getUserName } from '../utilState'
import { safeStructuredClone } from '../polyfill'
import { resolveModelProfile } from '../model/modelProfileResolver'
import { getSelectedCharacterOwner } from '../characterState'
import type { PyWorkerRequest, PyWorkerResponse } from './pyworker'
import {
  captureActiveChatTarget,
  isActiveChatTargetFresh,
  prepareCompatibleChatUpdateScoped,
  type ActiveChatTarget,
  type ChatScopedSnapshot,
} from '../chatCommands'
import { canUseServerCommands } from '../server/commands'
import {
  dispatchReplaceChatLorebooks,
  ensureClientLorebookEntryIds,
  scopedLorebookStateSnapshot,
} from '../server/lorebookOwner.svelte'
import {
  charactersResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from '../server/resourceState.svelte'
import { applyCharacterRowMutationScoped } from '../characterCommands'
import { resolveActiveChatGenerationSettings } from '../activeChatGenerationSettings'
let luaFactory: LuaFactory
let ScriptingSafeIds = new Set<string>()
let ScriptingEditDisplayIds = new Set<string>()

function scriptingSettings() {
  return settingsResourceState.status === 'error' ? {} : settingsResourceState.value
}

function applySelectedCharacterScriptingMutation(mutate: (owner: character) => void): boolean {
  if (charactersResourceState.status !== 'ready') return false
  const index = get(selectedCharID)
  const candidate = charactersResourceState.characters[index]
  if (!candidate?.chaId) return false
  return applyCharacterRowMutationScoped(index, candidate.chaId, mutate)
}
let ScriptingLowLevelIds = new Set<string>()
let lastRequestResetTime = 0
let lastRequestsCount = 0

export const DEFAULT_CLIENT_LUA_EXEC_TIMEOUT_MS = 3_000
export const DEFAULT_CLIENT_PYTHON_EXEC_TIMEOUT_MS = 3_000
export const DEFAULT_CLIENT_PYTHON_INIT_TIMEOUT_MS = 60_000
export const CLIENT_LUA_ENGINE_CACHE_PER_MODE = 4
const CLIENT_LUA_CODE_HASH_MEMO_LIMIT = 128

interface BasicScriptingEngineState {
  code?: string
  cacheKey?: string
  cacheBucket?: string
  activeRuns?: number
  clientOperation?: number
  mutex: Mutex
  chat?: Chat
  setVar?: (key: string, value: string) => boolean | void
  getVar?: (key: string) => string
  scriptModelOverrides: ScriptModelOverrides
  currentRun?: {
    char?: character | simpleCharacterArgument
    stopChat: () => void
  }
}

function currentScriptingClientOperation(state: BasicScriptingEngineState): number {
  if (state.clientOperation === undefined) {
    if (!isClientSessionManaged()) return captureClientWriteOperation()
    throw new Error('Script execution is no longer active.')
  }
  assertClientWriteOperation(state.clientOperation)
  return state.clientOperation
}

interface LuaScriptingEngineState extends BasicScriptingEngineState {
  engine?: LuaEngine
  execTimeoutMs?: number
  type: 'lua'
}

interface PythonScriptingEngineState extends BasicScriptingEngineState {
  pyodide?: PyodideContext
  execTimeoutMs?: number
  initTimeoutMs?: number
  type: 'py'
}

type ScriptingEngineState = LuaScriptingEngineState | PythonScriptingEngineState

let ScriptingEngines = new Map<string, ScriptingEngineState>()
let ScriptingEngineLru = new Map<string, string[]>()
let ScriptingCodeHashMemo = new Map<string, string>()
let luaFactoryPromise: Promise<void> | null = null
let pendingEngineCreations = new Map<string, Promise<ScriptingEngineState>>()

export async function runScripted(
  code: string,
  arg: {
    char?: character | simpleCharacterArgument
    chat?: Chat
    data?: string | OpenAIChat[]
    setVar?: (key: string, value: string) => boolean | void
    getVar?: (key: string) => string
    lowLevelAccess?: boolean
    meta?: object
    mode?: string
    type?: 'lua' | 'py'
    luaExecTimeoutMs?: number
    pythonExecTimeoutMs?: number
    pythonInitTimeoutMs?: number
    /** Explicit script owner selection. Pass `{}` for a module with no override
     * so it does not inherit the active character's local selection. */
    scriptModelOverrides?: ScriptModelOverrides
  },
) {
  const clientOperation = captureClientWriteOperation()

  const type: 'lua' | 'py' = arg.type ?? 'lua'
  const char = arg.char ?? getSelectedCharacterOwner()
  if (!char) {
    throw new Error('character owner unavailable')
  }
  const data = arg.data ?? ''
  const setVar = arg.setVar ?? setChatVar
  const getVar = arg.getVar ?? getChatVar
  const meta = arg.meta ?? {}
  const mode = arg.mode ?? 'manual'
  const luaExecTimeoutMs = arg.luaExecTimeoutMs ?? DEFAULT_CLIENT_LUA_EXEC_TIMEOUT_MS
  const pythonExecTimeoutMs = arg.pythonExecTimeoutMs ?? DEFAULT_CLIENT_PYTHON_EXEC_TIMEOUT_MS
  const pythonInitTimeoutMs = arg.pythonInitTimeoutMs ?? DEFAULT_CLIENT_PYTHON_INIT_TIMEOUT_MS
  const scriptModelOverrides = normalizeScriptModelOverrides(
    Object.prototype.hasOwnProperty.call(arg, 'scriptModelOverrides')
      ? arg.scriptModelOverrides
      : char.type === 'simple'
        ? undefined
        : char.scriptModelOverrides,
  )

  let chat = arg.chat ?? (char.type === 'character' ? char.chats?.[char.chatPage] : undefined)
  let stopSending = false
  let lowLevelAccess = arg.lowLevelAccess ?? false

  if (type === 'lua') {
    await awaitClientWriteOperation(clientOperation, ensureLuaFactory())
  }
  const codeHash =
    type === 'lua' ? await awaitClientWriteOperation(clientOperation, hashScriptingCode(code)) : undefined
  let ScriptingEngineState = await awaitClientWriteOperation(
    clientOperation,
    getOrCreateEngineState(mode, type, codeHash),
  )
  ScriptingEngineState.activeRuns = (ScriptingEngineState.activeRuns ?? 0) + 1

  const execute = async () => {
    ScriptingEngineState.chat = chat
    ScriptingEngineState.setVar = setVar
    ScriptingEngineState.getVar = getVar
    ScriptingEngineState.scriptModelOverrides = scriptModelOverrides
    const shouldRecreateLuaEngine =
      ScriptingEngineState.type === 'lua' &&
      (code !== ScriptingEngineState.code || ScriptingEngineState.execTimeoutMs !== luaExecTimeoutMs)
    const shouldRecreatePythonContext =
      ScriptingEngineState.type === 'py' &&
      (code !== ScriptingEngineState.code ||
        ScriptingEngineState.execTimeoutMs !== pythonExecTimeoutMs ||
        ScriptingEngineState.initTimeoutMs !== pythonInitTimeoutMs ||
        ScriptingEngineState.pyodide?.isClosed === true)
    if (
      code !== ScriptingEngineState.code ||
      shouldRecreateLuaEngine ||
      shouldRecreatePythonContext ||
      (ScriptingEngineState.type === 'py' && !ScriptingEngineState.pyodide)
    ) {
      let declareAPI: (name: string, func: Function) => void

      if (ScriptingEngineState.type === 'lua') {
        console.log('Creating new Lua engine for mode:', mode)
        ScriptingEngineState.engine?.global.close()
        ScriptingEngineState.engine = undefined
        ScriptingEngineState.code = undefined
        ScriptingEngineState.execTimeoutMs = luaExecTimeoutMs
        try {
          ScriptingEngineState.engine = await awaitClientWriteOperation(
            clientOperation,
            luaFactory.createEngine({
              injectObjects: true,
              functionTimeout: luaExecTimeoutMs,
            }),
          )
        } catch (error) {
          evictScriptingEngineState(ScriptingEngineState)
          throw error
        }
        const luaEngine = ScriptingEngineState.engine
        declareAPI = (name: string, func: Function) => {
          luaEngine.global.set(name, func)
        }
      }
      if (ScriptingEngineState.type === 'py') {
        console.log('Creating new Pyodide context for mode:', mode)
        ScriptingEngineState.pyodide?.close()
        ScriptingEngineState.pyodide = new PyodideContext(pythonExecTimeoutMs, pythonInitTimeoutMs)
        ScriptingEngineState.execTimeoutMs = pythonExecTimeoutMs
        ScriptingEngineState.initTimeoutMs = pythonInitTimeoutMs
        declareAPI = (name: string, func: Function) => {
          ScriptingEngineState.pyodide?.declareAPI(name, func as any)
        }
      }
      declareAPI('getChatVar', (id: string, key: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        return ScriptingEngineState.getVar(key)
      })
      declareAPI('setChatVar', (id: string, key: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)) {
          return
        }
        ScriptingEngineState.setVar(key, value)
      })
      declareAPI('setChatVarChanged', (id: string, key: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id) && !ScriptingEditDisplayIds.has(id)) {
          return
        }
        if (ScriptingEngineState.setVar(key, value) === true) {
          return true
        }
      })
      declareAPI('getGlobalVar', (id: string, key: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        return getGlobalChatVar(key)
      })
      declareAPI('stopChat', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        ScriptingEngineState.currentRun?.stopChat()
      })
      declareAPI('alertError', (id: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        alertError(value)
      })
      declareAPI('alertNormal', (id: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        alertNormal(value)
      })
      declareAPI('alertInput', (id: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        return alertInput(value)
      })
      declareAPI('alertSelect', (id: string, value: string[]) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        return alertSelect(value)
      })
      declareAPI('alertConfirm', (id: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        return alertConfirm(value).then((res) => (res ? true : false))
      })

      declareAPI('getChatMain', (id: string, index: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat.message.at(index)
        if (!chat) {
          return JSON.stringify(null)
        }
        const data = {
          role: chat.role,
          data: chat.data,
          time: chat.time ?? 0,
        }
        return JSON.stringify(data)
      })

      declareAPI('getChatData', (id: string, index: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat.message.at(index)
        return chat?.data ?? ''
      })

      declareAPI('getChatRole', (id: string, index: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat.message.at(index)
        return chat?.role ?? ''
      })

      declareAPI('getRecentChatsMain', (id: string, count: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chats = ScriptingEngineState.chat.message
        const safeCount = Math.max(0, Math.floor(count || 0))
        const start = Math.max(0, chats.length - safeCount)
        return JSON.stringify(
          chats.slice(start).map((message) => ({
            role: message.role,
            data: message.data,
            time: message.time ?? 0,
          })),
        )
      })

      declareAPI('setChat', (id: string, index: number, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        const message = ScriptingEngineState.chat.message?.at(index)
        if (message) {
          message.data = value ?? ''
        }
      })
      declareAPI('setChatRole', (id: string, index: number, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        const message = ScriptingEngineState.chat.message?.at(index)
        if (message) {
          message.role = value === 'user' ? 'user' : 'char'
        }
      })
      declareAPI('cutChat', (id: string, start: number, end: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        ScriptingEngineState.chat.message = ScriptingEngineState.chat.message.slice(start, end)
      })
      declareAPI('removeChat', (id: string, index: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        ScriptingEngineState.chat.message.splice(index, 1)
      })
      declareAPI('addChat', (id: string, role: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        let roleData: 'user' | 'char' = role === 'user' ? 'user' : 'char'
        ScriptingEngineState.chat.message.push({ role: roleData, data: value ?? '' })
      })
      declareAPI('insertChat', (id: string, index: number, role: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        let roleData: 'user' | 'char' = role === 'user' ? 'user' : 'char'
        ScriptingEngineState.chat.message.splice(index, 0, { role: roleData, data: value ?? '' })
      })

      declareAPI('getTokens', async (id: string, value: string) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        return await awaitClientWriteOperation(clientOperation, tokenize(value))
      })

      declareAPI('getChatLength', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        return ScriptingEngineState.chat.message.length
      })

      declareAPI('getFullChatMain', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const data = JSON.stringify(
          ScriptingEngineState.chat.message.map((v) => {
            return {
              role: v.role,
              data: v.data,
              time: v.time ?? 0,
            }
          }),
        )
        return data
      })

      declareAPI('sleep', (id: string, time: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(true)
          }, time)
        })
      })

      declareAPI('cbs', (value) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const currentCharacter = ScriptingEngineState.currentRun?.char
        return risuChatParser(value, { chara: currentCharacter?.type === 'character' ? currentCharacter : undefined })
      })

      declareAPI('setFullChatMain', (id: string, value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        const realValue = JSON.parse(value)

        ScriptingEngineState.chat.message = realValue.map((v) => {
          return {
            role: v.role,
            data: v.data,
          }
        })
      })

      declareAPI('logMain', (value: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        console.log(JSON.parse(value))
      })

      declareAPI('reloadDisplay', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        reloadGuiDisplay()
      })

      declareAPI('reloadChat', (id: string, index: number) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        reloadChatAt(index)
      })

      //Low Level Access
      declareAPI('similarity', async (id: string, source: string, value: string[]) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingLowLevelIds.has(id)) {
          return
        }
        const processer = new HypaProcesser()
        await awaitClientWriteOperation(clientOperation, processer.addText(value))
        return await awaitClientWriteOperation(clientOperation, processer.similaritySearch(source))
      })

      declareAPI('request', async (id: string, url: string) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingLowLevelIds.has(id)) {
          return
        }

        if (lastRequestResetTime + 60000 < Date.now()) {
          lastRequestsCount = 0
          lastRequestResetTime = Date.now()
        }

        if (lastRequestsCount > 5) {
          return JSON.stringify({
            status: 429,
            data: 'Too many requests. you can request 5 times per minute',
          })
        }

        lastRequestsCount++

        try {
          //for security and other reasons, only get request in 120 char is allowed
          if (url.length > 120) {
            return JSON.stringify({
              status: 413,
              data: 'URL to large. max is 120 characters',
            })
          }

          if (!url.startsWith('https://')) {
            return JSON.stringify({
              status: 400,
              data: 'Only https requests are allowed',
            })
          }

          const bannedURL = ['https://realm.risuai.net', 'https://risuai.net', 'https://risuai.xyz']

          for (const burl of bannedURL) {
            if (url.startsWith(burl)) {
              return JSON.stringify({
                status: 400,
                data: 'request to ' + url + ' is not allowed',
              })
            }
          }

          //browser fetch
          const d = await awaitClientWriteOperation(
            clientOperation,
            fetchNative(url, {
              method: 'GET',
            }),
          )
          const text = await awaitClientWriteOperation(clientOperation, d.text())
          return JSON.stringify({
            status: d.status,
            data: text,
          })
        } catch (error) {
          return JSON.stringify({
            status: 400,
            data: 'internal error',
          })
        }
      })

      declareAPI('generateImage', async (id: string, value: string, negValue: string = '') => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingLowLevelIds.has(id)) {
          return
        }
        const currentCharacter = ScriptingEngineState.currentRun?.char
        if (!currentCharacter) {
          return
        }
        const gen = await awaitClientWriteOperation(
          clientOperation,
          generateAIImage(value, currentCharacter as character, negValue, 'inlay'),
        )
        if (!gen) {
          return 'Error: Image generation failed'
        }
        const imgHTML = new Image()
        imgHTML.src = gen
        const inlay = await awaitClientWriteOperation(clientOperation, writeInlayImage(imgHTML))
        return `{{inlay::${inlay}}}`
      })

      declareAPI('getCharacterImageMain', async (id: string) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        try {
          const character = ScriptingEngineState.currentRun?.char

          if (!character || character.type !== 'character' || !character.image) {
            return ''
          }

          const img = await awaitClientWriteOperation(clientOperation, readImage(character.image))
          const imgObj = new Image()
          const extention = character.image.split('.').at(-1)
          const imgURL = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/${extention}` }))

          let imgid: string | null = null
          try {
            imgObj.src = imgURL
            imgid = await awaitClientWriteOperation(
              clientOperation,
              writeInlayImage(imgObj, {
                name: character.image,
                ext: extention,
                id: character.image,
              }),
            )
          } finally {
            URL.revokeObjectURL(imgURL)
          }

          if (imgid) {
            return `{{inlayed::${imgid}}}`
          }
          console.warn('Failed to create character image inlay')
          return ''
        } catch (error) {
          console.error('Error in getCharacterImageMain:', error)
          return ''
        }
      })

      declareAPI('getPersonaImageMain', async (id: string) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        try {
          const icon = getUserIcon()

          if (!icon) {
            return ''
          }

          const img = await awaitClientWriteOperation(clientOperation, readImage(icon))
          const imgObj = new Image()
          const extention = icon.split('.').at(-1)
          const imgURL = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/${extention}` }))

          let imgid: string | null = null
          try {
            imgObj.src = imgURL
            imgid = await awaitClientWriteOperation(
              clientOperation,
              writeInlayImage(imgObj, { name: icon, ext: extention, id: icon }),
            )
          } finally {
            URL.revokeObjectURL(imgURL)
          }

          if (imgid) {
            return `{{inlayed::${imgid}}}`
          }

          console.warn('Failed to create character image inlay')
          return ''
        } catch (error) {
          console.error('Error in getCharacterImageMain:', error)
          return ''
        }
      })

      declareAPI('hash', async (id: string, value: string) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        return await awaitClientWriteOperation(clientOperation, hasher(new TextEncoder().encode(value)))
      })

      const parseLuaOptions = (optionsStr?: string) => {
        if (!optionsStr) {
          return {}
        }

        try {
          const parsed = JSON.parse(optionsStr)
          return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
          return {}
        }
      }

      const collectLuaStreamText = async (stream: ReadableStream<StreamResponseChunk>, clientOperation: number) => {
        const reader = stream.getReader()
        let text = ''

        try {
          while (true) {
            const { done, value } = await awaitClientWriteOperation(clientOperation, reader.read())
            if (done) {
              break
            }
            if (value && typeof value['0'] === 'string') {
              text = value['0']
            }
          }
        } finally {
          reader.releaseLock()
        }

        return text
      }

      declareAPI(
        'LLMMain',
        async (id: string, promptStr: string, useMultimodal: boolean = false, optionsStr: string = '') => {
          const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

          let prompt: {
            role: string
            content: string
          }[] = JSON.parse(promptStr)
          if (!ScriptingLowLevelIds.has(id)) {
            return
          }
          let promptbody: OpenAIChat[] = prompt.map((dict) => {
            let role: 'system' | 'user' | 'assistant' = 'assistant'
            switch (dict['role']) {
              case 'system':
              case 'sys':
                role = 'system'
                break
              case 'user':
                role = 'user'
                break
              case 'assistant':
              case 'bot':
              case 'char': {
                role = 'assistant'
                break
              }
            }

            return {
              content: dict['content'] ?? '',
              role: role,
            }
          })

          if (useMultimodal) {
            for (const msg of promptbody) {
              const inlays: string[] = []
              msg.content = msg.content.replace(
                /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                (match: string, p1: string, p2: string) => {
                  if (msg.role === 'assistant') {
                    if (p2 && p1 === 'inlayeddata') {
                      inlays.push(p2)
                    }
                  } else {
                    if (p2) {
                      inlays.push(p2)
                    }
                  }
                  return ''
                },
              )

              const multimodals: MultiModal[] = []
              for (const inlay of inlays) {
                const inlayData = await awaitClientWriteOperation(clientOperation, getInlayAsset(inlay))
                multimodals.push({
                  type: inlayData?.type,
                  base64: inlayData?.data,
                  width: inlayData?.width,
                  height: inlayData?.height,
                })
              }

              msg.multimodals = multimodals.length > 0 ? multimodals : undefined
            }
          }

          const options = parseLuaOptions(optionsStr) as { streaming?: boolean }
          const result = await awaitClientWriteOperation(
            clientOperation,
            requestChatData(
              {
                formated: promptbody,
                bias: {},
                useStreaming: options.streaming === true,
                forceStreaming: options.streaming === true,
                noMultiGen: true,
                ...(scriptModelOverrideProfileId(ScriptingEngineState.scriptModelOverrides, 'scriptMain')
                  ? {
                      profileIdOverride: scriptModelOverrideProfileId(
                        ScriptingEngineState.scriptModelOverrides,
                        'scriptMain',
                      ),
                      strictProfileIdOverride: true,
                    }
                  : {}),
              },
              'scriptMain',
            ),
          )

          if (result.type === 'fail') {
            return JSON.stringify({
              success: false,
              result: 'Error: ' + result.result,
            })
          }

          if (result.type === 'streaming') {
            try {
              return JSON.stringify({
                success: true,
                result: await awaitClientWriteOperation(
                  clientOperation,
                  collectLuaStreamText(result.result, clientOperation),
                ),
              })
            } catch (error) {
              return JSON.stringify({
                success: false,
                result: 'Error: ' + error,
              })
            }
          }

          if (result.type === 'multiline') {
            return JSON.stringify({
              success: false,
              result: result.result,
            })
          }

          return JSON.stringify({
            success: true,
            result: result.result,
          })
        },
      )

      declareAPI('simpleLLM', async (id: string, prompt: string) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingLowLevelIds.has(id)) {
          return
        }
        const result = await awaitClientWriteOperation(
          clientOperation,
          requestChatData(
            {
              formated: [
                {
                  role: 'user',
                  content: prompt,
                },
              ],
              bias: {},
              useStreaming: false,
              noMultiGen: true,
              ...(scriptModelOverrideProfileId(ScriptingEngineState.scriptModelOverrides, 'scriptMain')
                ? {
                    profileIdOverride: scriptModelOverrideProfileId(
                      ScriptingEngineState.scriptModelOverrides,
                      'scriptMain',
                    ),
                    strictProfileIdOverride: true,
                  }
                : {}),
            },
            'scriptMain',
          ),
        )

        if (result.type === 'fail') {
          return {
            success: false,
            result: 'Error: ' + result.result,
          }
        }

        if (result.type === 'streaming' || result.type === 'multiline') {
          return {
            success: false,
            result: result.result,
          }
        }

        return {
          success: true,
          result: result.result,
        }
      })

      declareAPI('getName', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const currentCharacter = ScriptingEngineState.currentRun?.char
        return currentCharacter?.type === 'character' ? currentCharacter.name : ''
      })

      declareAPI('setName', (id: string, name: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        if (typeof name !== 'string') {
          throw 'Invalid data type'
        }
        applySelectedCharacterScriptingMutation((owner) => {
          owner.name = name
        })
      })

      declareAPI('getDescription', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        const currentCharacter = ScriptingEngineState.currentRun?.char
        return currentCharacter?.type === 'character' ? currentCharacter.desc : undefined
      })

      declareAPI('setDescription', (id: string, desc: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        if (typeof desc !== 'string') {
          throw 'Invalid data type'
        }
        applySelectedCharacterScriptingMutation((owner) => {
          owner.desc = desc
        })
      })

      declareAPI('getCharacterFirstMessage', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const currentCharacter = ScriptingEngineState.currentRun?.char
        return currentCharacter?.type === 'character' ? currentCharacter.firstMessage : ''
      })

      declareAPI('setCharacterFirstMessage', (id: string, data: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        if (typeof data !== 'string') {
          return false
        }
        applySelectedCharacterScriptingMutation((owner) => {
          owner.firstMessage = data
        })
        return true
      })

      declareAPI('getPersonaName', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        return getUserName()
      })

      declareAPI('getPersonaDescription', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const currentCharacter = ScriptingEngineState.currentRun?.char
        return risuChatParser(getPersonaPrompt(), {
          chara: currentCharacter?.type === 'character' ? currentCharacter : undefined,
        })
      })

      declareAPI('getAuthorsNote', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        return ScriptingEngineState.chat?.note ?? ''
      })

      declareAPI('getBackgroundEmbedding', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        const currentCharacter = ScriptingEngineState.currentRun?.char
        return currentCharacter?.type === 'character' ? currentCharacter.backgroundHTML : undefined
      })

      declareAPI('setBackgroundEmbedding', (id: string, data: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }
        if (typeof data !== 'string') {
          return false
        }
        applySelectedCharacterScriptingMutation((owner) => {
          owner.backgroundHTML = data
        })
        return true
      })

      // Lore books
      declareAPI('getLoreBooksMain', (id: string, search: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const selectedChar = ScriptingEngineState.currentRun?.char
        if (!selectedChar || selectedChar.type !== 'character') {
          return
        }

        const loreSources = [
          selectedChar.chats[selectedChar.chatPage]?.localLore ?? [],
          selectedChar.globalLore,
          getModuleLorebooks({
            character: selectedChar,
            chat: selectedChar.chats[selectedChar.chatPage],
          }),
        ]

        const found = []
        for (const source of loreSources) {
          for (const b of source) {
            if (b.comment === search) {
              found.push({ ...b, content: risuChatParser(b.content, { chara: selectedChar }) })
            }
          }
        }

        return JSON.stringify(found)
      })

      type upsertLoreBookOptions = {
        alwaysActive?: boolean
        insertOrder?: number
        key?: string
        secondKey?: string
        regex?: boolean
      }

      declareAPI('upsertLocalLoreBook', (id: string, name: string, content: string, options: upsertLoreBookOptions) => {
        currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingSafeIds.has(id)) {
          return
        }

        const currentCharacter = ScriptingEngineState.currentRun?.char
        if (currentCharacter?.type !== 'character') {
          return
        }

        const { alwaysActive = false, insertOrder = 100, key = '', regex = false, secondKey = '' } = options

        const currentChat = currentCharacter.chats[currentCharacter.chatPage]

        const newLocalLoreBooks = currentChat.localLore.filter((book) => book.comment !== name)
        newLocalLoreBooks.push({
          alwaysActive,
          comment: name,
          content: content,
          insertorder: insertOrder,
          mode: 'normal',
          key,
          secondkey: secondKey,
          selective: !!secondKey,
          useRegex: regex,
        })
        currentChat.localLore = newLocalLoreBooks
      })

      declareAPI('loadLoreBooksMain', async (id: string, reserve: number) => {
        const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

        if (!ScriptingLowLevelIds.has(id)) {
          return
        }

        const selectedChar = ScriptingEngineState.currentRun?.char

        if (!selectedChar || selectedChar.type !== 'character') {
          return
        }

        const generation = resolveActiveChatGenerationSettings()
        const selectedChat = selectedChar.chats[selectedChar.chatPage]
        if (
          generation.character?.chaId !== selectedChar.chaId ||
          !selectedChat?.id ||
          generation.chat?.id !== selectedChat.id
        ) {
          return
        }
        const fullLoreBooks = (
          await awaitClientWriteOperation(
            clientOperation,
            loadLoreBookV3Prompt({ database: generation.db, character: selectedChar, chat: selectedChat }),
          )
        ).actives
        // This is a low-level scripting API, so its budget follows the scriptMain
        // execution role (the same owner as LLM/simpleLLM), not chatMain.
        const scriptProfile = resolveModelProfile({ database: generation.db, role: 'scriptMain' })
        const maxContext = (scriptProfile.runtimeOptions.maxContext ?? 0) - reserve
        if (maxContext < 0) {
          return JSON.stringify([])
        }

        let totalTokens = 0
        const loreBooks = []

        for (const book of fullLoreBooks) {
          const parsed = risuChatParser(book.prompt, { chara: selectedChar }).trim()
          if (parsed.length === 0) {
            continue
          }

          const tokens = await awaitClientWriteOperation(clientOperation, tokenize(parsed))

          if (totalTokens + tokens > maxContext) {
            break
          }
          totalTokens += tokens
          loreBooks.push({
            data: parsed,
            role: book.role === 'assistant' ? 'char' : book.role,
          })
        }

        return JSON.stringify(loreBooks)
      })

      declareAPI(
        'axLLMMain',
        async (id: string, promptStr: string, useMultimodal: boolean = false, optionsStr: string = '') => {
          const clientOperation = currentScriptingClientOperation(ScriptingEngineState)

          let prompt: {
            role: string
            content: string
          }[] = JSON.parse(promptStr)
          if (!ScriptingLowLevelIds.has(id)) {
            return
          }
          let promptbody: OpenAIChat[] = prompt.map((dict) => {
            let role: 'system' | 'user' | 'assistant' = 'assistant'
            switch (dict['role']) {
              case 'system':
              case 'sys':
                role = 'system'
                break
              case 'user':
                role = 'user'
                break
              case 'assistant':
              case 'bot':
              case 'char': {
                role = 'assistant'
                break
              }
            }

            return {
              content: dict['content'] ?? '',
              role: role,
            }
          })

          if (useMultimodal) {
            for (const msg of promptbody) {
              const inlays: string[] = []
              msg.content = msg.content.replace(
                /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g,
                (match: string, p1: string, p2: string) => {
                  if (msg.role === 'assistant') {
                    if (p2 && p1 === 'inlayeddata') {
                      inlays.push(p2)
                    }
                  } else {
                    if (p2) {
                      inlays.push(p2)
                    }
                  }
                  return ''
                },
              )

              const multimodals: MultiModal[] = []
              for (const inlay of inlays) {
                const inlayData = await awaitClientWriteOperation(clientOperation, getInlayAsset(inlay))
                multimodals.push({
                  type: inlayData?.type,
                  base64: inlayData?.data,
                  width: inlayData?.width,
                  height: inlayData?.height,
                })
              }

              msg.multimodals = multimodals.length > 0 ? multimodals : undefined
            }
          }

          const options = parseLuaOptions(optionsStr) as { streaming?: boolean }
          const result = await awaitClientWriteOperation(
            clientOperation,
            requestChatData(
              {
                formated: promptbody,
                bias: {},
                useStreaming: options.streaming === true,
                forceStreaming: options.streaming === true,
                noMultiGen: true,
                ...(scriptModelOverrideProfileId(ScriptingEngineState.scriptModelOverrides, 'scriptAux')
                  ? {
                      profileIdOverride: scriptModelOverrideProfileId(
                        ScriptingEngineState.scriptModelOverrides,
                        'scriptAux',
                      ),
                      strictProfileIdOverride: true,
                    }
                  : {}),
              },
              'scriptAux',
            ),
          )

          if (result.type === 'fail') {
            return JSON.stringify({
              success: false,
              result: 'Error: ' + result.result,
            })
          }

          if (result.type === 'streaming') {
            try {
              return JSON.stringify({
                success: true,
                result: await awaitClientWriteOperation(
                  clientOperation,
                  collectLuaStreamText(result.result, clientOperation),
                ),
              })
            } catch (error) {
              return JSON.stringify({
                success: false,
                result: 'Error: ' + error,
              })
            }
          }

          if (result.type === 'multiline') {
            return JSON.stringify({
              success: false,
              result: result.result,
            })
          }

          return JSON.stringify({
            success: true,
            result: result.result,
          })
        },
      )

      declareAPI('getCharacterLastMessage', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat
        if (!chat) {
          return ''
        }

        let pointer = chat.message.length - 1
        while (pointer >= 0) {
          if (chat.message[pointer].role === 'char') {
            const messageData = chat.message[pointer].data
            return messageData
          }
          pointer--
        }

        return ScriptingEngineState.currentRun?.char?.type === 'character'
          ? ScriptingEngineState.currentRun.char.firstMessage
          : ''
      })

      declareAPI('getUserLastMessage', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat
        if (!chat) {
          return ''
        }

        let pointer = chat.message.length - 1
        while (pointer >= 0) {
          if (chat.message[pointer].role === 'user') {
            const messageData = chat.message[pointer].data
            return messageData
          }
          pointer--
        }

        return ''
      })

      declareAPI('getCharacterLastMessage', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat
        if (!chat) {
          return ''
        }

        let pointer = chat.message.length - 1
        while (pointer >= 0) {
          if (chat.message[pointer].role === 'char') {
            const messageData = chat.message[pointer].data
            return messageData
          }
          pointer--
        }

        return ScriptingEngineState.currentRun?.char?.type === 'character'
          ? ScriptingEngineState.currentRun.char.firstMessage
          : ''
      })

      declareAPI('getUserLastMessage', (id: string) => {
        currentScriptingClientOperation(ScriptingEngineState)

        const chat = ScriptingEngineState.chat
        if (!chat) {
          return ''
        }

        let pointer = chat.message.length - 1
        while (pointer >= 0) {
          if (chat.message[pointer].role === 'user') {
            const messageData = chat.message[pointer].data
            return messageData
          }
          pointer--
        }
        return ''
      })
      if (ScriptingEngineState.type === 'lua') {
        try {
          await awaitClientWriteOperation(
            clientOperation,
            runLuaStringWithTimeout(ScriptingEngineState.engine, luaCodeWrapper(code), luaExecTimeoutMs),
          )
        } catch (error) {
          evictScriptingEngineState(ScriptingEngineState)
          throw error
        }
      }
      if (ScriptingEngineState.type === 'py') {
        try {
          await awaitClientWriteOperation(clientOperation, ScriptingEngineState.pyodide?.init(code))
        } catch (error) {
          evictScriptingEngineState(ScriptingEngineState)
          throw error
        }
      }
      ScriptingEngineState.code = code
    }
    let accessKey = v4()
    const currentRun: NonNullable<BasicScriptingEngineState['currentRun']> = {
      char,
      stopChat: () => {
        stopSending = true
      },
    }
    ScriptingEngineState.currentRun = currentRun
    if (mode === 'editDisplay') {
      ScriptingEditDisplayIds.add(accessKey)
    } else {
      ScriptingSafeIds.add(accessKey)
      if (lowLevelAccess) {
        ScriptingLowLevelIds.add(accessKey)
      }
    }
    let res: any
    try {
      if (ScriptingEngineState.type === 'lua') {
        const luaEngine = ScriptingEngineState.engine
        try {
          switch (mode) {
            case 'input': {
              const func = luaEngine.global.get('onInput')
              if (func) {
                res = await awaitClientWriteOperation(clientOperation, func(accessKey))
              }
              break
            }
            case 'output': {
              const func = luaEngine.global.get('onOutput')
              if (func) {
                res = await awaitClientWriteOperation(clientOperation, func(accessKey))
              }
              break
            }
            case 'start': {
              const func = luaEngine.global.get('onStart')
              if (func) {
                res = await awaitClientWriteOperation(clientOperation, func(accessKey))
              }
              break
            }
            case 'onButtonClick': {
              const func = luaEngine.global.get('onButtonClick')
              if (func) {
                res = await awaitClientWriteOperation(clientOperation, func(accessKey, data))
              }
              break
            }
            case 'editRequest':
            case 'editDisplay':
            case 'editInput':
            case 'editOutput': {
              const func = luaEngine.global.get('callListenMain')
              if (func) {
                res = await awaitClientWriteOperation(
                  clientOperation,
                  func(mode, accessKey, JSON.stringify(data), JSON.stringify(meta)),
                )
                res = JSON.parse(res)
              }
              break
            }
            default: {
              const func = luaEngine.global.get(mode)
              if (func) {
                res = await awaitClientWriteOperation(clientOperation, func(accessKey))
              }
              break
            }
          }
          if (res === false) {
            stopSending = true
          }
        } catch (error) {
          console.error('Lua dispatch failed:', error)
          if (isLuaTimeoutError(error)) {
            evictScriptingEngineState(ScriptingEngineState)
          }
          throw error
        }
      }
      if (ScriptingEngineState.type === 'py') {
        switch (mode) {
          case 'input': {
            res = await awaitClientWriteOperation(
              clientOperation,
              ScriptingEngineState.pyodide?.python('onInput', [accessKey]),
            )
            break
          }
          case 'output': {
            res = await awaitClientWriteOperation(
              clientOperation,
              ScriptingEngineState.pyodide?.python('onOutput', [accessKey]),
            )
            break
          }
          case 'start': {
            res = await awaitClientWriteOperation(
              clientOperation,
              ScriptingEngineState.pyodide?.python('onStart', [accessKey]),
            )
            break
          }
          case 'onButtonClick': {
            res = await awaitClientWriteOperation(
              clientOperation,
              ScriptingEngineState.pyodide?.python('onButtonClick', [accessKey, data as string]),
            )
            break
          }
          case 'editRequest':
          case 'editDisplay':
          case 'editInput':
          case 'editOutput': {
            res = await awaitClientWriteOperation(
              clientOperation,
              ScriptingEngineState.pyodide?.python('callListenMain', [
                mode,
                accessKey,
                JSON.stringify(data),
                JSON.stringify(meta),
              ]),
            )
            res = JSON.parse(res)
            break
          }
          default: {
            res = await awaitClientWriteOperation(
              clientOperation,
              ScriptingEngineState.pyodide?.python(mode, [accessKey]),
            )
            break
          }
        }
      }
    } finally {
      ScriptingSafeIds.delete(accessKey)
      ScriptingLowLevelIds.delete(accessKey)
      ScriptingEditDisplayIds.delete(accessKey)
      if (ScriptingEngineState.currentRun === currentRun) {
        ScriptingEngineState.currentRun = undefined
      }
    }

    chat = ScriptingEngineState.chat

    return {
      stopSending,
      chat,
      res,
    }
  }
  const runResult = ScriptingEngineState.mutex.runExclusive(async () => {
    assertClientWriteOperation(clientOperation)
    ScriptingEngineState.clientOperation = clientOperation
    try {
      return await execute()
    } finally {
      ScriptingEngineState.clientOperation = undefined
    }
  })
  return await awaitClientWriteOperation(
    clientOperation,
    runResult.finally(() => {
      ScriptingEngineState.activeRuns = Math.max(0, (ScriptingEngineState.activeRuns ?? 1) - 1)
      enforceScriptingEngineCacheLimit(ScriptingEngineState.cacheBucket)
    }),
  )
}

async function makeLuaFactory() {
  const _luaFactory = new LuaFactory()
  async function mountFile(name: string) {
    let code = ''
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch('/lua/' + name)
        if (res.status >= 200 && res.status < 300) {
          code = await res.text()
          break
        }
      } catch (error) {}
    }
    await _luaFactory.mountFile(name, code)
  }

  await mountFile('json.lua')
  luaFactory = _luaFactory
}

async function ensureLuaFactory() {
  if (luaFactory) return

  if (luaFactoryPromise) {
    try {
      await luaFactoryPromise
    } catch (error) {
      luaFactoryPromise = null
    }
    return
  }

  try {
    luaFactoryPromise = makeLuaFactory()
    await luaFactoryPromise
  } finally {
    luaFactoryPromise = null
  }
}

async function hashScriptingCode(code: string): Promise<string> {
  const cached = ScriptingCodeHashMemo.get(code)
  if (cached !== undefined) {
    ScriptingCodeHashMemo.delete(code)
    ScriptingCodeHashMemo.set(code, cached)
    return cached
  }

  const hash = await sha256Hex(code)

  ScriptingCodeHashMemo.set(code, hash)
  while (ScriptingCodeHashMemo.size > CLIENT_LUA_CODE_HASH_MEMO_LIMIT) {
    const oldest = ScriptingCodeHashMemo.keys().next().value
    if (oldest === undefined) break
    ScriptingCodeHashMemo.delete(oldest)
  }
  return hash
}

function getScriptingEngineBucket(mode: string, type: 'lua' | 'py'): string {
  return `${type}:${mode}`
}

function getScriptingEngineCacheKey(mode: string, type: 'lua' | 'py', codeHash?: string): string {
  const bucket = getScriptingEngineBucket(mode, type)
  return type === 'lua' ? `${bucket}:${codeHash ?? 'empty'}` : bucket
}

function touchScriptingEngineCacheKey(bucket: string, cacheKey: string): void {
  const current = ScriptingEngineLru.get(bucket) ?? []
  const next = current.filter((key) => key !== cacheKey)
  next.push(cacheKey)
  ScriptingEngineLru.set(bucket, next)
}

function closeScriptingEngineState(engineState: ScriptingEngineState): void {
  try {
    if (engineState.type === 'lua') {
      engineState.engine?.global.close()
    } else {
      engineState.pyodide?.close()
    }
  } catch (error) {
    console.warn('Failed to close scripting engine state', error)
  }
}

function deleteScriptingEngineCacheKey(cacheKey: string): void {
  const engineState = ScriptingEngines.get(cacheKey)
  if (engineState) {
    closeScriptingEngineState(engineState)
  }
  ScriptingEngines.delete(cacheKey)
  pendingEngineCreations.delete(cacheKey)
}

function evictScriptingEngineState(engineState: ScriptingEngineState): void {
  const cacheKey = engineState.cacheKey
  if (!cacheKey || ScriptingEngines.get(cacheKey) !== engineState) {
    closeScriptingEngineState(engineState)
    return
  }
  if ((engineState.activeRuns ?? 0) > 1) {
    closeScriptingEngineState(engineState)
    engineState.code = undefined
    if (engineState.type === 'lua') {
      engineState.engine = undefined
    } else {
      engineState.pyodide = undefined
    }
    return
  }
  deleteScriptingEngineCacheKey(cacheKey)
  if (engineState.cacheBucket) {
    const keys = ScriptingEngineLru.get(engineState.cacheBucket)
    if (keys) {
      ScriptingEngineLru.set(
        engineState.cacheBucket,
        keys.filter((key) => key !== cacheKey),
      )
    }
  }
}

function isLuaTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout/i.test(error.message)
}

function enforceScriptingEngineCacheLimit(bucket?: string): void {
  if (!bucket) {
    return
  }
  const keys = ScriptingEngineLru.get(bucket)
  if (!keys) {
    return
  }
  let index = 0
  while (keys.length > CLIENT_LUA_ENGINE_CACHE_PER_MODE && index < keys.length) {
    const cacheKey = keys[index]
    const engineState = ScriptingEngines.get(cacheKey)
    if ((engineState?.activeRuns ?? 0) > 0) {
      index++
      continue
    }
    keys.splice(index, 1)
    deleteScriptingEngineCacheKey(cacheKey)
  }
  ScriptingEngineLru.set(
    bucket,
    keys.filter((key) => ScriptingEngines.has(key)),
  )
}

async function getOrCreateEngineState(
  mode: string,
  type: 'lua' | 'py',
  codeHash?: string,
): Promise<ScriptingEngineState> {
  const cacheKey = getScriptingEngineCacheKey(mode, type, codeHash)
  const cacheBucket = getScriptingEngineBucket(mode, type)
  let engineState = ScriptingEngines.get(cacheKey)
  if (engineState) {
    touchScriptingEngineCacheKey(cacheBucket, cacheKey)
    return engineState
  }

  let pendingCreation = pendingEngineCreations.get(cacheKey)
  if (pendingCreation) {
    return pendingCreation
  }

  const creationPromise = (() => {
    const engineState: ScriptingEngineState = {
      mutex: new Mutex(),
      scriptModelOverrides: {},
      type: type,
      cacheKey,
      cacheBucket,
    }
    ScriptingEngines.set(cacheKey, engineState)
    touchScriptingEngineCacheKey(cacheBucket, cacheKey)
    enforceScriptingEngineCacheLimit(cacheBucket)

    pendingEngineCreations.delete(cacheKey)

    return Promise.resolve(engineState)
  })()

  pendingEngineCreations.set(cacheKey, creationPromise)

  return creationPromise
}

async function runLuaStringWithTimeout(engine: LuaEngine | undefined, code: string, timeoutMs: number): Promise<void> {
  if (!engine) {
    return
  }
  const global = engine.global
  const thread = global.newThread()
  const threadIndex = global.getTop()
  try {
    thread.loadString(code)
    await thread.run(0, { timeout: timeoutMs })
  } finally {
    global.remove(threadIndex)
  }
}

export function resetScriptingEngineCacheForTests(): void {
  for (const engineState of ScriptingEngines.values()) {
    closeScriptingEngineState(engineState)
  }
  ScriptingEngines.clear()
  ScriptingEngineLru.clear()
  ScriptingCodeHashMemo.clear()
  pendingEngineCreations.clear()
  ScriptingSafeIds.clear()
  ScriptingEditDisplayIds.clear()
  ScriptingLowLevelIds.clear()
}

export function getScriptingEngineCacheSnapshotForTests(): {
  keys: string[]
  accessSetSizes: { safe: number; editDisplay: number; lowLevel: number }
} {
  return {
    keys: [...ScriptingEngines.keys()],
    accessSetSizes: {
      safe: ScriptingSafeIds.size,
      editDisplay: ScriptingEditDisplayIds.size,
      lowLevel: ScriptingLowLevelIds.size,
    },
  }
}

function luaCodeWrapper(code: string) {
  return `
json = require 'json'

function getChat(id, index)
    return json.decode(getChatMain(id, index))
end

function getFullChat(id)
    return json.decode(getFullChatMain(id))
end

function getRecentChats(id, count)
    return json.decode(getRecentChatsMain(id, count))
end

function setFullChat(id, value)
    setFullChatMain(id, json.encode(value))
end

function log(value)
    logMain(json.encode(value))
end

function getLoreBooks(id, search)
    return json.decode(getLoreBooksMain(id, search))
end


function loadLoreBooks(id)
    return json.decode(loadLoreBooksMain(id):await())
end

function LLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(LLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function axLLM(id, prompt, useMultimodal, options)
    useMultimodal = useMultimodal or false
    options = options or {}
    return json.decode(axLLMMain(id, json.encode(prompt), useMultimodal, json.encode(options)):await())
end

function getCharacterImage(id)
    return getCharacterImageMain(id):await()
end

function getPersonaImage(id)
    return getPersonaImageMain(id):await()
end

local editRequestFuncs = {}
local editDisplayFuncs = {}
local editInputFuncs = {}
local editOutputFuncs = {}

function listenEdit(type, func)
    if type == 'editRequest' then
        editRequestFuncs[#editRequestFuncs + 1] = func
        return
    end

    if type == 'editDisplay' then
        editDisplayFuncs[#editDisplayFuncs + 1] = func
        return
    end

    if type == 'editInput' then
        editInputFuncs[#editInputFuncs + 1] = func
        return
    end

    if type == 'editOutput' then
        editOutputFuncs[#editOutputFuncs + 1] = func
        return
    end

    throw('Invalid type')
end

function getState(id, name)
    local escapedName = "__"..name
    return json.decode(getChatVar(id, escapedName))
end

function setState(id, name, value)
    local escapedName = "__"..name
    setChatVar(id, escapedName, json.encode(value))
end

function setStateChanged(id, name, value)
    local escapedName = "__"..name
    return setChatVarChanged(id, escapedName, json.encode(value))
end

function async(callback)
    return function(...)
        local co = coroutine.create(callback)
        local safe, result = coroutine.resume(co, ...)

        return Promise.create(function(resolve, reject)
            local checkresult
            local step = function()
                if coroutine.status(co) == "dead" then
                    local send = safe and resolve or reject
                    return send(result)
                end

                safe, result = coroutine.resume(co)
                checkresult()
            end

            checkresult = function()
                if safe and result == Promise.resolve(result) then
                    result:finally(step)
                else
                    step()
                end
            end

            checkresult()
        end)
    end
end

callListenMain = async(function(type, id, value, meta)
    local realValue = json.decode(value)
    local realMeta = json.decode(meta)

    if type == 'editRequest' then
        for _, func in ipairs(editRequestFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editDisplay' then
        for _, func in ipairs(editDisplayFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editInput' then
        for _, func in ipairs(editInputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    if type == 'editOutput' then
        for _, func in ipairs(editOutputFuncs) do
            realValue = func(id, realValue, realMeta)
        end
    end

    return json.encode(realValue)
end)

${code}
`
}

export async function runLuaEditTrigger<T extends string | OpenAIChat[]>(
  char: character | simpleCharacterArgument,
  mode: string,
  content: T,
  meta?: object,
): Promise<T> {
  const clientOperation = captureClientWriteOperation()

  switch (mode) {
    case 'editinput':
      mode = 'editInput'
      break
    case 'editoutput':
      mode = 'editOutput'
      break
    case 'editdisplay':
      mode = 'editDisplay'
      break
    case 'editprocess':
      return content
  }

  try {
    let data = content

    const ownTriggers = ((char as { triggerscript?: triggerscript[] }).triggerscript ?? []).map(
      (v): triggerscript => ({
        ...v,
        lowLevelAccess: false,
      }),
    )
    const triggers: triggerscript[] = ownTriggers.concat(
      getModuleTriggers(char.type === 'character' ? { character: char, chat: char.chats?.[char.chatPage] } : undefined),
    )
    const luaTriggerEffects = triggers
      .map((trigger) => trigger?.effect?.[0])
      .filter((effect): effect is { type: 'triggerlua'; code: string } => effect?.type === 'triggerlua')
    if (luaTriggerEffects.length === 0) return data
    const workingContext = createLuaEditTriggerWorkingContext(char, mode)

    for (const effect of luaTriggerEffects) {
      const runResult = await awaitClientWriteOperation(
        clientOperation,
        runScripted(effect.code, {
          char: workingContext.char,
          chat: workingContext.chat,
          setVar: workingContext.chat ? createLuaButtonWorkingSetVar(workingContext.chat) : undefined,
          getVar: workingContext.chat
            ? createLuaButtonWorkingGetVar(workingContext.char, workingContext.chat)
            : undefined,
          lowLevelAccess: false,
          mode: mode,
          data,
          meta,
        }),
      )
      data = runResult.res ?? data
    }

    reconcileLuaEditTriggerWorkingChat(workingContext)
    return data
  } catch (error) {
    assertClientWriteOperation(clientOperation)
    console.error(`Lua edit trigger failed in ${mode}:`, error)
    return content
  }
}

interface LuaEditTriggerReconciliation {
  target: ActiveChatTarget
  previous: ChatScopedSnapshot
  messageSnapshot: string | null
  scriptstateSnapshot: string
  localLoreSnapshot: string | null
}

interface LuaEditTriggerWorkingContext {
  char: character | simpleCharacterArgument
  chat?: Chat
  reconciliation?: LuaEditTriggerReconciliation
}

function createLuaEditTriggerWorkingContext(
  char: character | simpleCharacterArgument,
  mode: string,
): LuaEditTriggerWorkingContext {
  const canMutateChatCollections = mode !== 'editDisplay'
  if (char.type !== 'character') {
    const currentCharacter = getSelectedCharacterOwner()
    const currentChat = currentCharacter?.chats?.[currentCharacter.chatPage] ?? createEmptyLuaEditTriggerChat()
    return {
      char,
      chat: cloneLuaEditTriggerChat(currentChat, canMutateChatCollections),
    }
  }

  const target = canUseServerCommands() ? captureActiveChatTarget() : null
  const activeCharacter = target ? getCharacterResourceOwner(target.characterId) : undefined
  const activeChat = activeCharacter?.chats?.[activeCharacter.chatPage]
  const targetChatIndex = target?.chatId ? char.chats.findIndex((candidate) => candidate.id === target.chatId) : -1
  const ownsActiveChat =
    target !== null &&
    activeCharacter !== undefined &&
    activeChat !== undefined &&
    typeof target.chatId === 'string' &&
    target.chatId.length > 0 &&
    char.chaId === target.characterId &&
    activeCharacter.chaId === target.characterId &&
    activeChat.id === target.chatId &&
    targetChatIndex >= 0

  const previousChat = ownsActiveChat ? cloneLuaEditTriggerChat(activeChat, canMutateChatCollections) : undefined
  const characterChat = char.chats[char.chatPage]
  const currentCharacter = getSelectedCharacterOwner()
  const sourceChat = ownsActiveChat
    ? previousChat
    : (characterChat ?? currentCharacter?.chats?.[currentCharacter.chatPage] ?? createEmptyLuaEditTriggerChat())

  const workingChat = cloneLuaEditTriggerChat(sourceChat, canMutateChatCollections)
  const workingChatIndex = ownsActiveChat ? targetChatIndex : characterChat ? char.chatPage : char.chats.length
  const workingCharacter: character = {
    ...char,
    chats: [...char.chats],
    chatPage: workingChatIndex,
  }
  workingCharacter.chats[workingChatIndex] = workingChat

  return {
    char: workingCharacter,
    chat: workingChat,
    reconciliation: ownsActiveChat
      ? {
          target,
          previous: {
            selectedCharID: target.selectedCharID,
            characterId: target.characterId,
            chatId: target.chatId,
            chat: previousChat,
          },
          messageSnapshot: canMutateChatCollections ? luaEditTriggerSnapshot(previousChat.message) : null,
          scriptstateSnapshot: luaEditTriggerSnapshot(previousChat.scriptstate),
          localLoreSnapshot: canMutateChatCollections ? luaEditTriggerSnapshot(previousChat.localLore) : null,
        }
      : undefined,
  }
}

function createEmptyLuaEditTriggerChat(): Chat {
  return {
    message: [],
    note: '',
    name: '',
    localLore: [],
    scriptstate: {},
  }
}

function cloneLuaEditTriggerChat(chat: Chat, cloneCollections: boolean): Chat {
  return {
    ...chat,
    message: cloneCollections ? safeStructuredClone(chat.message ?? []) : chat.message,
    localLore: cloneCollections ? safeStructuredClone(chat.localLore ?? []) : chat.localLore,
    scriptstate: chat.scriptstate === undefined ? undefined : safeStructuredClone(chat.scriptstate),
  }
}

function reconcileLuaEditTriggerWorkingChat(context: LuaEditTriggerWorkingContext): void {
  const { chat: workingChat, reconciliation } = context
  const previousChat = reconciliation?.previous.chat
  if (!workingChat || !reconciliation || !previousChat) return

  const messagesChanged =
    reconciliation.messageSnapshot !== null &&
    reconciliation.messageSnapshot !== luaEditTriggerSnapshot(workingChat.message)
  const scriptstateChanged = reconciliation.scriptstateSnapshot !== luaEditTriggerSnapshot(workingChat.scriptstate)
  const localLoreChanged =
    reconciliation.localLoreSnapshot !== null &&
    reconciliation.localLoreSnapshot !== luaEditTriggerSnapshot(workingChat.localLore)
  if (!messagesChanged && !scriptstateChanged && !localLoreChanged) return
  if (!isActiveChatTargetFresh(reconciliation.target)) return

  const nextChat: Chat = { ...previousChat }
  if (messagesChanged) nextChat.message = safeStructuredClone(workingChat.message)
  if (scriptstateChanged) nextChat.scriptstate = safeStructuredClone(workingChat.scriptstate)

  const commandPreviousChat: Chat = messagesChanged ? previousChat : { ...previousChat, message: [] }
  const commandNextChat: Chat = messagesChanged ? nextChat : { ...nextChat, message: [] }
  const preparation = prepareCompatibleChatUpdateScoped(commandPreviousChat, commandNextChat, reconciliation.previous)
  const expectedChatCommandCount = Number(messagesChanged) + Number(scriptstateChanged)
  if (preparation.commandCount !== expectedChatCommandCount) return
  const nextLocalLore = localLoreChanged ? safeStructuredClone(workingChat.localLore ?? []) : null
  if (nextLocalLore) ensureClientLorebookEntryIds(nextLocalLore)
  const lorebookPrevious = localLoreChanged
    ? scopedLorebookStateSnapshot(`chat:${reconciliation.target.chatId}`, reconciliation.localLoreSnapshot)
    : null

  const applied = (() => {
    if (!isActiveChatTargetFresh(reconciliation.target)) return false

    const selectedCharacter = getCharacterResourceOwner(reconciliation.target.characterId)
    const liveChat = selectedCharacter?.chats?.[selectedCharacter.chatPage]
    if (
      !selectedCharacter ||
      !liveChat ||
      selectedCharacter.chaId !== reconciliation.target.characterId ||
      liveChat.id !== reconciliation.target.chatId
    ) {
      return false
    }

    if (messagesChanged && luaEditTriggerSnapshot(liveChat.message) !== reconciliation.messageSnapshot) {
      return false
    }
    if (scriptstateChanged && luaEditTriggerSnapshot(liveChat.scriptstate) !== reconciliation.scriptstateSnapshot) {
      return false
    }
    if (localLoreChanged && luaEditTriggerSnapshot(liveChat.localLore) !== reconciliation.localLoreSnapshot) {
      return false
    }

    if (messagesChanged) liveChat.message = safeStructuredClone(nextChat.message)
    if (scriptstateChanged) liveChat.scriptstate = safeStructuredClone(nextChat.scriptstate)
    if (nextLocalLore) liveChat.localLore = nextLocalLore
    return true
  })()
  if (!applied) return

  preparation.dispatch()
  if (nextLocalLore && lorebookPrevious && reconciliation.target.chatId) {
    dispatchReplaceChatLorebooks(reconciliation.target.chatId, nextLocalLore, lorebookPrevious, 0)
  }
}

function luaEditTriggerSnapshot(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

export async function runLuaButtonTrigger(
  char: character | simpleCharacterArgument,
  data: string,
  options?: {
    chat?: Chat
    isFresh?: () => boolean
    deferLiveChatSideEffects?: boolean
  },
): Promise<any> {
  const clientOperation = captureClientWriteOperation()

  let runResult
  const workingChat =
    options?.chat && options.deferLiveChatSideEffects ? safeStructuredClone(options.chat) : options?.chat
  const getWorkingVar =
    workingChat && options?.deferLiveChatSideEffects ? createLuaButtonWorkingGetVar(char, workingChat) : undefined
  const setWorkingVar =
    workingChat && options?.deferLiveChatSideEffects ? createLuaButtonWorkingSetVar(workingChat) : undefined
  const isFresh = (): boolean => isClientWriteOperationCurrent(clientOperation) && options?.isFresh?.() !== false

  try {
    const ownTriggers = (
      (char as { triggerscript?: triggerscript[]; lowLevelAccess?: boolean }).triggerscript ?? []
    ).map(
      (v): triggerscript => ({
        ...v,
        lowLevelAccess: char.type === 'simple' ? false : (char.lowLevelAccess ?? false),
      }),
    )
    const triggers = ownTriggers.concat(
      getModuleTriggers(char.type === 'character' ? { character: char, chat: workingChat } : undefined),
    )

    for (let trigger of triggers) {
      if (!isFresh()) {
        return null
      }
      if (trigger?.effect?.[0]?.type === 'triggerlua') {
        const moduleOwner = getModuleTriggerOwner(trigger)
        runResult = await awaitClientWriteOperation(
          clientOperation,
          runScripted(trigger.effect[0].code, {
            char: char,
            chat: workingChat,
            setVar: setWorkingVar,
            getVar: getWorkingVar,
            lowLevelAccess: trigger.lowLevelAccess,
            scriptModelOverrides: moduleOwner
              ? moduleOwner.scriptModelOverrides
              : char.type === 'simple'
                ? {}
                : char.scriptModelOverrides,
            mode: 'onButtonClick',
            data: data,
          }),
        )
        if (!isFresh()) {
          return null
        }
      }
    }
  } catch (error) {
    throw error
  }
  return runResult
}

function createLuaButtonWorkingSetVar(chat: Chat): (key: string, value: string) => boolean {
  return (key: string, value: string) => {
    chat.scriptstate ??= {}
    const stateKey = '$' + key
    if (chat.scriptstate[stateKey] === value) return false
    chat.scriptstate[stateKey] = value
    return true
  }
}

function createLuaButtonWorkingGetVar(char: character | simpleCharacterArgument, chat: Chat): (key: string) => string {
  return (key: string) => {
    const state = chat.scriptstate?.['$' + key]
    if (state !== undefined && state !== null) {
      return state.toString()
    }

    const defaultVariables =
      char.type === 'simple'
        ? parseKeyValue(scriptingSettings().templateDefaultVariables ?? '')
        : parseKeyValue(char.defaultVariables).concat(parseKeyValue(scriptingSettings().templateDefaultVariables ?? ''))
    const defaultVariable = defaultVariables.find((entry) => entry[0] === key)
    return defaultVariable?.[1] ?? 'null'
  }
}

class PyodideContext {
  private worker: Worker
  private apis: Record<string, (...args: any[]) => any> = {}
  private inited = false
  private initPromise: Promise<void> | null = null
  private closed = false
  private pending = new Map<
    string,
    {
      resolve: (result: unknown) => void
      reject: (error: Error) => void
    }
  >()

  constructor(
    private readonly execTimeoutMs: number,
    private readonly initTimeoutMs: number,
  ) {
    this.worker = new Worker(new URL('./pyworker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = this.handleMessage
    this.worker.onerror = (event) => {
      event.preventDefault()
      this.terminate(new Error(event.message || 'Python scripting worker failed.'))
    }
    this.worker.onmessageerror = () => {
      this.terminate(new Error('Python scripting worker returned an unreadable message.'))
    }
  }

  private error(error: unknown, fallback = 'Python scripting worker failed.'): Error {
    if (error instanceof Error) return error
    if (typeof error === 'string' && error) return new Error(error)
    return new Error(fallback)
  }

  private handleMessage = (event: MessageEvent<PyWorkerResponse>) => {
    const message = event.data
    if (message.type === 'call') {
      void this.handleHostCall(message)
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.type === 'result') {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error))
    }
  }

  private async handleHostCall(message: Extract<PyWorkerResponse, { type: 'call' }>) {
    const api = this.apis[message.method]
    if (!api) {
      this.postHostResponse({
        type: 'functionError',
        callId: message.callId,
        error: `Function ${message.method} not found`,
      })
      return
    }

    try {
      const result = await Promise.resolve(api(...message.args))
      this.postHostResponse({
        type: 'functionResult',
        callId: message.callId,
        result,
      })
    } catch (error) {
      this.postHostResponse({
        type: 'functionError',
        callId: message.callId,
        error: this.error(error).message,
      })
    }
  }

  private postHostResponse(message: Extract<PyWorkerRequest, { type: 'functionResult' | 'functionError' }>) {
    if (this.closed) return
    try {
      this.worker.postMessage(message)
    } catch (error) {
      this.terminate(this.error(error))
    }
  }

  private request<T>(message: Extract<PyWorkerRequest, { id: string }>, timeoutMs = this.execTimeoutMs): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('Python scripting worker is terminated.'))
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.terminate(new Error(`Python scripting worker timed out after ${timeoutMs}ms.`))
      }, timeoutMs)
      this.pending.set(message.id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result as T)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
      try {
        this.worker.postMessage(message)
      } catch (error) {
        this.terminate(this.error(error))
      }
    })
  }

  declareAPI(name: string, func: (...args: any[]) => any) {
    this.apis[name] = func
  }

  get isClosed(): boolean {
    return this.closed
  }

  async init(code: string) {
    if (this.inited) {
      return
    }
    this.initPromise ??= this.request(
      {
        type: 'init',
        code,
        id: createNonSecurityUuid(),
        moduleFunctions: Object.keys(this.apis),
      },
      this.initTimeoutMs,
    ).then(() => {
      this.inited = true
    })
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  async python(method: string, args: unknown[] = []) {
    return this.request({
      type: 'python',
      method,
      args,
      id: createNonSecurityUuid(),
    })
  }

  private terminate(error: Error) {
    if (this.closed) return
    this.closed = true
    this.worker.onmessage = null
    this.worker.onerror = null
    this.worker.onmessageerror = null
    try {
      this.worker.terminate()
    } finally {
      const pending = Array.from(this.pending.values())
      this.pending.clear()
      for (const request of pending) {
        request.reject(error)
      }
    }
  }

  close() {
    this.terminate(new Error('Python scripting worker is terminated.'))
  }
}

// Python has a browser worker of its own; close it immediately on authority
// loss as well as fencing every host callback and awaited engine result.
clientSessionStore.subscribe(() => {
  if (!isClientReadOnly()) return
  for (const state of ScriptingEngines.values()) {
    if (state.type === 'py') state.pyodide?.close()
  }
})
