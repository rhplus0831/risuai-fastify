import { get } from 'svelte/store'
import { afterEach, beforeEach, vi } from 'vitest'
import type { character, Database } from '../../ts/storage/database.svelte'
import { replaceResourceDatabase } from '../../ts/server/resourceState.svelte'
import { ReloadChatPointer, ReloadGUIPointer, VariableReloadGUIPointer, selectedCharID } from '../../ts/stores.svelte'
import { RegexDisplayReloadPointer } from '../../ts/process/regexDisplayReload'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

// Import this fixture before runtime modules so the shared dependency doubles are installed first.
// ParseMarkdown is intentionally real unless an individual test spies on it.
const hoistedModuleState = vi.hoisted(() => ({
  modules: [] as any[],
  assets: [] as [string, string, string][],
  regexScripts: [] as any[],
}))

vi.mock('../../ts/process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/process/modules')>()
  return {
    ...actual,
    getModuleAssets: () => hoistedModuleState.assets,
    getModuleLorebooks: () => [],
    getModuleRegexScripts: () => hoistedModuleState.regexScripts,
    getModuleTriggers: () => [],
    getModules: () => hoistedModuleState.modules,
    moduleUpdate: () => {},
  }
})

vi.mock('../../ts/process/scriptings', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/process/scriptings')>()
  return {
    ...actual,
    runLuaEditTrigger: vi.fn(async (_char: unknown, _mode: unknown, data: string) => data),
  }
})

vi.mock('../../ts/process/triggers', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/process/triggers')>()
  return {
    ...actual,
    runTrigger: vi.fn(async () => undefined),
  }
})

const hoistedTranslationState = vi.hoisted(() => ({
  calls: [] as unknown[][],
  implementation: async (...args: unknown[]) => String(args[0] ?? ''),
}))

vi.mock('../../ts/translator/translator', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/translator/translator')>()
  return {
    ...actual,
    translateHTML: async (...args: unknown[]) => {
      hoistedTranslationState.calls.push(args)
      return hoistedTranslationState.implementation(...args)
    },
  }
})

const previousDb = getResourceDatabase({ snapshot: true })
const previousSelectedChar = get(selectedCharID)
const previousReloadGui = get(ReloadGUIPointer)
const previousVariableReloadGui = get(VariableReloadGUIPointer)
const previousRegexDisplayReload = get(RegexDisplayReloadPointer)
const previousReloadChat = get(ReloadChatPointer)

function makeCharacter(): character {
  return {
    type: 'character',
    chaId: 'chat-body-parse-memo-char',
    name: 'Parse Memo Character',
    image: '',
    firstMessage: '',
    desc: '',
    notes: '',
    chats: [
      {
        id: 'chat-body-parse-memo-chat',
        name: 'Parse Memo Chat',
        message: [],
        note: '',
        localLore: [],
        scriptstate: {},
        fmIndex: -1,
        bookmarks: [],
        bookmarkNames: {},
      },
    ],
    chatFolders: [],
    chatPage: 0,
    viewScreen: 'none',
    bias: [],
    emotionImages: [],
    globalLore: [],
    sdData: [],
    customscript: [],
    triggerscript: [],
    utilityBot: false,
    exampleMessage: '',
    creatorNotes: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: '',
    scenario: '',
    firstMsgIndex: -1,
    replaceGlobalNote: '',
    additionalText: '',
    additionalAssets: [],
    virtualscript: '',
    defaultVariables: '',
  } as unknown as character
}

export type SeedDbOverrides = Partial<Database> & {
  autoTranslate?: boolean
  autoTranslateBotOnly?: boolean
}

export function seedDb(overrides: SeedDbOverrides = {}) {
  const { autoTranslate, autoTranslateBotOnly, ...databaseOverrides } = overrides
  const char = makeCharacter()
  if (autoTranslate !== undefined) char.chats[0].autoTranslate = autoTranslate
  if (autoTranslateBotOnly !== undefined) char.chats[0].autoTranslateBotOnly = autoTranslateBotOnly
  selectedCharID.set(0)
  ReloadChatPointer.set({})
  ReloadGUIPointer.set(0)
  VariableReloadGUIPointer.set(0)
  RegexDisplayReloadPointer.set(0)
  replaceResourceDatabase({
    characters: [char],
    characterOrder: [char.chaId],
    currentChar: 0,
    presetRegex: [],
    globalscript: [],
    modules: [],
    enabledModules: [],
    moduleIntergration: '',
    templateDefaultVariables: '',
    globalChatVariables: {},
    username: 'Parse Memo User',
    userIcon: '',
    translator: '',
    translatorInputLanguage: 'en',
    translatorType: 'none',
    autoTranslateCachedOnly: false,
    translateBeforeHTMLFormatting: false,
    legacyTranslation: false,
    showTranslationLoading: false,
    newImageHandlingBeta: false,
    customQuotes: false,
    customQuotesData: ['"', '"', "'", "'"],
    blockquoteStyling: false,
    unformatQuotes: false,
    hideAllImages: false,
    dynamicAssets: false,
    dynamicAssetsEditDisplay: false,
    paragraphBreakBySentences: false,
    paragraphBreakSentenceCount: 3,
    assetWidth: -1,
    assetMaxDifference: 3,
    legacyMediaFindings: false,
    returnCSSError: false,
    ...databaseOverrides,
  } as unknown as Database)
  return getResourceDatabase().characters[0]
}

export function setupParseMemoTests(cleanup: () => Promise<void> = async () => {}) {
  beforeEach(() => {
    hoistedTranslationState.calls = []
    hoistedTranslationState.implementation = async (...args: unknown[]) => String(args[0] ?? '')
    hoistedModuleState.modules = []
    hoistedModuleState.assets = []
    hoistedModuleState.regexScripts = []
  })

  afterEach(async () => {
    await cleanup()
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    const translatorModule = await import('../../ts/translator/translator')
    await translatorModule.clearLLMCache()
    replaceResourceDatabase(previousDb)
    selectedCharID.set(previousSelectedChar)
    ReloadChatPointer.set(previousReloadChat)
    ReloadGUIPointer.set(previousReloadGui)
    VariableReloadGUIPointer.set(previousVariableReloadGui)
    RegexDisplayReloadPointer.set(previousRegexDisplayReload)
  })
}

export const moduleMockState = hoistedModuleState
export const translateHTMLMock = hoistedTranslationState
