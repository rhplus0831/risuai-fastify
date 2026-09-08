import { captureClientSessionGeneration, isClientReadOnly, isClientSessionGenerationCurrent } from '../clientSession'
import DOMPurify from 'dompurify'
import {
  getReaderNavigationSettings,
  getReaderModuleDisplayDatabase,
  getReaderTranscriptPersona,
} from '../server/readerTranscriptProjection.svelte'
import markdownit from 'markdown-it'
import { sha256Hex } from '../sha256Fallback'
import {
  type Chat,
  type Database,
  type character,
  type customscript,
  type loreBook,
  type triggerscript,
} from '../storage/database.svelte'
import versionInfo from '../../../version.json'
import { CurrentTriggerIdStore } from '../stores.svelte'
import { aiWatermarkingLawApplies, getFileSrc } from '../globalApi.svelte'
import './chatVar.svelte' // side effect: registers the browser chatVar backend
import { getChatVar, setChatVar, getGlobalChatVar } from './chatVarBackend'
import { processScriptFull } from '../process/scripts'
import {
  markReaderDisplayLimited,
  requestServerDisplaySource,
  type DisplaySourcePriority,
} from '../server/displaySources'
import type { DisplaySourceLayer } from '@risuai/protocol/display-source'
import { get } from 'svelte/store'
import css, { type CssAtRuleAST } from '@adobe/css-tools'
import { calcString } from '../process/infunctions'
import { safeStructuredClone } from '../polyfill'
import { pickHashRand, replaceAsync } from '../util'
import { getPersonaPrompt, getUserIcon, getUserName, resolveUserPersonaPresentation } from '../utilState'
import { getInlayAssetBlob, type InlayAsset } from '../process/files/inlays'
import type { RisuModule } from '../process/modules'
import { captureModuleRenderRevision } from '../moduleRenderRevision'
import { resolveActiveModuleStates } from '../moduleActivation'
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/atom-one-dark.min.css'
import { language } from 'src/lang'
import katex from 'katex'
import { getModelInfo } from '../model/modellist'
import { resolveModelProfile } from '../model/modelProfileResolver'
import cssSelectorParser from 'postcss-selector-parser'
import {
  registerRisuChatParserCBS,
  risuChatParser as risuChatParserImpl,
  type RisuChatParserArg,
  type matcherArg,
} from './risuChatParser'
import {
  dateTimeFormat,
  makeArray,
  parseArray,
  parseDict,
  risuEscape,
  risuUnescape,
  type CbsConditions,
} from './risuChatParserHelpers'
import { insertSentenceParagraphBreaks } from './sentenceBreaks'
import {
  SERVER_COLLECTION_NAMES,
  charactersResourceState,
  collectionsResourceState,
  getCharacterResourceOwner,
  getChatMetadataOwnerSnapshot,
  getChatScriptstateOwnerSnapshot,
  settingsResourceState,
  type ServerResourceStatus,
} from '../server/resourceState.svelte'
import { getChatMessageOwnerState } from '../server/chatMessageHydration.svelte'
import { SERVER_SETTINGS_GROUP_BY_KEY } from '../server/settingsGroups'
import { SERVER_STANDALONE_SETTING_NAMES } from '@risuai/protocol/standalone-settings'
import { displaySettingForPaint } from '../gui/displaySettings'
import { AssetCollectionIndexCache, type AssetNameIndex } from './assetCollectionIndex'

export { dateTimeFormat, makeArray, parseArray, parseDict, risuEscape, risuUnescape }
export type { CbsConditions }

export function risuChatParser(da: string, arg?: RisuChatParserArg | matcherArg): string {
  return risuChatParserImpl(da, arg)
}

const markdownItOptions = {
  html: true,
  breaks: true,
  linkify: false,
  typographer: true,
  quotes: '\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}', //placeholder characters to convert to real quotes
}

const md = markdownit(markdownItOptions)
const mdHighlight = markdownit({
  highlight: function (str, lang) {
    if (lang) {
      return `<pre-hljs-placeholder lang="${lang}">` + str + '</pre-hljs-placeholder>'
    }
    return ''
  },
  ...markdownItOptions,
})

md.disable(['code'])
mdHighlight.disable(['code'])

function nonBlankStableId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function uniqueCharacterOwner(characters: readonly character[], characterId: string): character | undefined {
  let owner: character | undefined
  for (const candidate of characters) {
    if (candidate?.chaId !== characterId) continue
    if (owner) return undefined
    owner = candidate
  }
  return owner
}

function selectedCharacterOwner(characters: readonly character[], selectedIndex: number): character | undefined {
  const candidate = characters[selectedIndex]
  return nonBlankStableId(candidate?.chaId) && uniqueCharacterOwner(characters, candidate.chaId) === candidate
    ? candidate
    : undefined
}

function uniqueChatOwner(
  characters: readonly character[],
  selectedCharacter: character,
  chatId: string,
): Chat | undefined {
  let owner: { character: character; chat: Chat } | undefined
  for (const characterOwner of characters) {
    for (const chatOwner of characterOwner.chats ?? []) {
      if (chatOwner?.id !== chatId) continue
      if (owner) return undefined
      owner = { character: characterOwner, chat: chatOwner }
    }
  }
  return owner?.character === selectedCharacter ? owner.chat : undefined
}

function selectedChatOwner(characters: readonly character[], characterOwner: character): Chat | undefined {
  const candidate = characterOwner.chats?.[characterOwner.chatPage]
  const owner = nonBlankStableId(candidate?.id) ? uniqueChatOwner(characters, characterOwner, candidate.id) : undefined
  return owner && transcriptHasUniqueStableIds(owner.message ?? []) ? owner : undefined
}

function transcriptHasUniqueStableIds(messages: readonly { chatId?: unknown }[]): boolean {
  const messageIds = new Set<string>()
  for (const message of messages) {
    if (!nonBlankStableId(message?.chatId) || messageIds.has(message.chatId)) return false
    messageIds.add(message.chatId)
  }
  return true
}

function readySelectedCharacterOwner(): character | undefined {
  if (charactersResourceState.status !== 'ready') return undefined
  const candidate = selectedCharacterOwner(charactersResourceState.characters, charactersResourceState.currentChar)
  if (!candidate?.chaId) return undefined
  return getCharacterResourceOwner(candidate.chaId) === candidate ? candidate : undefined
}

function readyChatOwner(characterOwner: character, chatId: string): Chat | undefined {
  const chatOwner = uniqueChatOwner(charactersResourceState.characters, characterOwner, chatId)
  if (!chatOwner?.id || !characterOwner.chaId) return undefined
  const metadataOwner = getChatMetadataOwnerSnapshot(characterOwner.chaId, chatOwner.id)
  const scriptstateOwner = getChatScriptstateOwnerSnapshot(characterOwner.chaId, chatOwner.id)
  const transcriptOwner = getChatMessageOwnerState(chatOwner.id)
  if (
    !metadataOwner ||
    !scriptstateOwner ||
    !transcriptOwner ||
    !transcriptHasUniqueStableIds(transcriptOwner.messages)
  )
    return undefined

  return {
    ...chatOwner,
    ...metadataOwner.metadata,
    message: transcriptOwner.messages,
    scriptstate: scriptstateOwner.scriptstate,
  } as Chat
}

function readySelectedChatOwner(characterOwner: character): Chat | undefined {
  const candidate = characterOwner.chats?.[characterOwner.chatPage]
  if (!nonBlankStableId(candidate?.id)) return undefined
  return readyChatOwner(characterOwner, candidate.id)
}

function parserSelectedContext(): { character: character; chat?: Chat } | undefined {
  if (charactersResourceState.status !== 'ready') return undefined
  const characterOwner = readySelectedCharacterOwner()
  if (!characterOwner) return undefined
  return { character: characterOwner, chat: readySelectedChatOwner(characterOwner) }
}

function parserSelectedCharacterIndex(): number {
  return charactersResourceState.status === 'ready' && readySelectedCharacterOwner()
    ? charactersResourceState.currentChar
    : -1
}

function parserCharacterOwnerById(characterId: string): character | undefined {
  const normalizedCharacterId = characterId.trim()
  if (!normalizedCharacterId) return undefined
  return charactersResourceState.status === 'ready' ? getCharacterResourceOwner(normalizedCharacterId) : undefined
}

function parserChatOwnerById(characterId: string, chatId: string): Chat | undefined {
  const normalizedCharacterId = characterId.trim()
  const normalizedChatId = chatId.trim()
  if (!normalizedCharacterId || !normalizedChatId) return undefined
  if (charactersResourceState.status === 'ready') {
    const characterOwner = getCharacterResourceOwner(normalizedCharacterId)
    return characterOwner ? readyChatOwner(characterOwner, normalizedChatId) : undefined
  }
  return undefined
}

function projectSelectedCharacter(
  characters: readonly character[],
  selectedIndex: number,
  context: { character: character; chat?: Chat } | undefined,
): character[] {
  if (!context || characters[selectedIndex] !== context.character) return []
  if (!context.chat) {
    return characters.map((characterOwner, index) =>
      index === selectedIndex ? { ...characterOwner, chats: [] } : characterOwner,
    )
  }
  const selectedChatIndex = context.character.chats?.findIndex((chatOwner) => chatOwner.id === context.chat?.id) ?? -1
  if (selectedChatIndex < 0) {
    return characters.map((characterOwner, index) =>
      index === selectedIndex ? { ...characterOwner, chats: [] } : characterOwner,
    )
  }
  const chats = context.character.chats?.map((chatOwner, index) =>
    index === selectedChatIndex ? context.chat! : chatOwner,
  )
  return characters.map((characterOwner, index) =>
    index === selectedIndex ? { ...characterOwner, chats: chats ?? [] } : characterOwner,
  )
}

const standaloneSettingNames = new Set<string>(SERVER_STANDALONE_SETTING_NAMES)

function parserSettingOwnerStatus(key: keyof Database): ServerResourceStatus {
  if (settingsResourceState.status === 'error') return 'error'
  const group = SERVER_SETTINGS_GROUP_BY_KEY[String(key)]
  if (group) {
    return settingsResourceState.groupStatuses[group] ?? 'idle'
  }
  if (standaloneSettingNames.has(String(key))) {
    return (
      settingsResourceState.standaloneStatuses[key as keyof typeof settingsResourceState.standaloneStatuses] ?? 'idle'
    )
  }
  return settingsResourceState.status
}

function parserSettingsProjection(): Partial<Database> {
  if (isClientReadOnly()) return { ...getReaderNavigationSettings(), ...getReaderTranscriptPersona() }
  if (settingsResourceState.status === 'error') return {}
  const ownerValues = settingsResourceState.value as Partial<Database>
  const settings: Partial<Database> = {}
  for (const key of Object.keys(ownerValues) as (keyof Database)[]) {
    if (parserSettingOwnerStatus(key) === 'ready') settings[key] = ownerValues[key] as never
  }
  return settings
}

function parserRuntimeDatabase(): Database {
  const database = parserSettingsProjection()
  if (isClientReadOnly())
    return {
      ...database,
      ...getReaderModuleDisplayDatabase(),
      characters: [],
    } as Database

  for (const collectionName of SERVER_COLLECTION_NAMES) {
    const status = collectionsResourceState.statuses[collectionName]
    if (status === 'ready') {
      database[collectionName] = collectionsResourceState.values[collectionName] as never
    } else {
      delete database[collectionName]
    }
  }

  if (charactersResourceState.status === 'ready') {
    database.characters = projectSelectedCharacter(
      charactersResourceState.characters,
      charactersResourceState.currentChar,
      parserSelectedContext(),
    )
  } else {
    database.characters = []
  }

  database.modules ??= []
  database.promptPresets ??= []
  database.personas ??= []
  database.agentPresets ??= []
  database.enabledModules ??= []
  return database as Database
}

function parserSetting<K extends keyof Database>(key: K): Database[K] | undefined {
  if (isClientReadOnly()) return getReaderNavigationSettings()[key] as Database[K] | undefined
  const status = parserSettingOwnerStatus(key)
  if (status === 'ready') {
    return (settingsResourceState.value as Partial<Database>)[key] as Database[K] | undefined
  }
  return undefined
}

function parserModules(context = parserSelectedContext()): RisuModule[] {
  return resolveActiveModuleStates(parserRuntimeDatabase(), context?.character, context?.chat).map(
    (state) => state.module as RisuModule,
  )
}

function parserModuleLorebooks(): loreBook[] {
  return parserModules().flatMap((moduleOwner) => moduleOwner.lorebook ?? [])
}

function parserModuleOwners(context: { character: character | undefined; chat: Chat | undefined }) {
  return resolveActiveModuleStates(parserRuntimeDatabase(), context.character, context.chat).map(
    (state) => state.module as RisuModule,
  )
}

registerRisuChatParserCBS({
  getDatabase: parserRuntimeDatabase,
  getUserName: getUserName,
  getPersonaPrompt: getPersonaPrompt,
  risuChatParser: risuChatParser,
  makeArray: makeArray,
  safeStructuredClone: safeStructuredClone,
  parseArray: parseArray,
  parseDict: parseDict,
  getChatVar: getChatVar,
  setChatVar: setChatVar,
  getGlobalChatVar: getGlobalChatVar,
  calcString: calcString,
  dateTimeFormat: dateTimeFormat,
  getModules: parserModules,
  getModuleLorebooks: parserModuleLorebooks,
  pickHashRand: pickHashRand,
  getSelectedCharID: parserSelectedCharacterIndex,
  getModelInfo: getModelInfo,
  getModelContext: (role) => {
    const profile = resolveModelProfile({ database: parserRuntimeDatabase(), role })
    return {
      modelId: profile.modelId,
      requestModel: profile.requestModel,
      modelInfo: profile.modelInfo,
      maxContext: profile.runtimeOptions.maxContext,
    }
  },
  callInternalFunction: function (args: string[]): string {
    return ''
  },
  isMobile: false,
  appVer: versionInfo.version,
  getCurrentTriggerId: () => get(CurrentTriggerIdStore) ?? 'null',
  getScreenWidth: () => window.innerWidth.toString(),
  getScreenHeight: () => window.innerHeight.toString(),
  getBrowserLanguage: () => navigator.language,
})

DOMPurify.addHook('uponSanitizeElement', (node: HTMLElement, data) => {
  if (data.tagName === 'iframe') {
    const src = node.getAttribute('src') || ''
    if (!src.startsWith('https://www.youtube.com/embed/')) {
      return node.parentNode.removeChild(node)
    }
  }
  if (data.tagName === 'img') {
    // Hide external images when hideAllImages is enabled
    if (parserSetting('hideAllImages')) {
      const src = node.getAttribute('src') || ''
      // Replace with placeholder if it's an external/loaded image
      if (src && !src.startsWith('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP')) {
        node.setAttribute('src', '/none.webp')
        node.setAttribute('alt', '?')
      }
      return
    }

    const loading = node.getAttribute('loading')
    if (!loading) {
      node.setAttribute('loading', 'lazy')
    }
    const decoding = node.getAttribute('decoding')
    if (!decoding) {
      node.setAttribute('decoding', 'async')
    }
  }
})

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  switch (data.attrName) {
    case 'style': {
      // Remove background-image URLs when hideAllImages is enabled
      if (parserSetting('hideAllImages') && data.attrValue) {
        // Remove background-image property from inline styles
        data.attrValue = data.attrValue.replace(/background(-image)?:\s*url\([^)]*\);?/gi, '')
        // Also remove background property if it contains url()
        data.attrValue = data.attrValue.replace(/background:\s*[^;]*url\([^)]*\)[^;]*;?/gi, '')
      }
      break
    }
    case 'class': {
      if (data.attrValue) {
        data.attrValue = data.attrValue
          .split(' ')
          .map((v) => {
            if (v.startsWith('hljs')) {
              return v
            }
            if (v.startsWith('x-risu-')) {
              return v
            }
            return 'x-risu-' + v
          })
          .join(' ')
      }
      break
    }
    case 'href': {
      if (data.attrValue.startsWith('http://') || data.attrValue.startsWith('https://')) {
        node.setAttribute('target', '_blank')
        break
      }
      data.attrValue = ''
      break
    }
  }
})

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (['IMG', 'SOURCE', 'VIDEO', 'AUDIO', 'STYLE'].includes(node.nodeName) && data.attrName === 'src') {
    if (data.attrValue.startsWith('blob:')) {
      data.forceKeepAttr = true
    }
  }
})

function renderMarkdown(md: markdownit, data: string) {
  const customQuotes = parserSetting('customQuotes')
  const customQuotesData = parserSetting('customQuotesData')
  const unformatQuotes = parserSetting('unformatQuotes')
  const blockquoteStyling = parserSetting('blockquoteStyling')
  let quotes = ['“', '”', '‘', '’']
  if (customQuotes) {
    quotes = customQuotesData ?? quotes
  }
  data = data.replace(/\$\$(.*?)\$\$/gs, (match: string, content: string) => {
    try {
      content = content
        .replace(/\uE9b8/gu, '{')
        .replace(/\uE9b9/gu, '}')
        .replace(/\uE9ba/gu, '(')
        .replace(/\uE9bb/gu, ')')
      const rendered = katex.renderToString(content, {
        displayMode: false,
        throwOnError: true,
        output: 'mathml',
      })
      return rendered
    } catch (error) {
      console.error('KaTeX render error:', error)
      return match
    }
  })
  let text = risuUnescape(md.render(data.replace(/“|”/g, '"').replace(/‘|’/g, "'")))

  if (unformatQuotes) {
    text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1])
    text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3])
  } else if (blockquoteStyling) {
    text = text
      .replace(/\uE9b0(.+?)\uE9b1/gmu, (full, content) => {
        content = content
          .replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2])
          .replace(/\uE9b3/gu, quotes[3] + '</mark>')
        return `<br><br><mark risu-mark="blockquote2">${quotes[0]}${content}${quotes[1]}</mark><br><br>`
      })
      .replace(/\uE9b2(.+?)\uE9b3/gmu, (full, content) => {
        return `<br><br><mark risu-mark="blockquote1">${quotes[2]}${content}${quotes[3]}</mark><br><br>`
      })

    //clean up any unmatched quote marks
    text = text.replace(/\uE9b0/gu, quotes[0]).replace(/\uE9b1/gu, quotes[1])
    text = text.replace(/\uE9b2/gu, quotes[2]).replace(/\uE9b3/gu, quotes[3])
  } else {
    text = text.replace(/\uE9b0/gu, '<mark risu-mark="quote2">' + quotes[0]).replace(/\uE9b1/gu, quotes[1] + '</mark>')
    text = text.replace(/\uE9b2/gu, '<mark risu-mark="quote1">' + quotes[2]).replace(/\uE9b3/gu, quotes[3] + '</mark>')
  }

  return text
}

async function renderHighlightableMarkdown(data: string) {
  let rendered = renderMarkdown(mdHighlight, data)
  const highlightPlaceholders = rendered.match(/<pre-hljs-placeholder lang="(.+?)">(.+?)<\/pre-hljs-placeholder>/gms)
  if (!highlightPlaceholders) {
    return rendered
  }

  for (const placeholder of highlightPlaceholders) {
    try {
      let lang = placeholder.match(/lang="(.+?)"/)?.[1]
      const code = placeholder.match(/<pre-hljs-placeholder lang=".+?">(.+?)<\/pre-hljs-placeholder>/ms)?.[1]
      if (!lang || !code) {
        continue
      }
      //import language if not already loaded
      //we do not refactor this to a function because we want to keep vite to only import the languages that are needed
      let languageModule: typeof import('highlight.js/lib/languages/*') | null = null
      let fileExt = ''

      switch (lang) {
        case 'bash': {
          fileExt = 'sh'
          lang = 'bash'
          if (!hljs.getLanguage('bash')) {
            languageModule = await import('highlight.js/lib/languages/bash')
          }
          break
        }
        case 'c':
        case 'cpp': {
          fileExt = lang
          lang = 'cpp'
          if (!hljs.getLanguage('cpp')) {
            languageModule = await import('highlight.js/lib/languages/cpp')
          }
          break
        }
        case 'cs':
        case 'csharp': {
          fileExt = 'cs'
          lang = 'csharp'
          if (!hljs.getLanguage('csharp')) {
            languageModule = await import('highlight.js/lib/languages/csharp')
          }
          break
        }
        case 'css': {
          fileExt = 'css'
          lang = 'css'
          if (!hljs.getLanguage('css')) {
            languageModule = await import('highlight.js/lib/languages/css')
          }
          break
        }
        case 'dart': {
          fileExt = 'dart'
          lang = 'dart'
          if (!hljs.getLanguage('dart')) {
            languageModule = await import('highlight.js/lib/languages/dart')
          }
          break
        }
        case 'html':
        case 'svg':
        case 'xml': {
          fileExt = lang
          lang = 'xml'
          if (!hljs.getLanguage('xml')) {
            languageModule = await import('highlight.js/lib/languages/xml')
          }
          break
        }
        case 'java': {
          fileExt = 'java'
          lang = 'java'
          if (!hljs.getLanguage('java')) {
            languageModule = await import('highlight.js/lib/languages/java')
          }
          break
        }
        case 'js':
        case 'jsx':
        case 'javascript': {
          fileExt = 'js'
          lang = 'javascript'
          if (!hljs.getLanguage('javascript')) {
            languageModule = await import('highlight.js/lib/languages/javascript')
          }
          break
        }
        case 'json': {
          fileExt = 'json'
          lang = 'json'
          if (!hljs.getLanguage('json')) {
            languageModule = await import('highlight.js/lib/languages/json')
          }
          break
        }
        case 'lua': {
          fileExt = 'lua'
          lang = 'lua'
          if (!hljs.getLanguage('lua')) {
            languageModule = await import('highlight.js/lib/languages/lua')
          }
          break
        }
        case 'markdown':
        case 'md': {
          fileExt = 'md'
          lang = 'markdown'
          if (!hljs.getLanguage('markdown')) {
            languageModule = await import('highlight.js/lib/languages/markdown')
          }
          break
        }
        case 'py':
        case 'python': {
          fileExt = 'py'
          lang = 'python'
          if (!hljs.getLanguage('python')) {
            languageModule = await import('highlight.js/lib/languages/python')
          }
          break
        }
        case 'rust': {
          fileExt = 'rs'
          lang = 'rust'
          if (!hljs.getLanguage('rust')) {
            languageModule = await import('highlight.js/lib/languages/rust')
          }
          break
        }
        case 'shell': {
          fileExt = 'sh'
          lang = 'shell'
          if (!hljs.getLanguage('shell')) {
            languageModule = await import('highlight.js/lib/languages/shell')
          }
          break
        }
        case 'ts':
        case 'tsx':
        case 'typescript': {
          fileExt = 'ts'
          lang = 'typescript'
          if (!hljs.getLanguage('typescript')) {
            languageModule = await import('highlight.js/lib/languages/typescript')
          }
          break
        }
        case 'txt':
        case 'vtt': {
          fileExt = lang
          lang = 'plaintext'
          if (!hljs.getLanguage('plaintext')) {
            languageModule = await import('highlight.js/lib/languages/plaintext')
          }
          break
        }
        case 'yaml': {
          fileExt = 'yml'
          lang = 'yaml'
          if (!hljs.getLanguage('yaml')) {
            languageModule = await import('highlight.js/lib/languages/yaml')
          }
          break
        }
        case 'risuerror': {
          lang = 'error'
          fileExt = 'error'
          break
        }
        default: {
          lang = 'none'
          fileExt = 'none'
        }
      }
      if (languageModule) {
        hljs.registerLanguage(lang, languageModule.default)
      }
      if (lang === 'none') {
        rendered = rendered.replace(placeholder, `<pre><code>${md.utils.escapeHtml(code)}</code></pre>`)
      } else if (lang === 'error') {
        rendered = rendered.replace(
          placeholder,
          `<div class="risu-error"><h1>${language.error}</h1>${md.utils.escapeHtml(code)}</div>`,
        )
      } else {
        const highlighted = hljs.highlight(code, {
          language: lang,
          ignoreIllegals: true,
        }).value
        rendered = rendered.replace(
          placeholder,
          `<pre class="hljs" x-hl-lang="${fileExt}"><code>${highlighted}</code></pre>`,
        )
      }
    } catch (error) {
      console.warn('Failed to render highlighted code block:', error)
      const fallbackCode =
        placeholder.match(/<pre-hljs-placeholder lang=".+?">(.+?)<\/pre-hljs-placeholder>/ms)?.[1] ?? ''
      rendered = rendered.replace(placeholder, `<pre><code>${md.utils.escapeHtml(fallbackCode)}</code></pre>`)
    }
  }

  return rendered
}

export const assetRegex = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)}}/gms
const assetMarkerPresenceRegex = /{{(?:raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::/m

async function getFileSrcCached(path: string) {
  return getFileSrc(path)
}

interface AssetPathMatch {
  srcPaths: string[]
  ext?: string
}

interface AssetResolutionContext {
  sourceCharacterImage: string | undefined
  sourceUserIcon: string
  characterAssets: readonly (readonly string[])[]
  characterAssetSource: readonly (readonly string[])[]
  characterSignature: string
  emotionAssets: readonly (readonly string[])[]
  moduleOwners: readonly RisuModule[]
  assetIndex: Promise<AssetNameIndex[]> | null
  resolvedAssets: Map<string, AssetPathMatch | null>
  resolvedEmotions: Map<string, string | null>
}

interface AssetResolutionCacheEntry extends AssetResolutionContext {
  activeModuleKey: string
  characterSignature: string
  moduleRenderRevision: number
}

const ASSET_RESOLUTION_CACHE_LIMIT = 32
const assetResolutionCache = new Map<string, AssetResolutionCacheEntry>()
let cachedModuleRenderRevision = captureModuleRenderRevision()
const additionalAssetCacheStats = {
  contextsBuilt: 0,
  assetIndexesBuilt: 0,
  characterAssetTuplesVisited: 0,
  moduleAssetTuplesVisited: 0,
  resolvedAssetNames: 0,
}
const assetCollectionIndexes = new AssetCollectionIndexCache((kind) => {
  if (kind === 'module') additionalAssetCacheStats.moduleAssetTuplesVisited += 1
  else additionalAssetCacheStats.characterAssetTuplesVisited += 1
}, captureModuleRenderRevision)

export interface ChatDisplayReadContext {
  /** Resolved together by the caller's duplicate-safe transcript read owners. */
  character: character | undefined
  chat: Chat | undefined
  userIcon?: string
}

function moduleOwnersForCharacter(
  char: simpleCharacterArgument | character,
  readContext?: ChatDisplayReadContext,
): RisuModule[] {
  if (readContext) return parserModuleOwners(readContext)
  const ownerCharacter = parserCharacterOwnerById(char.chaId)
  const contextCharacter = char.type === 'simple' ? ownerCharacter : char
  const rows = charactersResourceState.status === 'ready' ? charactersResourceState.characters : []
  const contextChat = contextCharacter
    ? contextCharacter === ownerCharacter
      ? charactersResourceState.status === 'ready'
        ? readySelectedChatOwner(contextCharacter)
        : selectedChatOwner(rows, contextCharacter)
      : selectedChatOwner([contextCharacter], contextCharacter)
    : undefined
  return parserModuleOwners({ character: contextCharacter, chat: contextChat })
}

function characterAssetResolutionSignature(char: simpleCharacterArgument | character): string {
  return JSON.stringify([char.additionalAssets ?? [], char.emotionImages ?? []])
}

function activeModuleAssetKey(moduleOwners: readonly RisuModule[]): string {
  return JSON.stringify(moduleOwners.map((moduleOwner) => moduleOwner.id))
}

function getAssetResolutionContext(
  char: simpleCharacterArgument | character,
  readContext?: ChatDisplayReadContext,
): AssetResolutionContext {
  const moduleRenderRevision = captureModuleRenderRevision()
  if (cachedModuleRenderRevision !== moduleRenderRevision) {
    assetResolutionCache.clear()
    cachedModuleRenderRevision = moduleRenderRevision
  }

  const moduleOwners = moduleOwnersForCharacter(char, readContext)
  const activeModuleKey = activeModuleAssetKey(moduleOwners)
  const characterSignature = characterAssetResolutionSignature(char)
  const sourceCharacterImage = readContext ? readContext.character?.image : parserSelectedContext()?.character?.image
  const sourceUserIcon = readContext
    ? (readContext.userIcon ?? resolveUserPersonaPresentation(parserRuntimeDatabase(), readContext.chat).userIcon)
    : getUserIcon()
  const ownerKey = JSON.stringify([
    char.type === 'simple' ? 'simple' : 'character',
    char.chaId,
    readContext?.character?.chaId,
    readContext?.chat?.id,
  ])
  const cached = assetResolutionCache.get(ownerKey)
  if (
    cached?.moduleRenderRevision === moduleRenderRevision &&
    cached.activeModuleKey === activeModuleKey &&
    cached.characterSignature === characterSignature &&
    cached.sourceCharacterImage === sourceCharacterImage &&
    cached.sourceUserIcon === sourceUserIcon
  ) {
    assetResolutionCache.delete(ownerKey)
    assetResolutionCache.set(ownerKey, cached)
    return cached
  }

  // Character tuples use structural invalidation. Capture their values before
  // yielding so an in-place edit cannot produce an index mixing two versions.
  const [characterAssets, emotionAssets] = JSON.parse(characterSignature)
  const entry: AssetResolutionCacheEntry = {
    sourceCharacterImage,
    sourceUserIcon,
    activeModuleKey,
    characterAssets,
    characterAssetSource: char.additionalAssets ?? characterAssets,
    characterSignature,
    emotionAssets,
    moduleOwners,
    moduleRenderRevision,
    assetIndex: null,
    resolvedAssets: new Map(),
    resolvedEmotions: new Map(),
  }
  additionalAssetCacheStats.contextsBuilt += 1
  assetResolutionCache.delete(ownerKey)
  assetResolutionCache.set(ownerKey, entry)
  while (assetResolutionCache.size > ASSET_RESOLUTION_CACHE_LIMIT) {
    const oldestKey = assetResolutionCache.keys().next().value
    if (oldestKey === undefined) break
    assetResolutionCache.delete(oldestKey)
  }
  return entry
}

async function resolveAssetPaths(context: AssetResolutionContext, name: string): Promise<AssetPathMatch | null> {
  if (context.resolvedAssets.has(name)) return context.resolvedAssets.get(name) ?? null

  if (!context.assetIndex) {
    const revision = captureModuleRenderRevision()
    context.assetIndex = Promise.all([
      assetCollectionIndexes.get(
        context.characterAssetSource,
        context.characterSignature,
        'character',
        context.characterAssets,
      ),
      ...context.moduleOwners.map((owner) => assetCollectionIndexes.get(owner.assets ?? [], revision, 'module')),
    ])
    additionalAssetCacheStats.assetIndexesBuilt += 1
  }
  const indexes = await context.assetIndex
  if (context.resolvedAssets.has(name)) return context.resolvedAssets.get(name) ?? null
  let match: AssetPathMatch | null = null
  for (const index of indexes) {
    const extensions = index.get(name)
    if (!extensions) continue
    // First extension wins across character then module collection order.
    match ??= { ext: extensions.keys().next().value, srcPaths: [] }
    for (const path of extensions.get(match.ext) ?? []) match.srcPaths.push(path)
  }
  additionalAssetCacheStats.resolvedAssetNames += 1
  context.resolvedAssets.set(name, match)
  return match
}

function resolveEmotionPath(context: AssetResolutionContext, name: string): string | null {
  if (context.resolvedEmotions.has(name)) return context.resolvedEmotions.get(name) ?? null
  let path: string | null = null
  for (const emotion of context.emotionAssets) {
    if (emotion[0].toLocaleLowerCase() === name) path = emotion[1]
  }
  context.resolvedEmotions.set(name, path)
  return path
}

export function clearAdditionalAssetCachesForTests(): void {
  assetResolutionCache.clear()
  assetCollectionIndexes.clear()
  cachedModuleRenderRevision = captureModuleRenderRevision()
  additionalAssetCacheStats.contextsBuilt = 0
  additionalAssetCacheStats.assetIndexesBuilt = 0
  additionalAssetCacheStats.characterAssetTuplesVisited = 0
  additionalAssetCacheStats.moduleAssetTuplesVisited = 0
  additionalAssetCacheStats.resolvedAssetNames = 0
}

export function getAdditionalAssetCacheStatsForTests() {
  return {
    ...additionalAssetCacheStats,
    entries: assetResolutionCache.size,
  }
}

const imageCBS = ['img', 'image', 'emotion', 'asset', 'bg', 'raw', 'path']
const videoExtensions = ['mp4', 'webm', 'avi', 'm4p', 'm4v']

async function parseAdditionalAssets(
  data: string,
  char: simpleCharacterArgument | character,
  mode: 'normal' | 'back',
  arg: { ch: number },
  context: AssetResolutionContext,
) {
  const assetWidth = displaySettingForPaint('assetWidth')
  const hideAllImages = parserSetting('hideAllImages') === true
  const legacyMediaFindings = parserSetting('legacyMediaFindings') === true
  const assetWidthString = (assetWidth && assetWidth !== -1) || assetWidth === 0 ? `max-width:${assetWidth}rem;` : ''

  let needsSourceAccess = false
  let cx: number | null = null

  data = await replaceAsync(data, assetRegex, async (full: string, type: string, name: string) => {
    name = name.toLocaleLowerCase()

    // Skip image-related assets when hideAllImages is enabled
    // raw and path are also included as they're used in CSS background-image
    if (hideAllImages && imageCBS.includes(type)) {
      return '' // Hide the image asset
    }

    if (type === 'emotion') {
      const srcPath = resolveEmotionPath(context, name)
      const path = srcPath ? await getFileSrcCached(srcPath) : null
      if (!path) {
        return ''
      }
      return `<img src="${path}" alt="${path}" style="${assetWidthString} "/>`
    }

    if (type === 'source') {
      needsSourceAccess = true
      switch (name) {
        case 'char': {
          return '\uE9b4CHAR\uE9b4'
        }
        case 'user': {
          return '\uE9b4USER\uE9b4'
        }
      }
    }

    let match = await resolveAssetPaths(context, name)

    if (!match) {
      if (legacyMediaFindings) {
        return ''
      }

      match = getClosestMatch(char, name)

      if (!match) {
        return ''
      }
    }

    let pSrc = match.srcPaths[0]

    if (match.srcPaths.length > 1) {
      if (cx === null) {
        const chatID = arg.ch
        cx = pickHashRand(chatID, (char.chaId || 'global') + chatID)
      }
      const selIndex = Math.floor(cx * match.srcPaths.length)
      pSrc = match.srcPaths[selIndex]
    }

    const p = await getFileSrcCached(pSrc)
    switch (type) {
      case 'raw':
      case 'path':
        return p
      case 'img':
        return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>`
      case 'image':
        return `<div class="risu-inlay-image"><img src="${p}" alt="${p}" style="${assetWidthString}"/></div>\n`
      case 'video':
        return `<video controls autoplay loop><source src="${p}" type="video/mp4"></video>\n`
      case 'video-img':
        return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`
      case 'audio':
        return `<audio controls autoplay loop><source src="${p}" type="audio/mpeg"></audio>\n`
      case 'bg':
        if (mode === 'back') {
          return `<div style="width:100%;height:100%;background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.8)),url(${p}); background-size: cover;"></div>`
        }
        break
      case 'asset': {
        if (match.ext && videoExtensions.includes(match.ext)) {
          return `<video autoplay muted loop><source src="${p}" type="video/mp4"></video>\n`
        }
        return `<img src="${p}" alt="${p}" style="${assetWidthString} "/>\n`
      }
      case 'bgm':
        return `<div risu-ctrl="bgm___auto___${p}" style="display:none;"></div>\n`
    }
    return ''
  })

  if (needsSourceAccess) {
    data = data.replace(
      /\uE9b4CHAR\uE9b4/g,
      context.sourceCharacterImage ? await getFileSrc(context.sourceCharacterImage) : '',
    )

    data = data.replace(/\uE9b4USER\uE9b4/g, context.sourceUserIcon ? await getFileSrc(context.sourceUserIcon) : '')
  }

  return data
}

function getClosestMatch(char: simpleCharacterArgument | character, name: string) {
  if (!char.additionalAssets) return null

  let closestDist = 999999
  let targetPath = ''
  let targetExt = ''

  const trimmedName = trimmer(name)
  for (const asset of char.additionalAssets) {
    const key = asset[0].toLocaleLowerCase()
    const dist = getDistance(trimmedName, trimmer(key))
    if (dist < closestDist) {
      closestDist = dist
      targetPath = asset[1]
      targetExt = asset[2]
    }
  }

  const assetMaxDifference = parserSetting('assetMaxDifference')
  if (typeof assetMaxDifference !== 'number' || closestDist > assetMaxDifference) {
    return null
  }

  return {
    srcPaths: [targetPath],
    ext: targetExt,
  }
}

//Levenshtein distance, new with 1d array
export function getDistance(a: string, b: string) {
  const h = a.length + 1
  const w = b.length + 1
  let d = new Int16Array(h * w)
  for (let i = 0; i < h; i++) {
    d[i * w] = i
  }
  for (let i = 0; i < w; i++) {
    d[i] = i
  }
  for (let i = 1; i < h; i++) {
    for (let j = 1; j < w; j++) {
      d[i * w + j] = Math.min(
        d[(i - 1) * w + j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1),
        d[(i - 1) * w + j] + 1,
        d[i * w + j - 1] + 1,
      )
    }
  }
  return d[h * w - 1]
}

function trimmer(str: string) {
  const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
  for (const e of ext) {
    if (str.endsWith('.' + e)) {
      str = str.substring(0, str.length - e.length - 1)
    }
  }

  return str.trim().replace(/[_ -.]/g, '')
}

type RenderableInlayAssetType = Extract<InlayAsset['type'], 'audio' | 'image' | 'video'>
type BlobUrlCacheEntry = {
  type: RenderableInlayAssetType
  url: string
}

export const INLAY_BLOB_URL_CACHE_LIMIT = 64

const blobUrlCache = new Map<string, BlobUrlCacheEntry>()

function revokeBlobUrl(url: string) {
  if (typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url)
  }
}

function getRenderableInlayAssetType(type: InlayAsset['type'] | undefined): RenderableInlayAssetType | null {
  if (type === 'audio' || type === 'image' || type === 'video') return type
  return null
}

function getCachedBlobUrl(id: string) {
  const cached = blobUrlCache.get(id)
  if (!cached) return null
  blobUrlCache.delete(id)
  blobUrlCache.set(id, cached)
  return cached
}

function isBlobUrlRendered(url: string) {
  if (typeof document === 'undefined') return false
  return Array.from(document.querySelectorAll<HTMLImageElement | HTMLMediaElement | HTMLSourceElement>('[src]')).some(
    (element) => element.getAttribute('src') === url,
  )
}

function setCachedBlobUrl(id: string, entry: BlobUrlCacheEntry) {
  const previous = blobUrlCache.get(id)
  if (previous) {
    blobUrlCache.delete(id)
    if (previous.url !== entry.url) {
      revokeBlobUrl(previous.url)
    }
  }

  blobUrlCache.set(id, entry)
  let renderedEntriesScanned = 0
  while (blobUrlCache.size > INLAY_BLOB_URL_CACHE_LIMIT && renderedEntriesScanned < blobUrlCache.size) {
    const oldestId = blobUrlCache.keys().next().value
    if (oldestId === undefined) break
    const oldest = blobUrlCache.get(oldestId)
    blobUrlCache.delete(oldestId)
    if (oldest) {
      if (isBlobUrlRendered(oldest.url)) {
        blobUrlCache.set(oldestId, oldest)
        renderedEntriesScanned += 1
        continue
      }
      revokeBlobUrl(oldest.url)
    }
  }

  return entry
}

export function clearInlayBlobUrlCacheForTests() {
  for (const { url } of blobUrlCache.values()) {
    revokeBlobUrl(url)
  }
  blobUrlCache.clear()
}

async function parseInlayAssets(data: string) {
  const inlayMatch = data.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g)
  if (inlayMatch) {
    for (const inlay of inlayMatch) {
      const inlayType = inlay.startsWith('{{inlayed') ? 'inlayed' : 'inlay'
      const id = inlay.substring(inlay.indexOf('::') + 2, inlay.length - 2)
      let prefix = inlayType !== 'inlay' ? `<div class="risu-inlay-image">` : ''
      let postfix = inlayType !== 'inlay' ? `</div>\n\n` : ''

      let cached = getCachedBlobUrl(id)
      if (!cached) {
        const asset = await getInlayAssetBlob(id)
        const type = getRenderableInlayAssetType(asset?.type)
        if (type && asset?.data) {
          cached = setCachedBlobUrl(id, {
            type,
            url: URL.createObjectURL(asset.data),
          })
        }
      }
      switch (cached?.type) {
        case 'image':
          // Hide inlay images when hideAllImages is enabled
          if (parserSetting('hideAllImages')) {
            data = data.replace(inlay, '')
            break
          }
          data = data.replace(inlay, `${prefix}<img src="${cached.url}"/>${postfix}`)
          break
        case 'video':
          data = data.replace(
            inlay,
            `${prefix}<video controls><source src="${cached.url}" type="video/mp4"></video>${postfix}`,
          )
          break
        case 'audio':
          data = data.replace(
            inlay,
            `${prefix}<audio controls><source src="${cached.url}" type="audio/mpeg"></audio>${postfix}`,
          )
          break
      }
    }
  }
  return data
}

export interface simpleCharacterArgument {
  type: 'simple'
  additionalAssets?: [string, string, string][]
  customscript: customscript[]
  chaId: string
  virtualscript?: string
  emotionImages?: [string, string][]
  triggerscript?: triggerscript[]
}

const THOUGHTS_OPEN_MARKER = '<Thoughts>'
const THOUGHTS_CLOSE_MARKER = '</Thoughts>'
const TOOL_CALL_OPEN_MARKER = '<tool_call>'

function replaceToolCalls(data: string) {
  return data.replace(/<tool_call>(.+?)<\/tool_call>/gms, (full, txt: string) => {
    return `<div class="x-risu-tool-call">🛠️ ${language.toolCalled.replace('{{tool}}', txt.split('\uf100')?.[1] ?? 'unknown')}</div>\n\n`
  })
}

function findThoughtsClose(data: string, from: number) {
  let depth = 1
  let searchFrom = from

  while (searchFrom < data.length && depth > 0) {
    const nextOpen = data.indexOf(THOUGHTS_OPEN_MARKER, searchFrom)
    const nextClose = data.indexOf(THOUGHTS_CLOSE_MARKER, searchFrom)

    if (nextOpen === -1 && nextClose === -1) {
      return -1
    }

    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      depth++
      searchFrom = nextOpen + 1
      continue
    }

    depth--
    if (depth === 0) {
      return nextClose
    }
    searchFrom = nextClose + 1
  }

  return -1
}

export function parseThoughtsAndTools(data: string) {
  const hasThoughts = data.includes(THOUGHTS_OPEN_MARKER)
  const hasToolCalls = data.includes(TOOL_CALL_OPEN_MARKER)
  if (!hasThoughts && !hasToolCalls) {
    return data
  }

  if (!hasThoughts) {
    return replaceToolCalls(data)
  }

  let result = ''
  let from = 0
  let thoughtStart = data.indexOf(THOUGHTS_OPEN_MARKER, from)

  while (thoughtStart !== -1) {
    const thoughtEnd = findThoughtsClose(data, thoughtStart + THOUGHTS_OPEN_MARKER.length)
    if (thoughtEnd === -1) {
      result += data.slice(from, thoughtStart + 1)
      from = thoughtStart + 1
      thoughtStart = data.indexOf(THOUGHTS_OPEN_MARKER, from)
      continue
    }

    result += data.slice(from, thoughtStart)
    result += `<details><summary>${language.cot}</summary>${data.substring(
      thoughtStart + THOUGHTS_OPEN_MARKER.length,
      thoughtEnd,
    )}</details>`
    from = thoughtEnd + THOUGHTS_CLOSE_MARKER.length
    thoughtStart = data.indexOf(THOUGHTS_OPEN_MARKER, from)
  }

  result += data.slice(from)
  return hasToolCalls ? replaceToolCalls(result) : result
}

export async function ParseMarkdown(
  data: string,
  charArg: character | simpleCharacterArgument | string = null,
  mode: 'normal' | 'back' | 'pretranslate' | 'notrim' = 'normal',
  chatID = -1,
  cbsConditions: CbsConditions = {},
  displayTarget: {
    readOnly?: boolean
    readContext?: ChatDisplayReadContext
    chatId?: string
    layer?: DisplaySourceLayer
    messageId?: string
    name?: string
    streaming?: boolean
    priority?: DisplaySourcePriority
  } = {},
) {
  const sessionGeneration = captureClientSessionGeneration()
  const startedReadOnly = displayTarget.readOnly === true || isClientReadOnly()
  let firstParsed = ''
  const additionalAssetMode = mode === 'back' ? 'back' : 'normal'
  let char = typeof charArg === 'string' ? parserCharacterOwnerById(charArg) : charArg
  const readContext =
    displayTarget.readContext ??
    (displayTarget.chatId && char
      ? { character: parserCharacterOwnerById(char.chaId), chat: parserChatOwnerById(char.chaId, displayTarget.chatId) }
      : undefined)
  let assetResolutionContext: AssetResolutionContext | null = null

  const parseAssetsIfPresent = async (source: string): Promise<string> => {
    if (!char || !assetMarkerPresenceRegex.test(source)) return source
    assetResolutionContext ??= getAssetResolutionContext(char, readContext)
    return parseAdditionalAssets(
      source,
      char,
      additionalAssetMode,
      {
        ch: chatID,
      },
      assetResolutionContext,
    )
  }

  if (char) {
    data = await parseAssetsIfPresent(data)
    firstParsed = data
  }

  if (char) {
    const currentChat = readContext ? readContext.chat : parserSelectedContext()?.chat
    const messageId = displayTarget.messageId ?? (chatID >= 0 ? currentChat?.message?.[chatID]?.chatId : undefined)
    const currentTriggerId = get(CurrentTriggerIdStore)
    const hasBrowserOnlyTriggerContext = !startedReadOnly && currentTriggerId !== null && currentTriggerId !== 'null'
    const serverDisplaySource =
      currentChat?.id && !hasBrowserOnlyTriggerContext
        ? await requestServerDisplaySource({
            chatId: currentChat.id,
            character: char,
            ...(messageId ? { messageId } : {}),
            index: chatID,
            role: cbsConditions.chatRole ?? null,
            firstMessage: cbsConditions.firstmsg ?? false,
            layer: displayTarget.layer ?? (chatID < 0 ? 'greeting' : mode === 'back' ? 'preview' : 'original'),
            source: data,
            streaming: displayTarget.streaming,
            priority: displayTarget.priority,
            ...(displayTarget.name
              ? { name: displayTarget.name }
              : 'name' in char && typeof char.name === 'string'
                ? { name: char.name }
                : {}),
          })
        : ({ status: 'fallback', reason: 'chat_unavailable' } as const)
    if (serverDisplaySource.status === 'ok') {
      data = serverDisplaySource.displaySource
    } else if (startedReadOnly || isClientReadOnly() || !isClientSessionGenerationCurrent(sessionGeneration)) {
      // Keep source readable without entering general scripts, plugin hooks, or
      // provider effects when isolated server display is unavailable.
      if (
        serverDisplaySource.reason !== 'display_namespace_changed' &&
        serverDisplaySource.reason !== 'display_scope_changed'
      ) {
        markReaderDisplayLimited(currentChat?.id ?? displayTarget.chatId, sessionGeneration)
      }
    } else {
      data = (await processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)).data
    }
  }

  if (firstParsed !== data && char) {
    data = await parseAssetsIfPresent(data)
  }

  data = await parseInlayAssets(data ?? '')

  data = parseThoughtsAndTools(data)

  if (mode === 'normal' || mode === 'notrim') {
    if (parserSetting('paragraphBreakBySentences') ?? false) {
      data = insertSentenceParagraphBreaks(data, parserSetting('paragraphBreakSentenceCount') ?? 3)
    }
  }

  data = encodeStyle(data)
  if (mode === 'normal' || mode === 'notrim') {
    data = await renderHighlightableMarkdown(data)

    if (mode === 'notrim') {
      return startedReadOnly || isClientReadOnly() ? trimMarkdown(data) : data
    }
  }
  return trimMarkdown(data)
}

/** Read on cache hits too, so image policy changes still invalidate rendered bodies. */
export function chatHtmlRenderPolicyKey(): string {
  return `${Boolean(parserSetting('hideAllImages'))}|${aiWatermarkingLawApplies()}`
}

export function trimMarkdown(data: string) {
  if (data === '') return ''
  let sanitized = DOMPurify.sanitize(data, {
    ADD_TAGS: [
      'iframe',
      'style',
      'risu-style',
      'x-em',
      'annotation',
      'semantics',
      'mrow',
      'mi',
      'mo',
      'mn',
      'msup',
      'msub',
      'mfrac',
      'msqrt',
    ],
    ADD_ATTR: [
      'allow',
      'allowfullscreen',
      'frameborder',
      'scrolling',
      'risu-ctrl',
      'risu-btn',
      'risu-trigger',
      'risu-mark',
      'risu-id',
      'x-hl-lang',
      'x-hl-text',
    ],
  })

  const decoded = decodeStyle(sanitized)

  if (decoded !== sanitized) {
    sanitized = DOMPurify.sanitize(decoded, {
      ADD_TAGS: [
        'iframe',
        'style',
        'risu-style',
        'x-em',
        'annotation',
        'semantics',
        'mrow',
        'mi',
        'mo',
        'mn',
        'msup',
        'msub',
        'mfrac',
        'msqrt',
      ],
      ADD_ATTR: [
        'allow',
        'allowfullscreen',
        'frameborder',
        'scrolling',
        'risu-ctrl',
        'risu-btn',
        'risu-trigger',
        'risu-mark',
        'risu-id',
        'x-hl-lang',
        'x-hl-text',
      ],
      FORCE_BODY: true,
    })
  } else {
    sanitized = decoded
  }

  return sanitized
}

const metaCodes = [
  '\u200B', //zero width space
  '\u200C', //zero width non-joiner
  '\u200D', //zero width joiner
  '\uFEFF', //zero width no-break space
  '\u2060', //word joiner
  '\u180E', //mongolian vowel separator
]

const encodedMetadataCache = new Map<string, string>()

function encodeMetadata(modelShortName: string) {
  const metadata = '{' + ['risuai', modelShortName.toLocaleLowerCase().replace(/[^a-z]/g, '')].join('|') + '}'

  const cached = encodedMetadataCache.get(metadata)
  if (cached !== undefined) {
    return cached
  }

  let encodedMetaCode = ''
  for (let i = 0; i < metadata.length; i++) {
    let byte = (metadata.charCodeAt(i) - 97).toString(6).padStart(2, '0')
    for (let j = 0; j < byte.length; j++) {
      switch (byte.charAt(j)) {
        case '0': {
          encodedMetaCode += metaCodes[0]
          break
        }
        case '1': {
          encodedMetaCode += metaCodes[1]
          break
        }
        case '2': {
          encodedMetaCode += metaCodes[2]
          break
        }
        case '3': {
          encodedMetaCode += metaCodes[3]
          break
        }
        case '4': {
          encodedMetaCode += metaCodes[4]
          break
        }
        case '5': {
          encodedMetaCode += metaCodes[5]
          break
        }
      }
    }
  }

  encodedMetadataCache.set(metadata, encodedMetaCode)
  return encodedMetaCode
}

export function addMetadataToElement(data: string, modelShortName: string) {
  if (!aiWatermarkingLawApplies()) {
    return data
  }

  const encodedMetaCode = encodeMetadata(modelShortName)
  console.log('Encoded metadata:', encodedMetaCode.length, 'characters')
  console.log('This requires at least', Math.ceil(encodedMetaCode.length / 32), '<p> tags to store')

  let d = data.replace(/\<p\>/g, (v) => {
    return '<p>' + encodedMetaCode
  })

  return d + encodedMetaCode
}

export async function postTranslationParse(data: string) {
  let lines = data.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const trimed = lines[i].trim()
    if (trimed.startsWith('<')) {
      lines[i] = trimed
    }
  }

  data = await renderHighlightableMarkdown(lines.join('\n'))
  return data
}

export function parseMarkdownSafe(
  data: string,
  arg: {
    forbidTags?: string[]
  } = {},
) {
  return DOMPurify.sanitize(renderMarkdown(md, data), {
    FORBID_TAGS: ['a', 'style', ...(arg.forbidTags || [])],
    FORBID_ATTR: ['style', 'href', 'class'],
  })
}

const styleRegex = /\<style\>(.+?)\<\/style\>/gms
function encodeStyle(txt: string) {
  return txt.replaceAll(styleRegex, (f, c1) => {
    return '<risu-style>' + Buffer.from(c1).toString('hex') + '</risu-style>'
  })
}
const styleDecodeRegex = /\<risu-style\>(.+?)\<\/risu-style\>/gms

function decodeStyleRule(rule: CssAtRuleAST) {
  if (rule.type === 'rule') {
    if (rule.selectors) {
      for (let i = 0; i < rule.selectors.length; i++) {
        let slt: string = rule.selectors[i]
        if (slt) {
          const parser = cssSelectorParser((root) => {
            root.walkClasses((classes) => {
              if (classes.type === 'class' && !classes.value.startsWith('x-risu-')) {
                classes.value = 'x-risu-' + classes.value
              }
            })
          })

          slt = parser.processSync(slt)

          rule.selectors[i] = '.chattext ' + slt
        }
      }
    }
  }
  if (
    rule.type === 'media' ||
    rule.type === 'supports' ||
    rule.type === 'document' ||
    rule.type === 'host' ||
    rule.type === 'container'
  ) {
    for (let i = 0; i < rule.rules.length; i++) {
      rule.rules[i] = decodeStyleRule(rule.rules[i])
    }
  }
  if (rule.type === 'import') {
    if (rule.import.startsWith('data:')) {
      rule.import = 'data:,'
    }
  }
  return rule
}

function decodeStyle(text: string) {
  return text.replaceAll(styleDecodeRegex, (full, txt: string) => {
    try {
      let text = Buffer.from(txt, 'hex').toString('utf-8')
      text = risuChatParser(text)
      const ast = css.parse(text)
      const rules = ast?.stylesheet?.rules
      if (rules) {
        for (let i = 0; i < rules.length; i++) {
          rules[i] = decodeStyleRule(rules[i])
        }
        ast.stylesheet.rules = rules
      }
      return `<style>${css.stringify(ast, {
        indent: '',
        compress: true,
      })}</style>`
    } catch (error) {
      if (parserSetting('returnCSSError')) {
        return `CSS ERROR: ${error}`
      }
      return ''
    }
  })
}

export async function hasher(data: Uint8Array) {
  return sha256Hex(data)
}

export function applyMarkdownToNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent
    if (text) {
      let markdown = renderMarkdown(md, text)
      if (markdown !== text) {
        const span = document.createElement('span')
        span.innerHTML = markdown

        // inherit inline style from the parent node
        const parentStyle = (node.parentNode as HTMLElement)?.style
        if (parentStyle) {
          for (let i = 0; i < parentStyle.length; i++) {
            span.style.setProperty(parentStyle[i], parentStyle.getPropertyValue(parentStyle[i]))
          }
        }
        ;(node as Element)?.replaceWith(span)
        return
      }
    }
  } else {
    for (const child of node.childNodes) {
      applyMarkdownToNode(child)
    }
  }
}
