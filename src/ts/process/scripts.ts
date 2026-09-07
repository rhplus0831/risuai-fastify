import {
  captureClientWriteOperation,
  assertClientWriteOperation,
  awaitClientWriteOperation,
} from '../clientWriteOperation'
import { get } from 'svelte/store'
import { CharEmotion, selectedCharID, VariableReloadGUIPointer } from '../stores.svelte'
import type { character, customscript, Database, Chat } from '../storage/database.svelte'
import { downloadFile } from '../globalApi.svelte'
import { alertError, alertNormal } from '../alert'
import { language } from 'src/lang'
import { selectSingleFile } from 'src/ts/filePicker'
import {
  assetRegex,
  type CbsConditions,
  risuChatParser as risuChatParserOrg,
  type simpleCharacterArgument,
} from '../parser/parser.svelte'
import { HypaProcesser } from './memory/hypamemory'
import { runLuaEditTrigger } from './scriptings'
import { pluginV2 } from '../plugins/plugins.svelte'
import { runTrigger } from './triggers'
import { canUseServerCommands } from '../server/commands'
import { currentChatScopedSnapshot, dispatchUpdateMessageScoped } from '../chatCommands'
import { getActivePromptPresetRegexScripts } from './promptPresetRegex'
import { registerScriptCacheResetter } from './scriptCacheInvalidation'
import {
  matchFirstClientRegex,
  normalizeClientRegexTimeout,
  replaceClientRegex,
  testClientRegex,
  testMoveClientRegex,
  testReplaceClientRegex,
} from './clientRegexWorker'
import { assertClientRegexPatternSafe } from './regexSafety'
import { regexOutputSizeLimitCodeUnits } from '@risuai/shared-core/regex-output-size-limit'
import { getSelectedCharacterOwner } from '../characterState'
import {
  collectionsResourceState,
  settingsResourceState,
  type ServerCollectionName,
} from '../server/resourceState.svelte'
import type { SettingsGroup } from '@risuai/shared-core/settings-groups'
import { resolveActiveModuleStates } from '../moduleActivation'

const dreg = /{{data}}/g
const randomness = /\|\|\|/g

function settingsGroupOwner(group: SettingsGroup): Partial<Database> | undefined {
  const status = settingsResourceState.groupStatuses[group] ?? 'idle'
  if (settingsResourceState.status === 'error' || status === 'error') return undefined
  if (status === 'ready') return settingsResourceState.value as Partial<Database>
  return undefined
}

function collectionOwner<Name extends ServerCollectionName>(name: Name): Database[Name] | undefined {
  const status = collectionsResourceState.statuses[name] ?? 'idle'
  if (collectionsResourceState.status === 'error' || status === 'error') return undefined
  if (status === 'ready') return collectionsResourceState.values[name] as Database[Name] | undefined
  return undefined
}

function standaloneSettingsOwner(): Partial<Database> | undefined {
  const status = settingsResourceState.standaloneStatuses.selectedPersonaId ?? 'idle'
  if (settingsResourceState.status === 'error' || status === 'error') return undefined
  if (status === 'ready') return settingsResourceState.value as Partial<Database>
  return undefined
}

function scriptSettings(): Partial<Database> {
  const advanced = settingsGroupOwner('advanced')
  const media = settingsGroupOwner('media')
  return {
    globalscript: advanced?.globalscript,
    complexRegexInputTimeoutMs: advanced?.complexRegexInputTimeoutMs,
    complexRegexOutputTimeoutMs: advanced?.complexRegexOutputTimeoutMs,
    complexRegexDisplayTimeoutMs: advanced?.complexRegexDisplayTimeoutMs,
    regexOutputSizeLimitMiB: advanced?.regexOutputSizeLimitMiB,
    dynamicAssets: media?.dynamicAssets,
    dynamicAssetsEditDisplay: media?.dynamicAssetsEditDisplay,
  }
}

function promptPresetDatabase(): Database {
  const prompt = settingsGroupOwner('prompt')
  return {
    presetRegex: prompt?.presetRegex ?? [],
    promptPresets: collectionOwner('promptPresets') ?? [],
  } as Database
}

function stableOwnerCollection<T extends { id?: unknown }>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = new Set<string>()
  for (const candidate of value) {
    const id = typeof candidate?.id === 'string' ? candidate.id.trim() : ''
    if (!id || ids.has(id)) return undefined
    ids.add(id)
  }
  return value as T[]
}

function moduleActivationDatabase(): Database | undefined {
  const moduleSettings = settingsGroupOwner('modules')
  const advancedSettings = settingsGroupOwner('advanced')
  const agentSettings = settingsGroupOwner('agents')
  const personaSelection = standaloneSettingsOwner()
  const modules = stableOwnerCollection<Database['modules'][number]>(collectionOwner('modules'))
  const promptPresets = stableOwnerCollection<Database['promptPresets'][number]>(collectionOwner('promptPresets'))
  const personas = stableOwnerCollection<Database['personas'][number]>(collectionOwner('personas'))
  const agentPresets = stableOwnerCollection<Database['agentPresets'][number]>(agentSettings?.agentPresets)
  const enabledModules = moduleSettings?.enabledModules
  if (
    !moduleSettings ||
    !advancedSettings ||
    !agentSettings ||
    !personaSelection ||
    !modules ||
    !promptPresets ||
    !personas ||
    !agentPresets ||
    !Array.isArray(enabledModules) ||
    !enabledModules.every((id) => typeof id === 'string' && id.trim().length > 0)
  ) {
    return undefined
  }

  return {
    modules,
    promptPresets,
    personas,
    enabledModules,
    moduleIntergration: advancedSettings.moduleIntergration,
    agentPresets,
    agentPresetDefaultId: agentSettings.agentPresetDefaultId,
    selectedPersonaId: personaSelection.selectedPersonaId,
  } as Database
}

export type ScriptMode = 'editinput' | 'editoutput' | 'editprocess' | 'editdisplay'

type pScript = {
  script: customscript
  order: number
  actions: string[]
}

function isProcessableCustomScript(script: unknown): script is customscript {
  return (
    !!script &&
    typeof script === 'object' &&
    !Array.isArray(script) &&
    typeof (script as Partial<customscript>).type === 'string' &&
    typeof (script as Partial<customscript>).in === 'string' &&
    typeof (script as Partial<customscript>).out === 'string'
  )
}

function getProcessableCustomScripts(scripts: unknown): customscript[] {
  return Array.isArray(scripts) ? scripts.filter(isProcessableCustomScript) : []
}

export async function processScript(
  char: character,
  data: string,
  mode: ScriptMode,
  cbsConditions: CbsConditions = {},
) {
  return (await processScriptFull(char, data, mode, -1, cbsConditions)).data
}

export function exportRegex(s?: customscript[]) {
  const script = s ?? scriptSettings().globalscript ?? []
  const data = Buffer.from(
    JSON.stringify({
      type: 'regex',
      data: script,
    }),
    'utf-8',
  )
  downloadFile(`regexscript_export.json`, data)
  alertNormal(language.successExport)
}

type RegexImportFilePicker = typeof selectSingleFile

export async function importRegexRows(
  selectFile: RegexImportFilePicker = selectSingleFile,
): Promise<customscript[] | null> {
  let selected: Awaited<ReturnType<typeof selectSingleFile>>
  try {
    selected = await selectFile(['json'])
  } catch (error) {
    alertError(error)
    return null
  }

  if (!selected?.data) {
    return null
  }

  try {
    const filedata = selected.data
    const imported = JSON.parse(Buffer.from(filedata).toString('utf-8'))
    if (imported.type === 'regex' && Array.isArray(imported.data)) {
      const rows = normalizeImportedRegexRows(imported.data)
      if (rows) return rows
    }

    alertError(language.errors.noData)
  } catch (error) {
    alertError(error)
  }

  return null
}

function normalizeImportedRegexRows(rows: unknown[]): customscript[] | null {
  const normalized: customscript[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null
    const source = row as Record<string, unknown>
    const comment = source.comment ?? ''
    const input = source.in ?? ''
    const output = source.out ?? ''
    const type = source.type ?? 'editinput'

    if (
      typeof comment !== 'string' ||
      typeof input !== 'string' ||
      typeof output !== 'string' ||
      typeof type !== 'string'
    ) {
      return null
    }
    if (source.id != null && typeof source.id !== 'string') return null
    if (source.flag != null && typeof source.flag !== 'string') return null
    if (source.ableFlag != null && typeof source.ableFlag !== 'boolean') return null

    const next = { ...source, comment, in: input, out: output, type } as unknown as customscript
    if (source.id == null) delete next.id
    if (source.flag == null) delete next.flag
    if (source.ableFlag == null) delete next.ableFlag
    normalized.push(next)
  }
  return normalized
}

export async function importRegex(
  o?: customscript[],
  selectFile: RegexImportFilePicker = selectSingleFile,
): Promise<customscript[]> {
  const rows = await importRegexRows(selectFile)
  if (!rows || rows.length === 0) {
    return o ?? []
  }

  return [...(o ?? []), ...rows]
}

const BEST_MATCH_CACHE_LIMIT = 1000

let bestMatchCache = new Map<string, string>()
let processScriptCache = new Map<string, string>()

function generateScriptCacheKey(
  scripts: customscript[],
  data: string,
  mode: ScriptMode,
  chatID = -1,
  cbsConditions: CbsConditions = {},
  cacheScope = '',
  sizeLimit = regexOutputSizeLimitCodeUnits(undefined),
) {
  return JSON.stringify([
    'process-script-cache-v2',
    data,
    mode,
    cacheScope,
    sizeLimit,
    chatID,
    scripts
      .filter((script) => script.type === mode)
      .map((script) => [
        script.flag?.includes('<cbs>') ? risuChatParser(script.in, { chatID, cbsConditions }) : script.in,
        script.out,
        script.flag ?? '',
        script.ableFlag === true,
      ]),
  ])
}

function cacheScript(hash: string, result: string) {
  processScriptCache.set(hash, result)

  if (processScriptCache.size > 1000) {
    processScriptCache.delete(processScriptCache.keys().next().value)
  }
}

function getScriptCache(hash: string) {
  return processScriptCache.get(hash)
}

// Exported for render-cache regression tests; not part of the public API.
export function hasProcessScriptCacheEntryForTesting(
  scripts: customscript[],
  data: string,
  mode: ScriptMode,
  chatID = -1,
  cbsConditions: CbsConditions = {},
) {
  return processScriptCache.has(
    generateScriptCacheKey(
      scripts,
      data,
      mode,
      chatID,
      cbsConditions,
      currentScriptCacheScope(mode),
      regexOutputSizeLimitCodeUnits(scriptSettings().regexOutputSizeLimitMiB),
    ),
  )
}

function currentScriptCacheScope(mode: ScriptMode, activeChat?: Chat) {
  if (mode !== 'editdisplay') return ''
  try {
    const chat = activeChat ?? getSelectedCharacterOwner()?.chats?.[getSelectedCharacterOwner()?.chatPage ?? -1]
    return JSON.stringify({
      selectedChar: get(selectedCharID),
      chatId: chat?.id,
      scriptstate: chat?.scriptstate ?? null,
      variableReloadEpoch: get(VariableReloadGUIPointer),
    })
  } catch {
    return JSON.stringify({
      selectedChar: get(selectedCharID),
      chatId: null,
      scriptstate: null,
      variableReloadEpoch: get(VariableReloadGUIPointer),
    })
  }
}

function cacheBestMatch(cacheKey: string, bestMatch: string) {
  bestMatchCache.delete(cacheKey)
  bestMatchCache.set(cacheKey, bestMatch)

  if (bestMatchCache.size > BEST_MATCH_CACHE_LIMIT) {
    const oldestKey = bestMatchCache.keys().next().value
    if (oldestKey !== undefined) {
      bestMatchCache.delete(oldestKey)
    }
  }
}

function getBestMatch(cacheKey: string) {
  const cached = bestMatchCache.get(cacheKey)
  if (cached !== undefined) {
    bestMatchCache.delete(cacheKey)
    bestMatchCache.set(cacheKey, cached)
  }
  return cached
}

// Exported for the best-match cache regression tests; not part of the public API.
export function cacheBestMatchForTesting(cacheKey: string, bestMatch: string) {
  cacheBestMatch(cacheKey, bestMatch)
}

export function getBestMatchForTesting(cacheKey: string) {
  return getBestMatch(cacheKey)
}

export function getBestMatchCacheSizeForTesting() {
  return bestMatchCache.size
}

function selectedChatMessage(chat: Chat | undefined, chatID: number) {
  return chat?.message?.[chatID]
}

function applyInjectMutation(data: string, mode: ScriptMode, chatID: number, chat: Chat | undefined) {
  if (mode === 'editdisplay' || chatID === -1) return

  if (canUseServerCommands()) {
    const messageId = selectedChatMessage(chat, chatID)?.chatId
    if (!messageId) return

    const previous = currentChatScopedSnapshot()
    dispatchUpdateMessageScoped(messageId, { data }, previous)
  }
}

// Regex-script sources are constant across the per-token streaming re-runs that
// miss the script cache, so compiling `new RegExp(source, flag)` on every
// `executeScript` is pure waste. Memoize the compiled regex keyed by its source
// and flags. The cached instance's only mutable state is `lastIndex`, which we
// reset on every retrieval so a reused (possibly global/sticky) regex behaves
// exactly like a freshly compiled one.
let compiledRegexCache = new Map<string, RegExp>()

// Exported for the regex-cache regression test; not part of the public API.
export function getCompiledRegex(source: string, flag: string): RegExp {
  const key = `${flag}|||${source}`
  let reg = compiledRegexCache.get(key)
  if (!reg) {
    assertClientRegexPatternSafe(source)
    reg = new RegExp(source, flag)
    compiledRegexCache.set(key, reg)
    if (compiledRegexCache.size > 1000) {
      compiledRegexCache.delete(compiledRegexCache.keys().next().value)
    }
  }
  reg.lastIndex = 0
  return reg
}

export function resetScriptCache() {
  bestMatchCache = new Map()
  processScriptCache = new Map()
  compiledRegexCache = new Map()
}

registerScriptCacheResetter(resetScriptCache)

export async function processScriptFull(
  char: character | simpleCharacterArgument,
  data: string,
  mode: ScriptMode,
  chatID = -1,
  cbsConditions: CbsConditions = {},
) {
  const clientOperation = captureClientWriteOperation()

  const db = scriptSettings()
  let emoChanged = false
  const activeCharacter = char.type === 'character' ? char : getSelectedCharacterOwner()
  const currentChat = activeCharacter?.chats?.[activeCharacter.chatPage]
  data = await awaitClientWriteOperation(clientOperation, runLuaEditTrigger(char, mode, data, { index: chatID }))

  if (mode === 'editdisplay') {
    if (activeCharacter && currentChat) {
      try {
        const d = await awaitClientWriteOperation(
          clientOperation,
          runTrigger(activeCharacter, 'display', {
            chat: currentChat,
            displayMode: true,
            displayData: data,
          }),
        )

        data = d?.displayData ?? data
      } catch (e) {
        assertClientWriteOperation(clientOperation)
        console.error(e)
      }
    }
  }

  if (pluginV2[mode].size > 0) {
    for (const plugin of pluginV2[mode]) {
      const res = await awaitClientWriteOperation(clientOperation, plugin(data))
      if (res !== null && res !== undefined) {
        data = res
      }
    }
  }

  data = risuChatParser(data, { chatID: chatID, cbsConditions })
  const moduleDatabase = moduleActivationDatabase()
  const activeModules = moduleDatabase ? resolveActiveModuleStates(moduleDatabase, activeCharacter, currentChat) : []
  const scripts = getProcessableCustomScripts(db.globalscript)
    .concat(getProcessableCustomScripts(getActivePromptPresetRegexScripts(promptPresetDatabase(), currentChat)))
    .concat(getProcessableCustomScripts((char as { customscript?: unknown }).customscript))
    .concat(getProcessableCustomScripts(activeModules.flatMap(({ module }) => module.regex ?? [])))
  const regexSizeLimit = regexOutputSizeLimitCodeUnits(db.regexOutputSizeLimitMiB)
  const hash = generateScriptCacheKey(
    scripts,
    data,
    mode,
    chatID,
    cbsConditions,
    currentScriptCacheScope(mode, currentChat),
    regexSizeLimit,
  )
  const cached = getScriptCache(hash)
  if (cached) {
    return { data: cached, emoChanged: false }
  }

  if (scripts.length === 0) {
    cacheScript(hash, data)
    return { data, emoChanged }
  }
  const regexTimeout = normalizeClientRegexTimeout(
    mode === 'editoutput'
      ? db.complexRegexOutputTimeoutMs
      : mode === 'editdisplay'
        ? db.complexRegexDisplayTimeoutMs
        : db.complexRegexInputTimeoutMs,
  )

  async function executeScript(pscript: pScript) {
    const script = pscript.script

    if (script.in === '') {
      return
    }

    if (script.type === mode) {
      let outScript2 = script.out.replaceAll('$n', '\n')
      let outScript = outScript2.replace(dreg, '$&')
      let flag = 'g'
      if (script.ableFlag) {
        flag = script.flag || 'g'
      }
      if (
        outScript.startsWith('@@move_top') ||
        outScript.startsWith('@@move_bottom') ||
        pscript.actions.includes('move_top') ||
        pscript.actions.includes('move_bottom')
      ) {
        flag = flag.replace('g', '')
      }
      if (outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')) {
        outScript += '\n'
      }
      //remove unsupported flag
      flag = flag.trim().replace(/[^dgimsuvy]/g, '')

      //remove repeated flags
      flag = flag
        .split('')
        .filter((v, i, a) => a.indexOf(v) === i)
        .join('')

      if (flag.length === 0) {
        flag = 'u'
      }

      let input = script.in
      if (pscript.actions.includes('cbs')) {
        input = risuChatParser(input, { chatID: chatID, cbsConditions })
      }

      if (outScript.startsWith('@@') || pscript.actions.length > 0) {
        let matched = false
        if (outScript.startsWith('@@emo ')) {
          matched = await awaitClientWriteOperation(clientOperation, testClientRegex(input, flag, data, regexTimeout))
          if (matched) {
            const emoName = script.out.substring(6).trim()
            let charemotions = get(CharEmotion)
            let tempEmotion = charemotions[char.chaId]
            if (!tempEmotion) {
              tempEmotion = []
            }
            if (tempEmotion.length > 4) {
              tempEmotion.splice(0, 1)
            }
            if (char.type !== 'simple') {
              for (const emo of char.emotionImages) {
                if (emo[0] === emoName) {
                  const emos: [string, string, number] = [emo[0], emo[1], Date.now()]
                  tempEmotion.push(emos)
                  charemotions[char.chaId] = tempEmotion
                  CharEmotion.set(charemotions)
                  emoChanged = true
                  break
                }
              }
            }
          }
        } else if (outScript.startsWith('@@inject') || pscript.actions.includes('inject')) {
          const replaced = await awaitClientWriteOperation(
            clientOperation,
            testReplaceClientRegex(input, flag, data, '', regexTimeout, regexSizeLimit),
          )
          matched = replaced.matched
          if (matched) {
            applyInjectMutation(data, mode, chatID, currentChat)
            data = replaced.result
          }
        } else {
          const isMove =
            outScript.startsWith('@@move_top') ||
            outScript.startsWith('@@move_bottom') ||
            pscript.actions.includes('move_top') ||
            pscript.actions.includes('move_bottom')
          if (isMove) {
            const moved = await awaitClientWriteOperation(
              clientOperation,
              testMoveClientRegex(
                input,
                flag,
                data,
                outScript,
                outScript.startsWith('@@move_top') || pscript.actions.includes('move_top'),
                regexTimeout,
                regexSizeLimit,
              ),
            )
            matched = moved.matched
            if (matched) data = moved.result
          } else {
            const replaced = await awaitClientWriteOperation(
              clientOperation,
              testReplaceClientRegex(input, flag, data, outScript, regexTimeout, regexSizeLimit),
            )
            matched = replaced.matched
            if (matched) {
              data = risuChatParser(replaced.result, { chatID: chatID, cbsConditions })
            }
          }
        }

        if (
          !matched &&
          (outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back')) &&
          chatID !== -1
        ) {
          const v = outScript.split(' ', 2)[1]
          const selchar = char.type === 'character' ? char : getSelectedCharacterOwner()
          const chat = currentChat
          if (!selchar || !chat) return
          let lastChat = chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex]
          let pointer = chatID - 1
          while (pointer >= 0) {
            if (chat.message[pointer].role === chat.message[chatID].role) {
              lastChat = chat.message[pointer].data
              break
            }
            pointer--
          }

          const repeatMatch = await awaitClientWriteOperation(
            clientOperation,
            matchFirstClientRegex(input, flag, lastChat, regexTimeout),
          )
          if (!repeatMatch) return
          switch (v) {
            case 'start':
              data = repeatMatch + data
              break
            case 'end_nl':
              data = data + '\n' + repeatMatch
              break
            case 'start_nl':
              data = repeatMatch + '\n' + data
              break
            default:
              data = data + repeatMatch
          }
        }
      } else {
        const replaced = await awaitClientWriteOperation(
          clientOperation,
          replaceClientRegex(input, flag, data, outScript, regexTimeout, regexSizeLimit),
        )
        data = risuChatParser(replaced, { chatID: chatID, cbsConditions })
      }
    }
  }

  let parsedScripts: pScript[] = []
  let orderChanged = false
  for (const script of scripts) {
    if (script.ableFlag && script.flag?.includes('<')) {
      const rregex = /<(.+?)>/g
      const scriptData = safeStructuredClone(script)
      let order = 0
      const actions: string[] = []
      scriptData.flag = scriptData.flag?.replace(rregex, (v: string, p1: string) => {
        const meta = p1.split(',').map((v) => v.trim())
        for (const m of meta) {
          if (m.startsWith('order ')) {
            order = parseInt(m.substring(6))
            orderChanged = true
          } else {
            actions.push(m)
          }
        }

        return ''
      })
      parsedScripts.push({
        script: scriptData,
        order,
        actions,
      })
      continue
    }
    parsedScripts.push({
      script,
      order: 0,
      actions: [],
    })
  }

  if (orderChanged) {
    parsedScripts.sort((a, b) => b.order - a.order) //sort by order
  }
  for (const script of parsedScripts) {
    try {
      await awaitClientWriteOperation(clientOperation, executeScript(script))
    } catch (error) {
      assertClientWriteOperation(clientOperation)
      console.error(error)
    }
  }

  if (
    db.dynamicAssets &&
    (char.type === 'simple' || char.type === 'character') &&
    char.additionalAssets &&
    char.additionalAssets.length > 0
  ) {
    if ((!db.dynamicAssetsEditDisplay && mode === 'editdisplay') || mode === 'editinput' || mode === 'editprocess') {
      cacheScript(hash, data)
      return { data, emoChanged }
    }
    const assetNames = char.additionalAssets.map((v) => v[0])

    const moduleAssets = activeModules.flatMap(({ module }) => module.assets ?? [])
    if (moduleAssets.length > 0) {
      for (const asset of moduleAssets) {
        assetNames.push(asset[0])
      }
    }

    const processer = new HypaProcesser()
    await awaitClientWriteOperation(clientOperation, processer.addText(assetNames))
    const matches = data.matchAll(assetRegex)

    for (const match of matches) {
      const type = match[1]
      const assetName = match[2]
      const cacheKey = char.chaId + '::' + assetName
      if (type !== 'emotion' && type !== 'source') {
        const cachedBestMatch = getBestMatch(cacheKey)
        if (cachedBestMatch !== undefined) {
          data = data.replaceAll(match[0], `{{${type}::${cachedBestMatch}}}`)
        } else if (!assetNames.includes(assetName)) {
          const searched = await awaitClientWriteOperation(clientOperation, processer.similaritySearch(assetName))
          const bestMatch = searched[0]
          if (bestMatch) {
            data = data.replaceAll(match[0], `{{${type}::${bestMatch}}}`)
            cacheBestMatch(cacheKey, bestMatch)
          }
        }
      }
    }
  }

  cacheScript(hash, data)

  return { data, emoChanged }
}

const rgx = /(?:{{|<)(.+?)(?:}}|>)/gm
export const risuChatParser = risuChatParserOrg
