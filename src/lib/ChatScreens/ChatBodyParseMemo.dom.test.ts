import { moduleMockState, seedDb, setupParseMemoTests } from './chatBodyParseMemoTestFixtures'
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../../ts/storage/database.svelte'
import {
  charactersResourceState,
  applyCollectionsResource,
  collectionsResourceState,
} from '../../ts/server/resourceState.svelte'
import { createChatReadOwners } from './chatReadOwners.svelte'
import { ReloadGUIPointer, VariableReloadGUIPointer } from '../../ts/stores.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'
import { invalidateModuleRenderRevision } from '../../ts/moduleRenderRevision'

setupParseMemoTests()

describe('ChatBody parse memo', () => {
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

  it('recomputes finalized HTML after streamed display results are invalidated', async () => {
    const character = seedDb()
    const memo = await import('./ChatBodyParseMemo')
    const bridge = await import('../../ts/server/displaySources')
    const parser = await import('../../ts/parser/parser.svelte')
    const epoch = vi.spyOn(bridge, 'captureDisplaySourceRenderEpoch').mockReturnValue('test:before')
    const parse = vi
      .spyOn(parser, 'ParseMarkdown')
      .mockResolvedValueOnce('old projection')
      .mockResolvedValueOnce('fresh projection')
    const input = {
      data: 'unchanged source',
      charArg: character.chaId,
      owners: memo.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('old projection')
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('old projection')
    epoch.mockReturnValue('test:after')
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('fresh projection')
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

  it.each([
    [
      'character regex',
      () => {
        getResourceDatabase().characters[0].customscript[0].out = 'after'
      },
    ],
    [
      'character trigger',
      () => {
        getResourceDatabase().characters[0].triggerscript[0].effect = [
          { type: 'triggerlua', code: 'return "after"' },
        ] as any
      },
    ],
    [
      'character asset',
      () => {
        getResourceDatabase().characters[0].additionalAssets![0][1] = 'after'
      },
    ],
    [
      'display settings',
      () => {
        getResourceDatabase().customQuotes = true
      },
    ],
    [
      'GUI reload',
      () => {
        ReloadGUIPointer.update((value) => value + 1)
      },
    ],
    [
      'variable reload',
      () => {
        VariableReloadGUIPointer.update((value) => value + 1)
      },
    ],
  ])('refreshes cached results after %s changes', async (_name, change) => {
    const char = seedDb()
    char.customscript = [
      { id: 'regex', comment: '', in: 'visible', out: 'before', type: 'editdisplay', flag: '', ableFlag: false },
    ]
    char.triggerscript = [{ id: 'trigger', comment: '', type: 'manual', conditions: [], effect: [] }] as any
    char.additionalAssets = [['portrait', 'before', 'png']]
    const parser = await import('../../ts/parser/parser.svelte')
    // A distinct result exposes stale memo reuse without duplicating parser semantics.
    const parse = vi.spyOn(parser, 'ParseMarkdown').mockResolvedValueOnce('before').mockResolvedValueOnce('after')
    const memo = await import('./ChatBodyParseMemo')
    const input = {
      data: 'visible',
      charArg: char.chaId,
      owners: memo.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: {},
    }
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('before')
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('before')
    expect(parse).toHaveBeenCalledTimes(1)
    change()
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('after')
    await expect(memo.memoizedChatBodyParse(input)).resolves.toBe('after')
    expect(parse).toHaveBeenCalledTimes(2)
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
    // A per-row key must remain small even when the shared asset corpus is huge.
    expect(firstKey.length).toBeLessThan(8_000)

    moduleAssets[129_999][1] = 'changed-server-asset'
    invalidateModuleRenderRevision()
    const changedKey = memoModule.getChatBodyParseMemoKey(input)
    expect(changedKey).not.toBe(firstKey)
    expect(changedKey).not.toContain('changed-server-asset')
    expect(changedKey.length).toBeLessThan(8_000)
  })

  it('refreshes cached results when a module collection update is applied', async () => {
    const char = seedDb()
    const parserModule = await import('../../ts/parser/parser.svelte')
    const parseSpy = vi
      .spyOn(parserModule, 'ParseMarkdown')
      .mockResolvedValueOnce('before module update')
      .mockResolvedValueOnce('after module update')
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

    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toBe('before module update')

    // Exercise the production resource-apply boundary, including its invalidation signal.
    expect(
      applyCollectionsResource(
        {
          revision: (collectionsResourceState.revisions.modules ?? 0) + 1,
          collections: { modules: [{ id: 'updated-module', name: 'Updated', description: '', regex: [] }] },
        },
        'modules',
      ),
    ).toBe(true)
    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toBe('after module update')

    expect(parseSpy).toHaveBeenCalledTimes(2)
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

    // Budget retained key strings, not parser results or total process memory.
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

  it('renders both paragraph preferences and preserves legacy defaults', async () => {
    const char = seedDb()
    const memo = await import('./ChatBodyParseMemo')
    const input = {
      data: 'First sentence. Second sentence. Third sentence. Fourth sentence.',
      charArg: char.chaId,
      owners: memo.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: {},
    }
    const paragraphs = async () => {
      const element = document.createElement('div')
      element.innerHTML = await memo.memoizedChatBodyParse(input)
      return [...element.querySelectorAll('p')].map((p) => p.textContent)
    }
    const database = getResourceDatabase()
    delete database.paragraphBreakBySentences
    delete database.paragraphBreakSentenceCount
    expect(await paragraphs()).toEqual([input.data])
    database.paragraphBreakBySentences = false
    database.paragraphBreakSentenceCount = 3
    expect(await paragraphs()).toEqual([input.data])
    database.paragraphBreakBySentences = true
    expect(await paragraphs()).toEqual(['First sentence. Second sentence. Third sentence.', 'Fourth sentence.'])
    database.paragraphBreakSentenceCount = 2
    expect(await paragraphs()).toEqual(['First sentence. Second sentence.', 'Third sentence. Fourth sentence.'])
  })

  it('renders with the selected prompt regex and ignores inactive preset changes', async () => {
    const char = seedDb()
    const script = (id: string, out: string) => ({
      id,
      comment: '',
      in: 'visible',
      out,
      type: 'editdisplay',
      flag: 'g',
      ableFlag: true,
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
      data: 'visible',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('chat one')
    getResourceDatabase().presetRegex[0].out = 'global two'
    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('chat one')
    ;(getResourceDatabase().promptPresets[0] as any).presetRegex[0].out = 'chat two'
    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('chat two')
  })

  it('renders updated global regex replacements', async () => {
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
      data: 'GLOBAL',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: 0,
      cbsConditions: { firstmsg: false, chatRole: 'char' },
    }

    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('global one')
    getResourceDatabase().globalscript[0].out = 'global two'

    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('global two')
  })

  it('renders greeting variables from the active chat and refreshes changed values', async () => {
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
      data: 'Choice: {{getvar::choice}}',
      charArg: char.chaId,
      owners: memoModule.createChatBodyParseOwnerReaders(),
      mode: 'notrim' as const,
      chatID: -1,
      cbsConditions: { firstmsg: true, chatRole: 'char' },
    }

    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('Choice: applied')
    getResourceDatabase().characters[0].chatPage = 1
    const emptyGreeting = await memoModule.memoizedChatBodyParse(input)
    expect(emptyGreeting).not.toContain('applied')

    getResourceDatabase().characters[0].chatPage = 0
    getResourceDatabase().characters[0].chats[0].scriptstate = { $choice: 'changed' }
    await expect(memoModule.memoizedChatBodyParse(input)).resolves.toContain('Choice: changed')
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

  it('cached-only LLM detection accepts prebuilt keys and reuses expensive work', async () => {
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

    const detectionKey = memoModule.getChatBodyCachedOnlyLlmDetectionKey({
      ...input,
      cachedOnlyParseKey,
    })

    await expect(
      memoModule.getChatBodyCachedOnlyLlmDecision({
        ...input,
        cachedOnlyParseKey,
        detectionKey,
      }),
    ).resolves.toBe(true)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)

    await expect(
      memoModule.getChatBodyCachedOnlyLlmDecision({
        ...input,
        cachedOnlyParseKey,
        detectionKey,
      }),
    ).resolves.toBe(true)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(getLLMCacheSpy).toHaveBeenCalledTimes(1)
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
    getResourceDatabase().characters.push(getResourceDatabase({ snapshot: true }).characters[0])
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
})
