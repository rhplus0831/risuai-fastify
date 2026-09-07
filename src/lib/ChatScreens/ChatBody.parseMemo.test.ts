import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { character, Database } from '../../ts/storage/database.svelte'
import { charactersResourceState, replaceResourceDatabase } from '../../ts/server/resourceState.svelte'
import { createChatReadOwners } from './chatReadOwners.svelte'
import { ReloadChatPointer, ReloadGUIPointer, VariableReloadGUIPointer, selectedCharID } from '../../ts/stores.svelte'
import { RegexDisplayReloadPointer, reloadRegexDisplay } from '../../ts/process/regexDisplayReload'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import { invalidateModuleRenderRevision } from '../../ts/moduleRenderRevision'

const moduleMockState = vi.hoisted(() => ({
  modules: [] as any[],
  assets: [] as [string, string, string][],
  regexScripts: [] as any[],
}))

vi.mock('../../ts/process/modules', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/process/modules')>()
  return {
    ...actual,
    getModuleAssets: () => moduleMockState.assets,
    getModuleLorebooks: () => [],
    getModuleRegexScripts: () => moduleMockState.regexScripts,
    getModuleTriggers: () => [],
    getModules: () => moduleMockState.modules,
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

const translateHTMLMock = vi.hoisted(() => ({
  calls: [] as unknown[][],
  implementation: async (...args: unknown[]) => String(args[0] ?? ''),
}))

vi.mock('../../ts/translator/translator', async (importActual) => {
  const actual = await importActual<typeof import('../../ts/translator/translator')>()
  return {
    ...actual,
    translateHTML: async (...args: unknown[]) => {
      translateHTMLMock.calls.push(args)
      return translateHTMLMock.implementation(...args)
    },
  }
})

const previousDb = getResourceDatabase({ snapshot: true })
const previousSelectedChar = get(selectedCharID)
const previousReloadGui = get(ReloadGUIPointer)
const previousVariableReloadGui = get(VariableReloadGUIPointer)
const previousRegexDisplayReload = get(RegexDisplayReloadPointer)
const previousReloadChat = get(ReloadChatPointer)
const explicitRetranslateCacheKey = '<p>explicit source body</p>'

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

type SeedDbOverrides = Partial<Database> & {
  autoTranslate?: boolean
  autoTranslateBotOnly?: boolean
}

function seedDb(overrides: SeedDbOverrides = {}) {
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
  return char
}

async function settleRenderWork() {
  for (let i = 0; i < 8; i += 1) {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function waitForText(target: HTMLElement, expectedText: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await settleRenderWork()
    if ((target.textContent ?? '').includes(expectedText)) {
      return
    }
  }
  throw new Error(`Expected rendered text "${expectedText}", got "${target.textContent ?? ''}"`)
}

async function waitForParagraphCount(target: HTMLElement, expectedCount: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await settleRenderWork()
    if (target.querySelectorAll('p').length === expectedCount) return
  }
  throw new Error(`Expected ${expectedCount} paragraphs, got ${target.querySelectorAll('p').length}`)
}

async function loadChatBodyWithParseSpy() {
  const parserModule = await import('../../ts/parser/parser.svelte')
  const parseSpy = vi.spyOn(parserModule, 'ParseMarkdown')
  const memoModule = await import('./ChatBodyParseMemo')
  memoModule.clearChatBodyParseMemo()
  const { default: ChatBody } = await import('./ChatBody.svelte')
  return { ChatBody, memoModule, parseSpy }
}

beforeEach(() => {
  translateHTMLMock.calls = []
  translateHTMLMock.implementation = async (...args: unknown[]) => String(args[0] ?? '')
  moduleMockState.modules = []
  moduleMockState.assets = []
  moduleMockState.regexScripts = []
})

function mountChatBody(
  ChatBody: Awaited<ReturnType<typeof loadChatBodyWithParseSpy>>['ChatBody'],
  target: HTMLElement,
  props: {
    msgDisplay: string
    character: string
    translated?: boolean
    retranslate?: boolean
  },
) {
  return mount(ChatBody, {
    target,
    props: {
      character: props.character,
      firstMessage: false,
      idx: 0,
      msgDisplay: props.msgDisplay,
      name: 'Parse Memo Character',
      role: 'char',
      translated: props.translated ?? false,
      translating: false,
      retranslate: props.retranslate ?? false,
      modelShortName: '',
    },
  })
}

afterEach(async () => {
  const memoModule = await import('./ChatBodyParseMemo')
  memoModule.clearChatBodyParseMemo()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  const translatorModule = await import('../../ts/translator/translator')
  await translatorModule.clearLLMCache()
  document.body.innerHTML = ''
  replaceResourceDatabase(previousDb)
  selectedCharID.set(previousSelectedChar)
  ReloadChatPointer.set(previousReloadChat)
  ReloadGUIPointer.set(previousReloadGui)
  VariableReloadGUIPointer.set(previousVariableReloadGui)
  RegexDisplayReloadPointer.set(previousRegexDisplayReload)
})

describe('ChatBody content-keyed parse memo', () => {
  it('isolates equal message IDs in local read scopes without following canonical chat selection', async () => {
    seedDb()
    const character = charactersResourceState.characters[0]
    const first = character.chats[0]
    character.chats.push({ ...first, id: 'local-reader-second', message: [], modules: ['local-module'] })
    const second = character.chats[1]
    const parser = await import('../../ts/parser/parser.svelte')
    const parse = vi
      .spyOn(parser, 'ParseMarkdown')
      .mockImplementation(
        async (_data, _char, _mode, _index, _cbs, target) => `parsed ${target?.readContext?.chat?.id}`,
      )
    const memo = await import('./ChatBodyParseMemo')
    const input = (chatId: string) => ({
      data: 'same source',
      charArg: character.chaId,
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: {},
      chatId,
      messageId: 'same-message-id',
      readOnly: true,
      owners: memo.createChatBodyParseOwnerReaders(
        createChatReadOwners(
          charactersResourceState,
          () => [],
          () => ({ characterId: character.chaId, chatId }),
        ),
      ),
    })
    const firstInput = input(first.id!)
    const secondInput = input(second.id!)
    const firstKey = memo.getChatBodyParseMemoKey(firstInput)
    expect(firstKey).not.toBe(memo.getChatBodyParseMemoKey(secondInput))
    await expect(memo.memoizedChatBodyParse(firstInput)).resolves.toBe(`parsed ${first.id}`)
    await expect(memo.memoizedChatBodyParse(secondInput)).resolves.toBe(`parsed ${second.id}`)
    character.chatPage = 1
    expect(memo.getChatBodyParseMemoKey(firstInput)).toBe(firstKey)
    await expect(memo.memoizedChatBodyParse(firstInput)).resolves.toBe(`parsed ${first.id}`)
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('invalidates asset markup when a cached paint width is replaced by the authoritative default', async () => {
    const character = seedDb()
    const memo = await import('./ChatBodyParseMemo')
    let paintWidth: number | undefined = 12
    const input = {
      data: '{{asset::portrait}}',
      charArg: character.chaId,
      owners: { ...memo.createChatBodyParseOwnerReaders(), assetWidthForPaint: () => paintWidth },
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }
    const cachedKey = memo.getChatBodyParseMemoKey(input)
    paintWidth = undefined
    expect(memo.getChatBodyParseMemoKey(input)).not.toBe(cachedKey)
  })

  it('repeated parse-key builds reuse corpus signatures until invalidators change', async () => {
    seedDb()
    const script = (id: string, out: string) => ({
      id,
      comment: '',
      in: '',
      out,
      type: 'regex',
      flag: '',
      ableFlag: '',
    })
    const trigger = (id: string, comment: string) => ({
      id,
      comment,
      type: 'manual',
      conditions: [],
      effect: [],
    })
    const dbChar = getResourceDatabase().characters[0]
    const characterScripts = [script('character-regex-a', 'character one')]
    const characterTriggers = [trigger('character-trigger-a', 'character trigger one')]
    const characterAssets: [string, string, string][] = [['character-portrait', 'asset-character-a', 'character.png']]
    const moduleAssets: [string, string, string][] = [['portrait', 'asset-a', 'portrait.png']]
    const moduleRegex = [script('module-regex-a', 'module one')]
    const moduleTriggers = [trigger('module-trigger-a', 'module trigger one')]

    dbChar.customscript = characterScripts as any
    dbChar.triggerscript = characterTriggers as any
    dbChar.additionalAssets = characterAssets
    getResourceDatabase().presetRegex = [script('preset-regex-a', 'preset one')] as any
    moduleMockState.assets = moduleAssets
    moduleMockState.regexScripts = moduleRegex
    moduleMockState.modules = [
      {
        id: 'module-a',
        namespace: 'module-namespace-a',
        regex: moduleRegex,
        assets: moduleAssets,
        trigger: moduleTriggers,
        lowLevelAccess: false,
        customModuleToggle: 'toggle-a',
      },
    ]

    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'L30 parse memo body one',
      charArg: dbChar.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    const firstKey = memoModule.getChatBodyParseMemoKey(input)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 1,
      characterSignatureBuilds: 1,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 1,
      settingsSignatureBuilds: 1,
    })

    const secondInput = { ...input, data: 'L30 parse memo body two' }
    const secondKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(secondKey).not.toBe(firstKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 2,
      characterSignatureBuilds: 1,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 1,
      settingsSignatureBuilds: 1,
    })

    dbChar.customscript[0].out = 'character two'
    const characterInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(characterInvalidatedKey).not.toBe(secondKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 3,
      characterSignatureBuilds: 2,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 1,
      settingsSignatureBuilds: 1,
    })

    dbChar.triggerscript[0].comment = 'character trigger two'
    const characterTriggerInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(characterTriggerInvalidatedKey).not.toBe(characterInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 4,
      characterSignatureBuilds: 3,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 1,
      settingsSignatureBuilds: 1,
    })

    dbChar.additionalAssets![0][1] = 'asset-character-b'
    const characterAssetInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(characterAssetInvalidatedKey).not.toBe(characterTriggerInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 5,
      characterSignatureBuilds: 4,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 1,
      settingsSignatureBuilds: 1,
    })

    moduleRegex[0].out = 'module two'
    invalidateModuleRenderRevision()
    const moduleInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(moduleInvalidatedKey).not.toBe(characterAssetInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 6,
      characterSignatureBuilds: 4,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 2,
      settingsSignatureBuilds: 1,
    })

    getResourceDatabase().presetRegex[0].out = 'preset two'
    const presetRegexInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(presetRegexInvalidatedKey).not.toBe(moduleInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 7,
      characterSignatureBuilds: 4,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 2,
      settingsSignatureBuilds: 2,
    })

    moduleAssets[0][1] = 'asset-b'
    invalidateModuleRenderRevision()
    const moduleAssetInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(moduleAssetInvalidatedKey).not.toBe(presetRegexInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 8,
      characterSignatureBuilds: 4,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 3,
      settingsSignatureBuilds: 2,
    })

    moduleTriggers[0].comment = 'module trigger two'
    invalidateModuleRenderRevision()
    const moduleTriggerInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(moduleTriggerInvalidatedKey).not.toBe(moduleAssetInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 9,
      characterSignatureBuilds: 4,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 4,
      settingsSignatureBuilds: 2,
    })

    getResourceDatabase().customQuotes = true
    const settingsInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(settingsInvalidatedKey).not.toBe(moduleTriggerInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 10,
      characterSignatureBuilds: 4,
      activeChatSignatureBuilds: 1,
      moduleSignatureBuilds: 4,
      settingsSignatureBuilds: 3,
    })

    invalidateModuleRenderRevision()
    ReloadGUIPointer.update((value) => value + 1)
    const reloadInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(reloadInvalidatedKey).not.toBe(settingsInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 11,
      characterSignatureBuilds: 5,
      activeChatSignatureBuilds: 2,
      moduleSignatureBuilds: 5,
      settingsSignatureBuilds: 4,
    })

    VariableReloadGUIPointer.update((value) => value + 1)
    const variableReloadInvalidatedKey = memoModule.getChatBodyParseMemoKey(secondInput)
    expect(variableReloadInvalidatedKey).not.toBe(reloadInvalidatedKey)
    expect(memoModule.getChatBodyParseMemoDebugStats()).toMatchObject({
      parseKeyBuilds: 12,
      characterSignatureBuilds: 5,
      activeChatSignatureBuilds: 2,
      moduleSignatureBuilds: 5,
      settingsSignatureBuilds: 4,
    })
  })

  it('keeps parse keys compact for an active module with 130,000 assets', async () => {
    const char = seedDb()
    const moduleAssets = Array.from({ length: 130_000 }, (_, index) => [
      `asset-${index}`,
      `server-asset-${index}`,
      'png',
    ]) as [string, string, string][]
    moduleMockState.modules = [
      {
        id: 'asset-heavy-module',
        assets: moduleAssets,
      },
    ]
    moduleMockState.assets = moduleAssets

    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'asset-heavy parse memo body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    const firstKey = memoModule.getChatBodyParseMemoKey(input)
    expect(firstKey).not.toContain('asset-129999')
    expect(firstKey).not.toContain('server-asset-129999')
    expect(firstKey.length).toBeLessThan(8_000)

    moduleAssets[129_999][1] = 'changed-server-asset'
    invalidateModuleRenderRevision()
    const changedKey = memoModule.getChatBodyParseMemoKey(input)
    expect(changedKey).not.toBe(firstKey)
    expect(changedKey).not.toContain('changed-server-asset')
    expect(changedKey.length).toBeLessThan(8_000)
  })

  it('retires prior parse entries when the module render revision advances', async () => {
    const char = seedDb()
    const parserModule = await import('../../ts/parser/parser.svelte')
    const parseSpy = vi.spyOn(parserModule, 'ParseMarkdown').mockResolvedValue('parsed')
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'module revision cache body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    await memoModule.memoizedChatBodyParse(input)
    expect(memoModule.getChatBodyParseMemoStats().parseEntries).toBe(1)

    invalidateModuleRenderRevision()
    await memoModule.memoizedChatBodyParse(input)

    expect(parseSpy).toHaveBeenCalledTimes(2)
    expect(memoModule.getChatBodyParseMemoStats().parseEntries).toBe(1)
  })

  it('bounds retained parse keys by approximate bytes as well as entry count', async () => {
    const char = seedDb()
    const parserModule = await import('../../ts/parser/parser.svelte')
    vi.spyOn(parserModule, 'ParseMarkdown').mockResolvedValue('parsed')
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const repeatedBody = 'x'.repeat(600_000)
    const owners = memoModule.createChatBodyParseOwnerReaders()

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        memoModule.memoizedChatBodyParse({
          data: `${index}:${repeatedBody}`,
          charArg: char.chaId,
          owners,
          mode: 'notrim',
          chatID: index,
          cbsConditions: { firstmsg: false, chatRole: 'char' },
        }),
      ),
    )

    const stats = memoModule.getChatBodyParseMemoStats()
    expect(stats.parseKeyBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
    expect(stats.parseEntries).toBeLessThan(16)
  })

  it('separates explicitly read-only parse entries from writer entries', async () => {
    const memoModule = await import('./ChatBodyParseMemo')
    const input = {
      data: 'reader and writer source',
      charArg: null,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'normal' as const,
      chatID: 0,
      cbsConditions: {},
    }
    expect(memoModule.getChatBodyParseMemoKey({ ...input, readOnly: true })).not.toBe(
      memoModule.getChatBodyParseMemoKey({ ...input, readOnly: false }),
    )
  })

  it('includes both sentence paragraph preferences in parser memo keys with legacy fallbacks', async () => {
    seedDb()
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'Sentence paragraph memo body',
      charArg: getResourceDatabase().characters[0].chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }
    const database = getResourceDatabase()

    delete database.paragraphBreakBySentences
    delete database.paragraphBreakSentenceCount
    const legacyKey = memoModule.getChatBodyParseMemoKey(input)

    database.paragraphBreakBySentences = false
    database.paragraphBreakSentenceCount = 3
    expect(memoModule.getChatBodyParseMemoKey(input)).toBe(legacyKey)

    database.paragraphBreakBySentences = true
    const enabledKey = memoModule.getChatBodyParseMemoKey(input)
    expect(enabledKey).not.toBe(legacyKey)

    database.paragraphBreakSentenceCount = 4
    expect(memoModule.getChatBodyParseMemoKey(input)).not.toBe(enabledKey)
  })

  it('keys parser settings from the active chat selected prompt regex', async () => {
    const char = seedDb()
    const script = (id: string, out: string) => ({
      id,
      comment: '',
      in: '',
      out,
      type: 'regex',
      flag: '',
      ableFlag: '',
    })
    getResourceDatabase().presetRegex = [script('global-regex', 'global one')] as any
    getResourceDatabase().promptPresets = [
      {
        id: 'chat-preset',
        presetRegex: [script('chat-regex', 'chat one')],
      },
    ] as any
    ;(getResourceDatabase().characters[0].chats[0] as any).generationSettings = {
      promptPresetId: 'chat-preset',
    }

    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'active prompt regex memo body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    const selectedPromptKey = memoModule.getChatBodyParseMemoKey(input)
    getResourceDatabase().presetRegex[0].out = 'global two'
    expect(memoModule.getChatBodyParseMemoKey(input)).toBe(selectedPromptKey)
    ;(getResourceDatabase().promptPresets[0] as any).presetRegex[0].out = 'chat two'
    expect(memoModule.getChatBodyParseMemoKey(input)).not.toBe(selectedPromptKey)
  })

  it('invalidates parser settings when global regex changes', async () => {
    const char = seedDb()
    const globalScript = {
      id: 'global-regex',
      comment: '',
      in: 'GLOBAL',
      out: 'global one',
      type: 'editdisplay',
      flag: 'g',
      ableFlag: true,
    }
    getResourceDatabase().globalscript = [globalScript] as any

    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'global regex memo body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    const firstKey = memoModule.getChatBodyParseMemoKey(input)
    getResourceDatabase().globalscript[0].out = 'global two'

    expect(memoModule.getChatBodyParseMemoKey(input)).not.toBe(firstKey)
  })

  it('keys parser output by active chat scriptstate for synthetic greeting variables', async () => {
    const char = seedDb()
    char.chats.push({
      id: 'chat-body-parse-memo-empty-chat',
      name: 'Empty Variables Chat',
      message: [],
      note: '',
      localLore: [],
      fmIndex: -1,
      bookmarks: [],
      bookmarkNames: {},
    } as any)
    getResourceDatabase().characters[0].chats[0].scriptstate = { $choice: 'applied' }

    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'synthetic greeting body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: -1,
      cbsConditions: { firstmsg: true, chatRole: 'char' },
    }

    const populatedChatKey = memoModule.getChatBodyParseMemoKey(input)
    getResourceDatabase().characters[0].chatPage = 1
    const emptyChatKey = memoModule.getChatBodyParseMemoKey(input)
    expect(emptyChatKey).not.toBe(populatedChatKey)

    getResourceDatabase().characters[0].chatPage = 0
    getResourceDatabase().characters[0].chats[0].scriptstate = { $choice: 'changed' }
    const changedVariableKey = memoModule.getChatBodyParseMemoKey(input)
    expect(changedVariableKey).not.toBe(populatedChatKey)
    expect(changedVariableKey).not.toBe(emptyChatKey)
  })

  it('compacts heavy Lua source in parser signatures without losing invalidation', async () => {
    const char = seedDb()
    const makeHeavyLua = (marker: string) =>
      `function editDisplay(data)\n-- ${marker}\n${'local seed = 123456789\n'.repeat(12_000)}return data\nend`
    const makeHeavyReplacement = (marker: string) => `${marker}:${'replacement body\n'.repeat(4_000)}`
    char.triggerscript = [
      {
        id: 'heavy-lua-trigger',
        comment: 'heavy lua trigger',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'triggerlua', code: makeHeavyLua('HEAVY_LUA_SOURCE_A') }],
      },
    ] as any
    char.customscript = [
      {
        id: 'heavy-display-regex',
        comment: 'heavy regex',
        in: 'visible',
        out: makeHeavyReplacement('HEAVY_REGEX_SOURCE_A'),
        type: 'editdisplay',
        flag: '',
        ableFlag: false,
      },
    ] as any

    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'heavy lua memo body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    const keyA = memoModule.getChatBodyParseMemoKey(input)
    expect(keyA).not.toContain('HEAVY_LUA_SOURCE_A')
    expect(keyA).not.toContain('HEAVY_REGEX_SOURCE_A')
    expect(keyA.length).toBeLessThan(8_000)

    getResourceDatabase().characters[0].triggerscript = [
      {
        ...(getResourceDatabase().characters[0].triggerscript[0] as any),
        effect: [{ type: 'triggerlua', code: makeHeavyLua('HEAVY_LUA_SOURCE_B') }],
      },
    ] as any
    const keyB = memoModule.getChatBodyParseMemoKey(input)
    expect(keyB).not.toBe(keyA)
    expect(keyB).not.toContain('HEAVY_LUA_SOURCE_B')
    expect(keyB.length).toBeLessThan(8_000)

    getResourceDatabase().characters[0].customscript = [
      {
        ...(getResourceDatabase().characters[0].customscript[0] as any),
        out: makeHeavyReplacement('HEAVY_REGEX_SOURCE_B'),
      },
    ] as any
    const keyC = memoModule.getChatBodyParseMemoKey(input)
    expect(keyC).not.toBe(keyB)
    expect(keyC).not.toContain('HEAVY_REGEX_SOURCE_B')
    expect(keyC.length).toBeLessThan(8_000)
  })

  it('cached-only LLM detection reuses a prebuilt parse key without rebuilding it', async () => {
    const char = seedDb({
      autoTranslate: true,
      autoTranslateCachedOnly: true,
      translatorType: 'llm',
      translateBeforeHTMLFormatting: false,
      legacyTranslation: false,
      translator: 'ja',
    } as Partial<Database>)
    const parserModule = await import('../../ts/parser/parser.svelte')
    const parseSpy = vi
      .spyOn(parserModule, 'ParseMarkdown')
      .mockImplementation(async (data, _charArg, mode) => `parsed:${mode}:${data}`)
    const translatorModule = await import('../../ts/translator/translator')
    const getLLMCacheSpy = vi
      .spyOn(translatorModule, 'getLLMCache')
      .mockImplementation(async (text) => (text === 'parsed:pretranslate:prebuilt cached body' ? 'hit' : null))
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()

    const input = {
      data: 'prebuilt cached body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
      fallbackMode: 'notrim' as const,
    }
    const cachedOnlyParseKey = memoModule.getChatBodyParseMemoKey({
      data: input.data,
      charArg: input.charArg,
      owners: input.owners,
      mode: 'pretranslate',
      chatID: input.chatID,
      cbsConditions: input.cbsConditions,
    })
    expect(memoModule.getChatBodyParseMemoDebugStats().parseKeyBuilds).toBe(1)

    const detectionKey = memoModule.getChatBodyCachedOnlyLlmDetectionKey({
      ...input,
      cachedOnlyParseKey,
    })
    expect(memoModule.getChatBodyParseMemoDebugStats().parseKeyBuilds).toBe(1)

    await expect(
      memoModule.getChatBodyCachedOnlyLlmDecision({
        ...input,
        cachedOnlyParseKey,
        detectionKey,
      }),
    ).resolves.toBe(true)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)
    expect(memoModule.getChatBodyParseMemoDebugStats().parseKeyBuilds).toBe(1)

    await expect(
      memoModule.getChatBodyCachedOnlyLlmDecision({
        ...input,
        cachedOnlyParseKey,
        detectionKey,
      }),
    ).resolves.toBe(true)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)
    expect(memoModule.getChatBodyParseMemoDebugStats().parseKeyBuilds).toBe(1)
  })

  it.each([
    { autoTranslate: false, translatorType: 'llm', autoTranslateCachedOnly: true },
    { autoTranslate: false, translatorType: 'google', autoTranslateCachedOnly: false },
  ])('builds just the display parse key when automatic translation is disabled ($translatorType)', async (settings) => {
    const char = seedDb(settings as SeedDbOverrides)
    const { ChatBody, memoModule } = await loadChatBodyWithParseSpy()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mountChatBody(ChatBody, target, { character: char.chaId, msgDisplay: 'one display key' })
    try {
      await waitForText(target, 'one display key')
      expect(memoModule.getChatBodyParseMemoDebugStats().parseKeyBuilds).toBe(1)
    } finally {
      await unmount(component)
      target.remove()
    }
  })

  it('unchanged ChatBody remount performs zero additional ParseMarkdown calls', async () => {
    const char = seedDb()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()

    let component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'unchanged remount memo body',
    })
    await waitForText(target, 'unchanged remount memo body')
    expect(parseSpy.mock.calls.length).toBeGreaterThan(0)

    unmount(component)
    target.innerHTML = ''
    const callsBeforeRemount = parseSpy.mock.calls.length
    component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'unchanged remount memo body',
    })
    await waitForText(target, 'unchanged remount memo body')

    expect(parseSpy.mock.calls.length - callsBeforeRemount).toBe(0)
    unmount(component)
  })

  it('changed ChatBody content misses the parse memo and renders the new body', async () => {
    const char = seedDb()
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()

    let component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'initial memo body',
    })
    await waitForText(target, 'initial memo body')
    unmount(component)
    target.innerHTML = ''

    const callsBeforeChange = parseSpy.mock.calls.length
    component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'changed memo body',
    })
    await waitForText(target, 'changed memo body')

    expect(parseSpy.mock.calls.length - callsBeforeChange).toBe(1)
    expect(parseSpy.mock.calls.at(-1)?.[0]).toBe('changed memo body')
    unmount(component)
  })

  it('defers projected regex edits until the display activation epoch advances', async () => {
    const char = seedDb()
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].customscript = [
        {
          id: 'deferred-display-script',
          comment: 'Deferred display script',
          in: 'visible',
          out: 'initial',
          type: 'editdisplay',
          flag: 'g',
          ableFlag: true,
        },
      ]
    })
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()
    const component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'visible body',
    })
    await waitForText(target, 'initial body')
    parseSpy.mockClear()

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].customscript![0].out = 'activated'
    })
    await settleRenderWork()

    expect(parseSpy).not.toHaveBeenCalled()
    expect(target.textContent).toContain('initial body')

    RegexDisplayReloadPointer.update((value) => value + 1)
    await waitForText(target, 'activated body')

    expect(parseSpy).toHaveBeenCalledOnce()
    unmount(component)
  })

  it('re-renders an open message when sentence paragraph display settings change', async () => {
    const char = seedDb({
      paragraphBreakBySentences: false,
      paragraphBreakSentenceCount: 2,
    })
    const target = document.createElement('div')
    document.body.appendChild(target)
    const { ChatBody, parseSpy } = await loadChatBodyWithParseSpy()
    const component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'First sentence. Second sentence. Third sentence.',
    })

    await waitForParagraphCount(target, 1)
    parseSpy.mockClear()
    withTestDatabaseWrite(() => {
      getResourceDatabase().paragraphBreakBySentences = true
    })
    reloadRegexDisplay()
    await waitForParagraphCount(target, 2)

    expect(parseSpy).toHaveBeenCalledOnce()
    expect([...target.querySelectorAll('p')].map((paragraph) => paragraph.textContent)).toEqual([
      'First sentence. Second sentence.',
      'Third sentence.',
    ])
    unmount(component)
  })

  it('cached-only LLM detection shares in-flight parse work and hits the resolved memo', async () => {
    const char = seedDb({
      autoTranslate: true,
      autoTranslateCachedOnly: true,
      translatorType: 'llm',
      translateBeforeHTMLFormatting: false,
      legacyTranslation: false,
      translator: 'ja',
    } as Partial<Database>)
    const parserModule = await import('../../ts/parser/parser.svelte')
    const parseSpy = vi
      .spyOn(parserModule, 'ParseMarkdown')
      .mockImplementation(async (data, _charArg, mode) => `parsed:${mode}:${data}`)
    const translatorModule = await import('../../ts/translator/translator')
    const getLLMCacheSpy = vi
      .spyOn(translatorModule, 'getLLMCache')
      .mockImplementation(async (text) => (text.includes('cached body') ? 'hit' : null))
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()

    const input = {
      data: 'cached body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
      fallbackMode: 'notrim' as const,
    }
    const first = memoModule.getChatBodyCachedOnlyLlmDecision(input)
    const second = memoModule.getChatBodyCachedOnlyLlmDecision(input)

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)

    await expect(memoModule.getChatBodyCachedOnlyLlmDecision(input)).resolves.toBe(true)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)

    await expect(
      memoModule.getChatBodyCachedOnlyLlmDecision({
        ...input,
        data: 'uncached changed body',
      }),
    ).resolves.toBe(false)
    expect(parseSpy).toHaveBeenCalledTimes(2)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(2)
  })

  it('LLM cache import and clear invalidate cached-only decisions', async () => {
    const char = seedDb({
      autoTranslate: true,
      autoTranslateCachedOnly: true,
      translatorType: 'llm',
      translateBeforeHTMLFormatting: false,
      legacyTranslation: false,
      translator: 'ja',
    } as Partial<Database>)
    const parserModule = await import('../../ts/parser/parser.svelte')
    vi.spyOn(parserModule, 'ParseMarkdown').mockImplementation(async (data, _charArg, mode) => `parsed:${mode}:${data}`)
    const translatorModule = await import('../../ts/translator/translator')
    const setItemSpy = vi
      .spyOn(translatorModule.LLMCacheStorage, 'setItem')
      .mockImplementation(async <T>(_key: string, value: T) => value)
    const clearSpy = vi.spyOn(translatorModule.LLMCacheStorage, 'clear').mockResolvedValue(undefined)
    const getLLMCacheSpy = vi
      .spyOn(translatorModule, 'getLLMCache')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('hit')
      .mockResolvedValueOnce(null)
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()

    const input = {
      data: 'epoch cached body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
      fallbackMode: 'notrim' as const,
    }
    await expect(memoModule.getChatBodyCachedOnlyLlmDecision(input)).resolves.toBe(false)
    await expect(memoModule.getChatBodyCachedOnlyLlmDecision(input)).resolves.toBe(false)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)

    const importEpochBefore = translatorModule.getLLMCacheMutationEpoch()
    await expect(
      translatorModule.importLLMCacheFromJSON({
        'parsed:pretranslate:epoch cached body': 'translated epoch body',
      }),
    ).resolves.toEqual({ count: 1, failed: 0 })
    expect(translatorModule.getLLMCacheMutationEpoch()).toBe(importEpochBefore + 1)

    await expect(memoModule.getChatBodyCachedOnlyLlmDecision(input)).resolves.toBe(true)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(2)
    expect(setItemSpy).toHaveBeenCalledWith('parsed:pretranslate:epoch cached body', 'translated epoch body')

    const clearEpochBefore = translatorModule.getLLMCacheMutationEpoch()
    await translatorModule.clearLLMCache()
    expect(translatorModule.getLLMCacheMutationEpoch()).toBe(clearEpochBefore + 1)

    await expect(memoModule.getChatBodyCachedOnlyLlmDecision(input)).resolves.toBe(false)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(3)
    expect(clearSpy).toHaveBeenCalledTimes(1)
  })

  it('fails closed on duplicate character owners before invoking the parser', async () => {
    const char = seedDb()
    getResourceDatabase().characters.push(structuredClone(char))
    const parserModule = await import('../../ts/parser/parser.svelte')
    const parseSpy = vi.spyOn(parserModule, 'ParseMarkdown').mockResolvedValue('ownerless parse')
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const owners = memoModule.createChatBodyParseOwnerReaders()

    expect(owners.characterOwner(char.chaId)).toBeUndefined()
    expect(owners.activeCharacterOwner()).toBeUndefined()
    await memoModule.memoizedChatBodyParse({
      data: 'duplicate owner body',
      charArg: char.chaId,
      owners,
      mode: 'notrim',
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    })

    expect(parseSpy).toHaveBeenCalledWith(
      'duplicate owner body',
      null,
      'notrim',
      0,
      { firstmsg: false, chatRole: 'char' },
      expect.any(Object),
    )
  })

  it('fails closed on duplicate active chat IDs', async () => {
    seedDb()
    const ownerCharacter = getResourceDatabase().characters[0]
    ownerCharacter.chats.push({
      ...(JSON.parse(JSON.stringify(ownerCharacter.chats[0])) as (typeof ownerCharacter.chats)[number]),
      name: 'Duplicate chat',
    })
    const memoModule = await import('./ChatBodyParseMemo')
    const owners = memoModule.createChatBodyParseOwnerReaders()

    expect(owners.activeCharacterOwner()?.chaId).toBe(ownerCharacter.chaId)
    expect(owners.activeChatOwner()).toBeUndefined()
  })

  it('keys display settings from the explicit settings owner', async () => {
    const char = seedDb({ customQuotes: false })
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    let settingsOwner: Partial<Database> = { customQuotes: false }
    const owners = {
      ...memoModule.createChatBodyParseOwnerReaders(),
      settingsOwner: () => settingsOwner,
    }
    const input = {
      data: 'explicit settings owner body',
      charArg: char.chaId,
      owners,
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    const initialKey = memoModule.getChatBodyParseMemoKey(input)
    getResourceDatabase().customQuotes = true
    expect(memoModule.getChatBodyParseMemoKey(input)).toBe(initialKey)

    settingsOwner = { customQuotes: true }
    expect(memoModule.getChatBodyParseMemoKey(input)).not.toBe(initialKey)
  })

  it('keys identical rendered rows by their explicit owning chat', async () => {
    const char = seedDb()
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const input = {
      data: 'shared cloned row body',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
      chatId: 'chat-a1',
      messageId: 'shared-message',
    }

    const firstChatKey = memoModule.getChatBodyParseMemoKey(input)
    const secondChatKey = memoModule.getChatBodyParseMemoKey({ ...input, chatId: 'chat-a2' })

    expect(secondChatKey).not.toBe(firstChatKey)
  })

  it('explicit retranslate still calls translateHTML with regenerate enabled', async () => {
    const char = seedDb({
      autoTranslate: true,
      autoTranslateCachedOnly: true,
      translatorType: 'llm',
      translateBeforeHTMLFormatting: false,
      legacyTranslation: false,
      translator: 'ja',
    } as Partial<Database>)
    const parserModule = await import('../../ts/parser/parser.svelte')
    vi.spyOn(parserModule, 'ParseMarkdown').mockImplementation(async (data) => `<p>${data}</p>`)
    const translatorModule = await import('../../ts/translator/translator')
    await translatorModule.setLLMCache(explicitRetranslateCacheKey, 'cached hit')
    translateHTMLMock.implementation = async () => 'explicit translated body'
    const memoModule = await import('./ChatBodyParseMemo')
    memoModule.clearChatBodyParseMemo()
    const { default: ChatBody } = await import('./ChatBody.svelte')
    const target = document.createElement('div')
    document.body.appendChild(target)

    const component = mountChatBody(ChatBody, target, {
      character: char.chaId,
      msgDisplay: 'explicit source body',
      translated: true,
      retranslate: true,
    })
    await waitForText(target, 'explicit translated body')

    expect(translateHTMLMock.calls).toContainEqual(['<p>explicit source body</p>', false, char.chaId, 0, true])
    unmount(component)
  })
})
