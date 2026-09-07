import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  function makeStore<T>(initial: T) {
    let value = initial
    const subscribers = new Set<(value: T) => void>()
    return {
      subscribe(callback: (value: T) => void) {
        callback(value)
        subscribers.add(callback)
        return () => subscribers.delete(callback)
      },
      set(next: T) {
        value = next
        for (const callback of subscribers) {
          callback(value)
        }
      },
      update(updater: (value: T) => T) {
        this.set(updater(value))
      },
    }
  }

  const llmCache = new Map<string, unknown>()
  const storage = {
    getItem: vi.fn(async (key: string) => llmCache.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      llmCache.set(key, value)
      return value
    }),
    removeItem: vi.fn(async (key: string) => {
      llmCache.delete(key)
    }),
    clear: vi.fn(async () => {
      llmCache.clear()
    }),
    iterate: vi.fn(async (callback: (value: unknown, key: string) => void) => {
      for (const [key, value] of llmCache.entries()) {
        callback(value, key)
      }
    }),
  }

  return {
    db: {} as any,
    resourceStatus: {
      settings: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
      collections: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
      characters: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
    },
    selectedCharID: makeStore(0),
    globalFetch: vi.fn(),
    requestProviderOperation: vi.fn(),
    providerOperationCredential: vi.fn(),
    alertError: vi.fn(),
    requestChatData: vi.fn(),
    processScriptFull: vi.fn(async (_char: unknown, text: string) => ({ data: text })),
    applyMarkdownToNode: vi.fn(),
    llmCache,
    storage,
  }
})

vi.mock('../storage/database.svelte', () => ({
  getDatabase: (options: { snapshot?: boolean } = {}) =>
    options.snapshot ? JSON.parse(JSON.stringify(testState.db)) : testState.db,
  getCurrentChat: () => {
    const character = testState.db.characters?.[0]
    return character?.chats?.[character.chatPage]
  },
}))

vi.mock('../stores.svelte', () => ({
  selectedCharID: testState.selectedCharID,
}))

vi.mock('../server/resourceState.svelte', () => ({
  settingsResourceState: {
    get status() {
      return testState.resourceStatus.settings
    },
    get value() {
      return testState.db
    },
  },
  collectionsResourceState: {
    get status() {
      return testState.resourceStatus.collections
    },
    get values() {
      return testState.db
    },
  },
  charactersResourceState: {
    get status() {
      return testState.resourceStatus.characters
    },
    get characters() {
      return testState.db.characters ?? []
    },
    get characterOrder() {
      return testState.db.characterOrder ?? []
    },
    currentChar: 0,
  },
  getResourceDatabase: (options: { snapshot?: boolean } = {}) =>
    options.snapshot ? JSON.parse(JSON.stringify(testState.db)) : testState.db,
  getCharacterResourceOwner: (characterId: string) => {
    const matches = (testState.db.characters ?? []).filter(
      (character: { chaId?: string }) => character.chaId === characterId,
    )
    return matches.length === 1 ? matches[0] : undefined
  },
  getChatMetadataOwnerState: (chatId: string) => {
    const matches = (testState.db.characters ?? []).flatMap((character: { chats?: Array<{ id?: string }> }) =>
      (character.chats ?? []).filter((chat) => chat.id === chatId),
    )
    return matches.length === 1 ? { chatId } : undefined
  },
}))

vi.mock('../chatCommands', () => ({
  captureActiveChatTarget: () => {
    const character = testState.db.characters?.[0]
    const chatPage = character?.chatPage ?? 0
    const chat = character?.chats?.[chatPage]
    if (!character || !chat) return null
    return {
      selectedCharID: 0,
      chatPage,
      characterId: character.chaId,
      chatId: chat.id,
    }
  },
}))

vi.mock('../globalApi.svelte', () => ({
  globalFetch: testState.globalFetch,
}))

vi.mock('../server/providerOperations', () => ({
  requestProviderOperation: testState.requestProviderOperation,
  providerOperationCredential: testState.providerOperationCredential,
}))

vi.mock('../alert', () => ({
  alertError: testState.alertError,
}))

vi.mock('../process/request/request', () => ({
  requestChatData: testState.requestChatData,
}))

vi.mock('../parser/parser.svelte', () => ({
  applyMarkdownToNode: testState.applyMarkdownToNode,
}))

vi.mock('../process/modules', () => ({
  getModuleRegexScripts: () => [],
}))

vi.mock('../util', () => ({
  getNodetextToSentence: (node: { textContent?: string | null }) => node.textContent ?? '',
  sleep: vi.fn(async () => {}),
}))

vi.mock('../process/scripts', () => ({
  processScriptFull: testState.processScriptFull,
}))

vi.mock('localforage', () => ({
  default: {
    createInstance: () => testState.storage,
  },
}))

vi.mock('../../etc/send.mp3', () => ({
  default: 'send.mp3',
}))

import {
  LLM_TRANSLATE_CACHE_MAX_ENTRIES,
  TRANSLATE_CACHE_MAX_ENTRIES,
  __translatorTestHooks,
  getLLMCache,
  getCurrentTranslatorPreset,
  getTranslatorSettingsSignatureKey,
  runTranslator,
  setLLMCache,
  translate,
  translateHTML,
} from './translator'
import { createTranslatorPreset } from './presets'
import { resetChatGenerationActivitiesForTests } from '../process/generationActivity.svelte'

function resetDatabase() {
  Object.assign(testState.db, {
    translator: 'ko',
    translatorInputLanguage: 'ja',
    translatorType: 'google',
    translatorSendTextAsIs: false,
    translatorExcludeThoughts: false,
    aiModel: 'openai',
    subModel: 'echo_model',
    modelRoles: {},
    modelProfiles: [],
    modelRoleProfiles: {},
    modelRuntimeDefaults: undefined,
    seperateModelsForAxModels: false,
    seperateModels: {
      memory: '',
      emotion: '',
      translate: '',
      otherAx: '',
      scriptMain: '',
      scriptAux: '',
    },
    customModels: [],
    useExperimentalGoogleTranslator: false,
    noWaitForTranslate: true,
    combineTranslation: false,
    htmlTranslation: false,
    playMessageOnTranslateEnd: false,
    translatorPrompt: '',
    translatorMaxResponse: 1000,
    translatorPresets: [createTranslatorPreset('Default', { id: 'default', prompt: 'Default {{slot}}' })],
    translatorPresetId: 'default',
    deeplOptions: { freeApi: true, key: '' },
    deeplXOptions: { url: '', token: '' },
    characters: [
      {
        type: 'character',
        chaId: 'char-a',
        chatPage: 0,
        chats: [
          { id: 'chat-a', message: [] },
          { id: 'chat-b', message: [] },
        ],
        customscript: [],
        virtualscript: null,
        emotionImages: [],
      },
    ],
  })
}

function stubGoogleFetch() {
  const seen = new Map<string, number>()
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input))
    const text = url.searchParams.get('q') ?? ''
    const target = url.searchParams.get('tl') ?? ''
    const key = `${target}:${text}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    return {
      json: async () => [[[`translated:${key}:${count}`]]],
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('auto-translate cache', () => {
  beforeEach(() => {
    resetDatabase()
    testState.resourceStatus.settings = 'ready'
    testState.resourceStatus.collections = 'ready'
    testState.resourceStatus.characters = 'ready'
    testState.selectedCharID.set(0)
    resetChatGenerationActivitiesForTests()
    testState.llmCache.clear()
    __translatorTestHooks.clearTranslateCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('dedupes repeated and concurrent translation lookups', async () => {
    const fetchMock = stubGoogleFetch()

    const [first, second] = await Promise.all([
      translate('same pending line', false),
      translate('same pending line', false),
    ])
    const third = await translate('same pending line', false)

    expect(first).toBe('translated:ko:same pending line:1')
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(__translatorTestHooks.getTranslateCacheEntries()).toHaveLength(1)
  })

  it.each(['idle', 'loading', 'error'] as const)(
    'does not translate through retained aggregate values while a resource owner is %s',
    async (status) => {
      const fetchMock = stubGoogleFetch()
      testState.resourceStatus.settings = status

      await expect(translate('retained text', false)).resolves.toBe('retained text')

      expect(fetchMock).not.toHaveBeenCalled()
      expect(__translatorTestHooks.getTranslateCacheEntries()).toHaveLength(0)
    },
  )

  it('reuses cached translations, refreshes hits, and deterministically evicts the oldest cold entry', async () => {
    const fetchMock = stubGoogleFetch()

    for (let i = 0; i < TRANSLATE_CACHE_MAX_ENTRIES; i++) {
      await translate(`entry-${i}`, false)
    }

    await translate('entry-0', false)
    await translate(`entry-${TRANSLATE_CACHE_MAX_ENTRIES}`, false)
    await translate('entry-1', false)
    await translate('entry-0', false)

    expect(fetchMock).toHaveBeenCalledTimes(TRANSLATE_CACHE_MAX_ENTRIES + 2)
    const entries = __translatorTestHooks.getTranslateCacheEntries()
    expect(entries).toHaveLength(TRANSLATE_CACHE_MAX_ENTRIES)
    expect(entries.some(([key]) => key.includes('"text":"entry-0"'))).toBe(true)
    expect(entries.some(([key]) => key.includes('"text":"entry-1"'))).toBe(true)
    expect(entries.some(([key]) => key.includes('"text":"entry-2"'))).toBe(false)
  })

  it('keeps forward and reverse translation cache keys separate', async () => {
    const fetchMock = stubGoogleFetch()

    const forward = await translate('shared text', false)
    const reverse = await translate('shared text', true)
    const forwardHit = await translate('shared text', false)
    const reverseHit = await translate('shared text', true)

    expect(forward).toBe('translated:ko:shared text:1')
    expect(reverse).toBe('translated:en:shared text:1')
    expect(forwardHit).toBe(forward)
    expect(reverseHit).toBe(reverse)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const keys = __translatorTestHooks.getTranslateCacheEntries().map(([key]) => JSON.parse(key))
    expect(keys).toMatchObject([
      { reverse: false, text: 'shared text' },
      { reverse: true, text: 'shared text' },
    ])
  })

  it('clears the auto-translate cache when the active chat changes', async () => {
    const fetchMock = stubGoogleFetch()

    const first = await translate('scoped text', false)
    const firstHit = await translate('scoped text', false)
    testState.db.characters[0].chatPage = 1
    const secondChat = await translate('scoped text', false)
    testState.db.characters[0].chatPage = 0
    const firstChatAgain = await translate('scoped text', false)

    expect(first).toBe('translated:ko:scoped text:1')
    expect(firstHit).toBe(first)
    expect(secondChat).toBe('translated:ko:scoped text:2')
    expect(firstChatAgain).toBe('translated:ko:scoped text:3')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(__translatorTestHooks.getTranslateCacheEntries()).toHaveLength(1)
  })

  it('separates completed LLM translations after prompt or character-note edits', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorPresets = [
      createTranslatorPreset('Active', { id: 'preset-a', prompt: 'Prompt A {{slot}}', maxResponse: 100 }),
    ]
    testState.db.translatorPresetId = 'preset-a'
    testState.db.characters[0].translatorNote = 'Note A'
    let callCount = 0
    testState.requestChatData.mockImplementation(async () => ({
      type: 'success',
      result: `translation-${++callCount}`,
    }))

    await expect(translate('same text', false)).resolves.toBe('translation-1')
    testState.db.translatorPresets[0].steps[0].prompt = 'Prompt B {{slot}}'
    await expect(translate('same text', false)).resolves.toBe('translation-2')
    testState.db.characters[0].translatorNote = 'Note B'
    await expect(translate('same text', false)).resolves.toBe('translation-3')

    expect(testState.requestChatData).toHaveBeenCalledTimes(3)
  })

  it('uses the active chat binding in browser pipeline and cache signatures', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorPresets = [
      createTranslatorPreset('Global', {
        id: 'global-preset',
        prompt: 'Global {{slot::content}}',
        maxResponse: 100,
      }),
      createTranslatorPreset('Chat', {
        id: 'chat-preset',
        prompt: 'Chat {{slot::content}}',
        maxResponse: 100,
      }),
    ]
    testState.db.translatorPresetId = 'global-preset'
    testState.db.characters[0].chats[0].translatorPresetId = 'chat-preset'
    testState.requestChatData.mockImplementation(async () => ({
      type: 'success',
      result: `translation-${testState.requestChatData.mock.calls.length}`,
    }))

    const chatSignature = getTranslatorSettingsSignatureKey(testState.db)
    await translate('same text', false)
    testState.db.characters[0].chatPage = 1
    const globalSignature = getTranslatorSettingsSignatureKey(testState.db)
    await translate('same text', false)

    expect(chatSignature).not.toBe(globalSignature)
    expect(testState.requestChatData).toHaveBeenCalledTimes(2)
    expect(testState.requestChatData.mock.calls[0][0].formated[0].content).toBe('Chat same text')
    expect(testState.requestChatData.mock.calls[1][0].formated[0].content).toBe('Global same text')
  })

  it('does not share an in-flight LLM translation after the active prompt changes', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorPresets = [
      createTranslatorPreset('Active', { id: 'preset-a', prompt: 'Prompt A {{slot}}', maxResponse: 100 }),
    ]
    testState.db.translatorPresetId = 'preset-a'
    const resolvers: Array<(value: { type: 'success'; result: string }) => void> = []
    testState.requestChatData.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const first = translate('pending text', false)
    await vi.waitFor(() => expect(testState.requestChatData).toHaveBeenCalledTimes(1))
    testState.db.translatorPresets[0].steps[0].prompt = 'Prompt B {{slot}}'
    const second = translate('pending text', false)
    await vi.waitFor(() => expect(testState.requestChatData).toHaveBeenCalledTimes(2))

    resolvers[0]({ type: 'success', result: 'first' })
    resolvers[1]({ type: 'success', result: 'second' })
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
  })

  it('invalidates every LLM cache layer for pipeline runtime edits but not unrelated settings', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorPresets = [
      createTranslatorPreset('Active', {
        id: 'preset-a',
        steps: [
          {
            id: 'step-a',
            name: 'Draft',
            enabled: true,
            prompt: 'Prompt {{slot::prev}}',
            maxResponse: 100,
            model: { mode: 'inheritTranslate' },
            outputKey: 'draft',
          },
        ],
      }),
    ]
    testState.db.translatorPresetId = 'preset-a'
    let callCount = 0
    testState.requestChatData.mockImplementation(async () => ({
      type: 'success',
      result: `pipeline-${++callCount}`,
    }))

    const mutations = [
      (step: any) => (step.prompt = 'Changed prompt {{slot::prev}}'),
      (step: any) => (step.maxResponse = 200),
      (step: any) => (step.model = { mode: 'modelProfile', profileId: 'missing-profile' }),
      (step: any) => (step.enabled = false),
      (step: any) => (step.outputKey = 'renamed'),
    ]

    for (const [index, mutate] of mutations.entries()) {
      const text = `<p>pipeline-signature-${index}</p>`
      const beforeSettingsSignature = getTranslatorSettingsSignatureKey(testState.db)
      const beforeMemoKey = __translatorTestHooks.getCurrentTranslateHTMLMemoKey(text)
      const beforeKey = __translatorTestHooks.getCurrentLLMTranslationCacheKey(text)
      await translateHTML(text, false, '', 0)
      mutate(testState.db.translatorPresets[0].steps[0])
      const afterKey = __translatorTestHooks.getCurrentLLMTranslationCacheKey(text)
      expect(getTranslatorSettingsSignatureKey(testState.db)).not.toBe(beforeSettingsSignature)
      expect(__translatorTestHooks.getCurrentTranslateHTMLMemoKey(text)).not.toBe(beforeMemoKey)
      expect(afterKey).not.toBe(beforeKey)
      await translateHTML(text, false, '', 0)
      const callsAfterPipelineEdit = callCount
      testState.db.backgroundHTML = `unrelated-${index}`
      expect(__translatorTestHooks.getCurrentLLMTranslationCacheKey(text)).toBe(afterKey)
      await translateHTML(text, false, '', 0)
      expect(callCount).toBe(callsAfterPipelineEdit)
    }

    const labelText = '<p>pipeline-labels</p>'
    const settingsSignature = getTranslatorSettingsSignatureKey(testState.db)
    const memoKey = __translatorTestHooks.getCurrentTranslateHTMLMemoKey(labelText)
    const llmKey = __translatorTestHooks.getCurrentLLMTranslationCacheKey(labelText)
    testState.db.translatorPresets[0].name = 'Renamed preset'
    testState.db.translatorPresets[0].steps[0].id = 'renamed-step-id'
    testState.db.translatorPresets[0].steps[0].name = 'Renamed step'
    expect(getTranslatorSettingsSignatureKey(testState.db)).toBe(settingsSignature)
    expect(__translatorTestHooks.getCurrentTranslateHTMLMemoKey(labelText)).toBe(memoKey)
    expect(__translatorTestHooks.getCurrentLLMTranslationCacheKey(labelText)).toBe(llmKey)
  })

  it('separates LLM translation cache entries by translator signature', async () => {
    testState.db.translatorType = 'llm'
    testState.requestChatData.mockImplementation(async () => ({
      type: 'success',
      result: `<p>llm:${testState.db.translator}</p>`,
    }))

    const first = await translateHTML('<p>shared llm body</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translator = 'fr'
    const second = await translateHTML('<p>shared llm body</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translator = 'ko'
    const firstAgain = await translateHTML('<p>shared llm body</p>', false, '', 0)

    expect(first).toBe('<p>llm:ko</p>')
    expect(second).toBe('<p>llm:fr</p>')
    expect(firstAgain).toBe(first)
    expect(testState.requestChatData).toHaveBeenCalledTimes(2)
  })

  it('separates LLM translation caches between normal and send-text-as-is modes', async () => {
    testState.db.translatorType = 'llm'
    testState.requestChatData.mockImplementation(async () => ({
      type: 'success',
      result: testState.db.translatorSendTextAsIs ? '  as-is response\n' : 'normal response',
    }))

    const normal = await translateHTML('same source', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translatorSendTextAsIs = true
    const asIs = await translateHTML('same source', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translatorSendTextAsIs = false
    const normalAgain = await translateHTML('same source', false, '', 0)

    expect(normal).toBe('normal response')
    expect(asIs).toBe('  as-is response\n')
    expect(normalAgain).toBe(normal)
    expect(testState.requestChatData).toHaveBeenCalledTimes(2)
  })

  it('rejects the removed client raw-translation fallback for LLM send-text-as-is', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorSendTextAsIs = true
    const text = ['  before', '{{img::assets/image.png}}', '', '{{raw::keep this}}', 'after  '].join('\n')

    await expect(runTranslator(text, false, 'ko', 'en')).rejects.toThrow(
      'LLM Send Text As-Is raw translation requires the server message translation command.',
    )
    expect(testState.requestChatData).not.toHaveBeenCalled()
    expect(__translatorTestHooks.getTranslateCacheEntries()).toEqual([])
  })

  it('uses untouched LLM input and output without style placeholders or edit-translation regexes in as-is mode', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorSendTextAsIs = true
    testState.db.characters[0].customscript = [
      {
        id: 'must-not-run',
        comment: '',
        in: 'RAW',
        out: 'EDITED',
        type: 'edittrans',
        flag: '',
        ableFlag: false,
      },
    ]
    const text = '<risu-style>color:red</risu-style> source'
    const rawResponse = '  RAW <style-data style-index="0"></style-data>\n'
    testState.requestChatData.mockResolvedValue({ type: 'success', result: rawResponse })

    const result = await translateHTML(text, false, 'char-a', 0)

    expect(testState.requestChatData.mock.calls[0][0].formated).toContainEqual({ role: 'user', content: text })
    expect(result).toBe(rawResponse)
  })

  it('removes internal reasoning from browser LLM source text when send-text-as-is exclusion is enabled', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorSendTextAsIs = true
    testState.db.translatorExcludeThoughts = true
    const text = '<Thoughts>private</Thoughts>\nvisible source\n<think>private tail</think>'
    testState.requestChatData.mockResolvedValue({ type: 'success', result: 'translated' })

    const result = await translateHTML(text, false, 'char-a', 0)

    expect(testState.requestChatData.mock.calls[0][0].formated).toContainEqual({
      role: 'user',
      content: 'visible source',
    })
    expect(result).toBe('translated')
  })

  it('separates send-text-as-is LLM caches by chain-of-thought exclusion mode', async () => {
    testState.db.translatorType = 'llm'
    testState.db.translatorSendTextAsIs = true
    testState.requestChatData
      .mockResolvedValueOnce({ type: 'success', result: 'unfiltered translation' })
      .mockResolvedValueOnce({ type: 'success', result: 'filtered translation' })
    const text = '<Thoughts>private</Thoughts>\nvisible source'

    const unfiltered = await translateHTML(text, false, 'char-a', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translatorExcludeThoughts = true
    const filtered = await translateHTML(text, false, 'char-a', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translatorExcludeThoughts = false
    const unfilteredAgain = await translateHTML(text, false, 'char-a', 0)

    expect(unfiltered).toBe('unfiltered translation')
    expect(filtered).toBe('filtered translation')
    expect(unfilteredAgain).toBe(unfiltered)
    expect(testState.requestChatData).toHaveBeenCalledTimes(2)
  })

  it('runs multi-step LLM translation with one style encoding pass and a per-step profile override', async () => {
    testState.db.translatorType = 'llm'
    testState.db.modelProfiles = [{ id: 'refine-profile', name: 'Refine', modelId: 'echo_model' }]
    testState.db.translatorPresets = [
      createTranslatorPreset('Pipeline', {
        id: 'pipeline',
        steps: [
          {
            id: 'draft',
            name: 'Draft',
            enabled: true,
            prompt: 'Draft {{slot::content}}',
            maxResponse: 100,
            model: { mode: 'inheritTranslate' },
            outputKey: 'draft',
          },
          {
            id: 'refine',
            name: 'Refine',
            enabled: true,
            prompt: 'Refine {{slot::prev}} against {{slot::content}} and {{slot::out::draft}}',
            maxResponse: 200,
            model: { mode: 'modelProfile', profileId: 'refine-profile' },
          },
        ],
      }),
    ]
    testState.db.translatorPresetId = 'pipeline'
    testState.requestChatData
      .mockResolvedValueOnce({ type: 'success', result: 'draft <style-data style-index="0"></style-data>' })
      .mockResolvedValueOnce({ type: 'success', result: '<style-data style-index="0"></style-data> translated' })

    const result = await runTranslator('<risu-style>color:red</risu-style> source', false, 'ko', 'en')

    expect(result).toBe('color:red translated')
    expect(testState.requestChatData).toHaveBeenCalledTimes(2)
    expect(testState.requestChatData.mock.calls[0][0]).toMatchObject({ maxTokens: 100 })
    expect(testState.requestChatData.mock.calls[0][0].formated[0].content).toContain(
      '<style-data style-index="0"></style-data>',
    )
    expect(testState.requestChatData.mock.calls[1][0]).toMatchObject({
      maxTokens: 200,
      profileIdOverride: 'refine-profile',
    })
    expect(testState.requestChatData.mock.calls[1][0].formated[0].content).toContain(
      'draft <style-data style-index="0"></style-data>',
    )
    expect(testState.requestChatData.mock.calls[1][0].formated[0].content).not.toContain('<risu-style>')
  })

  it('keys LLM translation cache entries by the resolved translate profile', async () => {
    testState.db.translatorType = 'llm'
    let callCount = 0
    testState.requestChatData.mockImplementation(async () => {
      callCount += 1
      return {
        type: 'success',
        result: `<p>llm-profile-${callCount}</p>`,
      }
    })

    const first = await translateHTML('<p>same text and language</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.modelRoles = { translate: 'openrouter' }
    const roleOverride = await translateHTML('<p>same text and language</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.modelRoles = {}
    testState.db.seperateModelsForAxModels = true
    testState.db.seperateModels = {
      ...testState.db.seperateModels,
      translate: 'nanogpt',
    }
    const separateOverride = await translateHTML('<p>same text and language</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.seperateModelsForAxModels = false
    testState.db.seperateModels = {
      ...testState.db.seperateModels,
      translate: '',
    }
    const firstAgain = await translateHTML('<p>same text and language</p>', false, '', 0)

    expect(first).toBe('<p>llm-profile-1</p>')
    expect(roleOverride).toBe('<p>llm-profile-2</p>')
    expect(separateOverride).toBe('<p>llm-profile-3</p>')
    expect(firstAgain).toBe(first)
    expect(testState.requestChatData).toHaveBeenCalledTimes(3)
  })

  it('ignores a stale flat main model when the resolved LLM translate profile is unchanged', async () => {
    testState.db.translatorType = 'llm'
    testState.db.modelProfiles = [
      { id: 'chat-main-profile', name: 'Chat Main', modelId: 'openai' },
      { id: 'translate-profile', name: 'Translate', modelId: 'echo_model' },
    ]
    testState.db.modelRoleProfiles = {
      chatMain: { mode: 'profile', profileId: 'chat-main-profile' },
      translate: { mode: 'profile', profileId: 'translate-profile' },
    }
    testState.db.aiModel = 'novellist'
    testState.requestChatData.mockResolvedValue({ type: 'success', result: '<p>translated</p>' })

    const initialSignature = getTranslatorSettingsSignatureKey(testState.db)
    const first = await translateHTML('<p>stable translate profile</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.aiModel = 'openai'
    const staleFlatSignature = getTranslatorSettingsSignatureKey(testState.db)
    const cached = await translateHTML('<p>stable translate profile</p>', false, '', 0)

    expect(staleFlatSignature).toBe(initialSignature)
    expect(cached).toBe(first)
    expect(testState.requestChatData).toHaveBeenCalledTimes(1)

    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.modelProfiles[1].modelId = 'novellist_damsel'
    expect(getTranslatorSettingsSignatureKey(testState.db)).not.toBe(initialSignature)
    await translateHTML('<p>stable translate profile</p>', false, '', 0)
    expect(testState.requestChatData).toHaveBeenCalledTimes(2)
  })

  it('uses the effective translate role for NovelList locale identity and legacy fallback', async () => {
    stubGoogleFetch()
    testState.db.modelProfiles = [
      { id: 'main-novellist', name: 'Main NovelList', modelId: 'novellist' },
      { id: 'main-openai', name: 'Main OpenAI', modelId: 'openai' },
      { id: 'translate-openai', name: 'Translate OpenAI', modelId: 'openai' },
      { id: 'translate-novellist', name: 'Translate NovelList', modelId: 'novellist_damsel' },
    ]
    testState.db.modelRoleProfiles = {
      chatMain: { mode: 'profile', profileId: 'main-novellist' },
      translate: { mode: 'profile', profileId: 'translate-openai' },
    }
    testState.db.aiModel = 'novellist'

    await expect(translate('durable locale', true)).resolves.toBe('translated:en:durable locale:1')

    testState.db.modelRoleProfiles = {
      chatMain: { mode: 'profile', profileId: 'main-openai' },
      translate: { mode: 'profile', profileId: 'translate-novellist' },
    }
    testState.db.aiModel = 'openai'
    await expect(translate('durable locale', true)).resolves.toBe('translated:ja:durable locale:1')

    testState.db.modelRoleProfiles = {}
    testState.db.aiModel = 'openai'
    testState.db.subModel = 'novellist_damsel'
    await expect(translate('legacy translate locale', true)).resolves.toBe('translated:ja:legacy translate locale:1')

    testState.db.aiModel = 'novellist'
    testState.db.subModel = 'openai'
    await expect(translate('legacy stale main', true)).resolves.toBe('translated:en:legacy stale main:1')
  })

  it('invalidates LLM translation cache identity when profile runtime options change', () => {
    testState.db.translatorType = 'llm'
    testState.db.modelProfiles = [
      {
        id: 'translate-profile',
        name: 'Translate Profile',
        modelId: 'echo_model',
        runtimeOptions: { temperature: 20, topP: 0.8 },
      },
    ]
    testState.db.modelRoleProfiles = {
      translate: { mode: 'profile', profileId: 'translate-profile' },
    }
    const first = __translatorTestHooks.getCurrentLLMTranslationCacheKey('<p>same text</p>')

    testState.db.modelProfiles[0].runtimeOptions = { temperature: 70, topP: 0.4 }
    const changed = __translatorTestHooks.getCurrentLLMTranslationCacheKey('<p>same text</p>')

    expect(changed).not.toBe(first)
  })

  it('omits obvious provider secrets from the translate profile cache signature', () => {
    Object.assign(testState.db, {
      translatorType: 'llm',
      subModel: 'reverse_proxy',
      customProxyRequestModel: 'safe-visible-request-model',
      forceReplaceUrl: 'https://secret-host.example/v1/chat/completions',
      proxyKey: 'sk-secret-profile-key',
      additionalParams: [['api_key', 'secret-param-value']],
    })

    const signature = __translatorTestHooks.getTranslateProfileCacheSignature()
    const currentKey = __translatorTestHooks.getCurrentLLMTranslationCacheKey('<p>secret-safe body</p>')
    const serializedSignature = JSON.stringify(signature)

    expect(serializedSignature).toContain('reverse_proxy')
    expect(serializedSignature).toContain('safe-visible-request-model')
    expect(serializedSignature).not.toContain('sk-secret-profile-key')
    expect(serializedSignature).not.toContain('secret-host.example')
    expect(serializedSignature).not.toContain('secret-param-value')
    expect(currentKey).toContain('reverse_proxy')
    expect(currentKey).not.toContain('sk-secret-profile-key')
    expect(currentKey).not.toContain('secret-host.example')
    expect(currentKey).not.toContain('secret-param-value')
  })

  it('manual LLM cache edits update the active signature entry', async () => {
    testState.db.translatorType = 'llm'
    testState.requestChatData.mockResolvedValue({
      type: 'success',
      result: '<p>generated translation</p>',
    })

    const generated = await translateHTML('<p>manual edit body</p>', false, '', 0)
    await setLLMCache('<p>manual edit body</p>', '<p>manual edited translation</p>')
    __translatorTestHooks.clearTranslateHTMLMemo()
    const edited = await translateHTML('<p>manual edit body</p>', false, '', 0)

    expect(generated).toBe('<p>generated translation</p>')
    expect(edited).toBe('<p>manual edited translation</p>')
    expect(testState.requestChatData).toHaveBeenCalledTimes(1)
    await expect(getLLMCache('<p>manual edit body</p>')).resolves.toBe('<p>manual edited translation</p>')
  })

  it('manual LLM cache edits do not shadow another translator signature', async () => {
    testState.db.translatorType = 'llm'
    testState.requestChatData.mockImplementation(async () => ({
      type: 'success',
      result: `<p>generated:${testState.db.translator}</p>`,
    }))

    await setLLMCache('<p>manual scoped body</p>', '<p>manual:ko</p>')
    await expect(getLLMCache('<p>manual scoped body</p>')).resolves.toBe('<p>manual:ko</p>')
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translator = 'fr'
    await expect(getLLMCache('<p>manual scoped body</p>')).resolves.toBeNull()
    const translated = await translateHTML('<p>manual scoped body</p>', false, '', 0)

    expect(translated).toBe('<p>generated:fr</p>')
    expect(testState.requestChatData).toHaveBeenCalledTimes(1)
    __translatorTestHooks.clearTranslateHTMLMemo()
    testState.db.translator = 'ko'
    await expect(translateHTML('<p>manual scoped body</p>', false, '', 0)).resolves.toBe('<p>manual:ko</p>')
    expect(testState.requestChatData).toHaveBeenCalledTimes(1)
  })

  it('enforces deterministic LLM cache pruning', async () => {
    testState.db.translatorType = 'llm'
    testState.requestChatData.mockImplementation(async ({ formated }: { formated: { content: string }[] }) => ({
      type: 'success',
      result: `llm:${formated.at(-1)?.content ?? ''}`,
    }))

    for (let i = 0; i <= LLM_TRANSLATE_CACHE_MAX_ENTRIES; i++) {
      await translateHTML(`<p>llm-${i}</p>`, false, '', 0)
    }

    const cacheKeys = Array.from(testState.llmCache.keys()).filter(
      (key) => key !== '__risu_llm_translate_cache_index_v1__',
    )
    expect(cacheKeys).toHaveLength(LLM_TRANSLATE_CACHE_MAX_ENTRIES)
    expect(cacheKeys.some((key) => key.includes('<p>llm-0</p>'))).toBe(false)
    expect(cacheKeys.some((key) => key.includes(`<p>llm-${LLM_TRANSLATE_CACHE_MAX_ENTRIES}</p>`))).toBe(true)
    await expect(getLLMCache('<p>llm-0</p>')).resolves.toBeNull()
  })

  it('quota write failures keep translated output in a bounded volatile cache without alerting', async () => {
    testState.db.translatorType = 'llm'
    testState.requestChatData.mockResolvedValue({ type: 'success', result: '<p>paid result</p>' })
    testState.storage.setItem.mockRejectedValue(new DOMException('full', 'QuotaExceededError'))

    const first = await translateHTML('<p>quota body</p>', false, '', 0)
    __translatorTestHooks.clearTranslateHTMLMemo()
    const second = await translateHTML('<p>quota body</p>', false, '', 0)

    expect(first).toBe('<p>paid result</p>')
    expect(second).toBe(first)
    expect(testState.requestChatData).toHaveBeenCalledTimes(1)
    expect(testState.alertError).not.toHaveBeenCalled()
    expect(__translatorTestHooks.getLLMVolatileCacheEntries()).toHaveLength(1)
    expect(__translatorTestHooks.getLLMCacheWriteFailureKeys()).toHaveLength(1)

    testState.storage.setItem.mockReset()
    testState.storage.setItem.mockImplementation(async (key: string, value: unknown) => {
      testState.llmCache.set(key, value)
      return value
    })
    await setLLMCache('manual-key', 'manual-value')
    await expect(getLLMCache('manual-key')).resolves.toBe('manual-value')
  })

  it('current translator preset sync reads from a snapshot without mutating live legacy fields', () => {
    const presets = [
      createTranslatorPreset('Default', { id: 'default', prompt: 'default prompt', maxResponse: 128 }),
      createTranslatorPreset('Detailed', { id: 'detailed', prompt: 'detailed prompt', maxResponse: 256 }),
    ]
    Object.assign(testState.db, {
      translatorPrompt: 'legacy prompt',
      translatorMaxResponse: 1000,
      translatorPresets: presets,
      translatorPresetId: 'detailed',
    })

    const preset = getCurrentTranslatorPreset()

    expect(preset).toMatchObject({ name: 'Detailed', prompt: 'detailed prompt', maxResponse: 256 })
    expect(testState.db.translatorPrompt).toBe('legacy prompt')
    expect(testState.db.translatorMaxResponse).toBe(1000)
    expect(testState.db.translatorPresets).toBe(presets)
  })

  it('current translator preset reads canonical defaults from a snapshot without consulting live scalars', () => {
    Object.assign(testState.db, {
      translatorPrompt: 'legacy only prompt',
      translatorMaxResponse: 333,
      translatorPresets: undefined,
      translatorPresetId: 99,
    })

    const preset = getCurrentTranslatorPreset()

    expect(preset).toBeNull()
    expect(testState.db.translatorPresets).toBeUndefined()
    expect(testState.db.translatorPresetId).toBe(99)
    expect(testState.db.translatorPrompt).toBe('legacy only prompt')
    expect(testState.db.translatorMaxResponse).toBe(333)
  })
})

beforeEach(() => resetClientSessionForTests())

describe('translator managed-session admission', () => {
  it('returns readable source without provider work for a reader', async () => {
    resetDatabase()
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(translate('source', false)).resolves.toBe('source')
    await expect(runTranslator('source', false, 'en', 'ja')).resolves.toBe('source')
    await expect(translateHTML('<p>source</p>', false, '', 0)).resolves.toBe('<p>source</p>')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not cache delayed Google output after demotion and repromotion', async () => {
    resetDatabase()
    __translatorTestHooks.clearTranslateCache()
    setManagedWriterForTest()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = translate('old source', false)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(Response.json([[['old translation', 'old source']]]))
    await expect(pending).rejects.toThrow('client_write_operation_stale')
    expect(__translatorTestHooks.getTranslateCacheEntries()).toEqual([])
  })
})
