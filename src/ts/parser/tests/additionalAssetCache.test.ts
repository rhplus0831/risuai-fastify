import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMModel } from '../../model/modellist'
import {
  clearAdditionalAssetCachesForTests,
  getAdditionalAssetCacheStatsForTests,
  ParseMarkdown,
  type simpleCharacterArgument,
} from '../parser.svelte'
import {
  charactersResourceState,
  collectionsResourceState,
  settingsResourceState,
} from '../../server/resourceState.svelte'
import { invalidateModuleRenderRevision } from '../../moduleRenderRevision'
import { pickHashRand } from '../../util'
import type { character } from '../../storage/database.svelte'

const mocks = vi.hoisted(() => ({
  db: {
    assetMaxDifference: 4,
    characters: [] as Array<{ chaId?: string }>,
    customQuotes: false,
    enabledModules: ['module-owner'],
    hideAllImages: false,
    modules: [] as Array<{
      id: string
      name: string
      description: string
      assets: [string, string, string][]
    }>,
    promptPresets: [],
    personas: [],
    agentPresets: [],
  },
  getFileSrc: vi.fn<(path: string) => Promise<string>>(),
  moduleAssets: [] as [string, string, string][],
  processScriptFull: vi.fn(async (_char: unknown, data: string) => ({ data, emoChanged: false })),
  requestServerDisplaySource: vi.fn(async (_input: unknown) => ({ status: 'fallback' as const, reason: 'test' })),
  modelInfo: {
    id: 'test-model',
    name: 'Test Model',
    provider: 14,
    flags: [],
    format: 19,
    parameters: [],
    tokenizer: 0,
  } satisfies LLMModel,
}))

vi.mock(
  import('../../storage/database.svelte'),
  () =>
    ({
      appVer: '1234.5.67',
      getCurrentCharacter: () => undefined,
      getCurrentChat: () => undefined,
      getDatabase: () => mocks.db,
      reapplyPendingPresetProjections: () => {},
    }) as unknown as typeof import('../../storage/database.svelte'),
)

vi.mock(import('../../globalApi.svelte'), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: mocks.getFileSrc,
}))

vi.mock(import('../../stores.svelte'), () => ({
  CurrentTriggerIdStore: writable(null),
  selectedCharID: writable(0),
}))

vi.mock(import('../../process/files/inlays'), () => ({
  getInlayAssetBlob: vi.fn(),
}))

vi.mock(import('../../process/modules'), () => ({
  getModuleAssets: () => mocks.moduleAssets,
  getModuleLorebooks: () => [],
  getModules: () => [],
}))

vi.mock(import('../../process/scripts'), () => ({
  processScriptFull: mocks.processScriptFull,
}))

vi.mock(import('../../server/displaySources'), () => ({
  requestServerDisplaySource: mocks.requestServerDisplaySource,
  markReaderDisplayLimited: vi.fn(),
}))

vi.mock(import('../../model/modellist'), () => ({
  getModelInfo: () => mocks.modelInfo,
}))

function simpleCharacter(
  chaId: string,
  additionalAssets: [string, string, string][] = [],
  emotionImages: [string, string][] = [],
): simpleCharacterArgument {
  return {
    type: 'simple',
    chaId,
    additionalAssets,
    emotionImages,
    customscript: [],
    triggerscript: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  clearAdditionalAssetCachesForTests()
  mocks.db.assetMaxDifference = 4
  delete (mocks.db as Record<string, unknown>).legacyMediaFindings
  mocks.db.characters = []
  mocks.db.enabledModules = ['module-owner']
  mocks.db.modules = []
  mocks.moduleAssets = []
  mocks.getFileSrc.mockReset().mockImplementation(async (path) => `/resolved/${path}`)
  mocks.processScriptFull.mockReset().mockImplementation(async (_char, data) => ({ data, emoChanged: false }))
  mocks.requestServerDisplaySource.mockClear()
  charactersResourceState.characters = []
  charactersResourceState.currentChar = -1
  charactersResourceState.status = 'idle'
  settingsResourceState.value = mocks.db
  settingsResourceState.status = 'ready'
  settingsResourceState.groupStatuses = { advanced: 'ready', display: 'ready', modules: 'ready', media: 'ready' }
  settingsResourceState.standaloneStatuses = {}
  collectionsResourceState.values = {
    modules: mocks.db.modules,
    promptPresets: [],
    personas: [],
  }
  collectionsResourceState.statuses = { modules: 'ready', promptPresets: 'ready', personas: 'ready' }
  collectionsResourceState.status = 'ready'
})

describe('additional asset resolution cache', () => {
  it('isolates local chat modules and source portraits from the canonical selected chat', async () => {
    mocks.db.enabledModules = []
    mocks.db.modules = [
      { id: 'writer-module', name: 'Writer', description: '', assets: [['shared', 'writer-asset', 'png']] },
      { id: 'reader-module', name: 'Reader', description: '', assets: [['shared', 'reader-asset', 'png']] },
    ]
    collectionsResourceState.values.modules = mocks.db.modules
    const writer = {
      chaId: 'writer',
      chatPage: 0,
      image: 'writer-portrait',
      chats: [
        { id: 'writer-chat', modules: ['writer-module'], message: [{ chatId: 'same-message-id', data: 'writer' }] },
      ],
    } as character
    const reader = {
      chaId: 'reader',
      chatPage: 0,
      image: 'reader-portrait',
      chats: [
        { id: 'reader-first', modules: ['writer-module'], message: [{ chatId: 'same-message-id', data: 'first' }] },
        { id: 'reader-second', modules: ['reader-module'], message: [{ chatId: 'same-message-id', data: 'second' }] },
      ],
    } as character
    charactersResourceState.characters = [writer, reader]
    charactersResourceState.currentChar = 0
    charactersResourceState.status = 'ready'
    const charArg = simpleCharacter('reader')
    const data = '{{raw::shared}} {{source::char}} {{source::user}}'
    const first = await ParseMarkdown(
      data,
      charArg,
      'back',
      0,
      {},
      {
        readOnly: true,
        chatId: 'reader-first',
        messageId: 'same-message-id',
        readContext: { character: reader, chat: reader.chats[0], userIcon: 'first-persona' },
      },
    )
    const second = await ParseMarkdown(
      data,
      charArg,
      'back',
      0,
      {},
      {
        readOnly: true,
        chatId: 'reader-second',
        messageId: 'same-message-id',
        readContext: { character: reader, chat: reader.chats[1], userIcon: 'second-persona' },
      },
    )
    expect(first).toContain('/resolved/writer-asset')
    expect(first).toContain('/resolved/first-persona')
    expect(second).toContain('/resolved/reader-asset')
    expect(second).toContain('/resolved/second-persona')
    expect(second).not.toContain('/resolved/writer-asset')
    expect(first).toContain('/resolved/reader-portrait')
    expect(second).toContain('/resolved/reader-portrait')
    expect(second).not.toContain('/resolved/writer-portrait')
    expect(mocks.requestServerDisplaySource.mock.calls.map(([input]) => (input as { chatId: string }).chatId)).toEqual([
      'reader-first',
      'reader-second',
    ])
    expect(mocks.processScriptFull).not.toHaveBeenCalled()
    expect(charactersResourceState.currentChar).toBe(0)
    expect(reader.chatPage).toBe(0)
    expect(getAdditionalAssetCacheStatsForTests().entries).toBe(2)
  })

  it('resolves colliding names from the character passed to ParseMarkdown', async () => {
    const lucy = simpleCharacter('lucy', [['bg', 'lucy-background', 'png']])
    const haniel = simpleCharacter('haniel', [['bg.png', 'haniel-background', 'png']])

    const lucyOutput = await ParseMarkdown('{{raw::bg}}', lucy, 'back')
    const hanielOutput = await ParseMarkdown('{{raw::bg}}', haniel, 'back')

    expect(lucyOutput).toContain('/resolved/lucy-background')
    expect(hanielOutput).toContain('/resolved/haniel-background')
    expect(hanielOutput).not.toContain('/resolved/lucy-background')
  })

  it('invalidates character tuples structurally and module tuples through the render revision', async () => {
    const character = simpleCharacter('mutable-character', [['portrait', 'character-old', 'png']])
    mocks.moduleAssets = [['frame', 'module-old', 'png']]
    mocks.db.modules = [
      {
        id: 'module-owner',
        name: 'Module owner',
        description: '',
        assets: mocks.moduleAssets,
      },
    ]
    collectionsResourceState.values.modules = mocks.db.modules as never

    await expect(ParseMarkdown('{{raw::portrait}} {{raw::frame}}', character, 'back')).resolves.toContain(
      '/resolved/character-old',
    )

    character.additionalAssets![0][1] = 'character-new'
    const characterUpdated = await ParseMarkdown('{{raw::portrait}}', character, 'back')
    expect(characterUpdated).toContain('/resolved/character-new')
    expect(characterUpdated).not.toContain('/resolved/character-old')

    collectionsResourceState.values.modules![0].assets![0][1] = 'module-new'
    invalidateModuleRenderRevision()
    const moduleUpdated = await ParseMarkdown('{{raw::frame}}', character, 'back')

    expect(moduleUpdated).toContain('/resolved/module-new')
    expect(moduleUpdated).not.toContain('/resolved/module-old')
  })

  // Cooperative indexing yields to real timers. Allow aggregate-run contention;
  // the visit counts below enforce bounded work independently of elapsed time.
  it('does not index 130,000 active module assets until an exact marker needs one', async () => {
    const moduleAssets = Array.from({ length: 130_000 }, (_, index) => [
      `asset-${index}`,
      `module-path-${index}`,
      'png',
    ]) as [string, string, string][]
    mocks.db.modules = [
      {
        id: 'module-owner',
        name: 'Asset-heavy module',
        description: '',
        assets: moduleAssets,
      },
    ]
    collectionsResourceState.values.modules = mocks.db.modules as never
    const character = simpleCharacter('asset-heavy-character')

    await expect(ParseMarkdown('No asset marker in this message.', character, 'back')).resolves.toContain(
      'No asset marker in this message.',
    )
    expect(getAdditionalAssetCacheStatsForTests()).toMatchObject({
      contextsBuilt: 0,
      moduleAssetTuplesVisited: 0,
      resolvedAssetNames: 0,
    })
    expect(mocks.getFileSrc).not.toHaveBeenCalled()

    await expect(ParseMarkdown('{{raw::asset-129999}}', character, 'back')).resolves.toContain(
      '/resolved/module-path-129999',
    )
    expect(getAdditionalAssetCacheStatsForTests()).toMatchObject({
      contextsBuilt: 1,
      moduleAssetTuplesVisited: 130_000,
      resolvedAssetNames: 1,
    })
    expect(mocks.getFileSrc).toHaveBeenCalledTimes(1)

    await expect(ParseMarkdown('{{raw::asset-129999}}', character, 'back')).resolves.toContain(
      '/resolved/module-path-129999',
    )
    expect(getAdditionalAssetCacheStatsForTests()).toMatchObject({
      contextsBuilt: 1,
      moduleAssetTuplesVisited: 130_000,
      resolvedAssetNames: 1,
    })
    expect(mocks.getFileSrc).toHaveBeenCalledTimes(2)

    const distinctNames = Array.from({ length: 100 }, (_, i) => `{{raw::asset-${i}}}`).join(' ')
    const output = await ParseMarkdown(distinctNames, character, 'back')
    expect(output).toContain('/resolved/module-path-99')
    expect(getAdditionalAssetCacheStatsForTests()).toMatchObject({
      contextsBuilt: 1,
      assetIndexesBuilt: 1,
      moduleAssetTuplesVisited: 130_000,
      resolvedAssetNames: 101,
    })
    // A different chat/character sharing the module must not walk its assets again.
    await expect(
      ParseMarkdown('{{raw::asset-129999}}', simpleCharacter('second-character'), 'back'),
    ).resolves.toContain('/resolved/module-path-129999')
    await expect(ParseMarkdown('{{raw::asset-0}}', character, 'back')).resolves.toContain('/resolved/module-path-0')
    expect(getAdditionalAssetCacheStatsForTests().moduleAssetTuplesVisited).toBe(130_000)
  }, 15_000)

  it('preserves locale casing, the first extension and ordered deterministic variants', async () => {
    const character = simpleCharacter('variants', [
      ['PoRtRaIt', 'character-first', 'png'],
      ['portrait', 'character-other-extension', 'jpg'],
      ['PORTRAIT', 'character-second', 'png'],
    ])
    collectionsResourceState.values.modules = [
      {
        id: 'module-owner',
        name: '',
        description: '',
        assets: [
          ['portrait', 'module-first', 'png'],
          ['portrait', 'module-other-extension', 'webp'],
        ],
      },
      { id: 'module-second', name: '', description: '', assets: [['portrait', 'module-second', 'png']] },
    ] as never
    settingsResourceState.value.enabledModules = ['module-owner', 'module-second']
    const variants = ['character-first', 'character-second', 'module-first', 'module-second']
    for (let index = 0; index < 12; index++) {
      const expected = variants[Math.floor(pickHashRand(index, character.chaId + index) * variants.length)]
      await expect(ParseMarkdown('{{raw::PORTRAIT}}', character, 'back', index)).resolves.toBe(`/resolved/${expected}`)
    }
    expect(getAdditionalAssetCacheStatsForTests()).toMatchObject({
      contextsBuilt: 1,
      assetIndexesBuilt: 1,
      characterAssetTuplesVisited: 3,
      moduleAssetTuplesVisited: 3,
    })
  })

  it('rebuilds for module order and activation, including a previously missing name', async () => {
    const character = simpleCharacter('activation')
    collectionsResourceState.values.modules = [
      { id: 'module-owner', name: '', description: '', assets: [['frame', 'first-png', 'png']] },
      { id: 'module-second', name: '', description: '', assets: [['frame', 'second-jpg', 'jpg']] },
    ] as never
    settingsResourceState.value.enabledModules = []
    settingsResourceState.value.legacyMediaFindings = true
    await expect(ParseMarkdown('{{raw::frame}}', character, 'back')).resolves.toBe('')
    settingsResourceState.value.enabledModules = ['module-owner', 'module-second']
    await expect(ParseMarkdown('{{raw::frame}}', character, 'back')).resolves.toBe('/resolved/first-png')
    settingsResourceState.value.enabledModules = ['module-second', 'module-owner']
    // Activation membership does not reorder the collection's traversal.
    await expect(ParseMarkdown('{{raw::frame}}', character, 'back')).resolves.toBe('/resolved/first-png')
    collectionsResourceState.values.modules!.reverse()
    invalidateModuleRenderRevision()
    await expect(ParseMarkdown('{{raw::frame}}', character, 'back')).resolves.toBe('/resolved/second-jpg')
    settingsResourceState.value.enabledModules = ['module-owner']
    await expect(ParseMarkdown('{{raw::frame}}', character, 'back')).resolves.toBe('/resolved/first-png')
    expect(getAdditionalAssetCacheStatsForTests().contextsBuilt).toBe(4)
  })

  it('retains fuzzy misses and the last matching emotion without building an asset index for emotions', async () => {
    const character = simpleCharacter(
      'fallback',
      [['portrait', 'fuzzy-path', 'png']],
      [
        ['Happy', 'first-emotion'],
        ['HAPPY', 'last-emotion'],
      ],
    )
    await expect(ParseMarkdown('{{emotion::happy}}', character, 'back')).resolves.toContain('/resolved/last-emotion')
    expect(getAdditionalAssetCacheStatsForTests().assetIndexesBuilt).toBe(0)
    await expect(ParseMarkdown('{{raw::portrai}}', character, 'back')).resolves.toBe('/resolved/fuzzy-path')
    settingsResourceState.value.legacyMediaFindings = true
    await expect(ParseMarkdown('{{raw::portrai}}', character, 'back')).resolves.toBe('')
  })

  it('evicts the least recently used context and reindexes replacement assets', async () => {
    const first = simpleCharacter('eviction-0', [['frame', 'first', 'png']])
    await ParseMarkdown('{{raw::frame}}', first, 'back')
    for (let i = 1; i <= 32; i++) {
      await ParseMarkdown('{{raw::frame}}', simpleCharacter(`eviction-${i}`, [['frame', `${i}`, 'png']]), 'back')
    }
    expect(getAdditionalAssetCacheStatsForTests().entries).toBe(32)
    await expect(ParseMarkdown('{{raw::frame}}', first, 'back')).resolves.toBe('/resolved/first')
    expect(getAdditionalAssetCacheStatsForTests().contextsBuilt).toBe(34)
    const replacement = simpleCharacter('eviction-0', [['frame', 'replacement', 'png']])
    await expect(ParseMarkdown('{{raw::frame}}', replacement, 'back')).resolves.toBe('/resolved/replacement')
    expect(getAdditionalAssetCacheStatsForTests().contextsBuilt).toBe(35)
    expect(getAdditionalAssetCacheStatsForTests().entries).toBe(32)
  })

  it('keeps concurrent character parses isolated when asset reads finish out of order', async () => {
    const lucyRead = deferred<string>()
    const hanielRead = deferred<string>()
    mocks.getFileSrc.mockImplementation((path) => {
      if (path === 'lucy-concurrent') return lucyRead.promise
      if (path === 'haniel-concurrent') return hanielRead.promise
      return Promise.resolve('')
    })
    const lucy = simpleCharacter('lucy-concurrent', [['bg', 'lucy-concurrent', 'png']])
    const haniel = simpleCharacter('haniel-concurrent', [['bg.png', 'haniel-concurrent', 'png']])

    const lucyParse = ParseMarkdown('{{raw::bg}}', lucy, 'back')
    await vi.waitFor(() => expect(mocks.getFileSrc).toHaveBeenCalledWith('lucy-concurrent'))
    const hanielParse = ParseMarkdown('{{raw::bg}}', haniel, 'back')
    await vi.waitFor(() => expect(mocks.getFileSrc).toHaveBeenCalledWith('haniel-concurrent'))

    hanielRead.resolve('/resolved/haniel-concurrent')
    await expect(hanielParse).resolves.toContain('/resolved/haniel-concurrent')
    lucyRead.resolve('/resolved/lucy-concurrent')
    await expect(lucyParse).resolves.toContain('/resolved/lucy-concurrent')
  })

  it('uses ready module and generation-context owners instead of compatibility rows', async () => {
    mocks.db.modules = [
      {
        id: 'module-owner',
        name: 'Compatibility module',
        description: '',
        assets: [['frame', 'compatibility-frame', 'png']],
      },
    ]
    charactersResourceState.characters = [
      {
        chaId: 'owner-character',
        type: 'character',
        chatPage: 0,
        chats: [
          {
            id: 'owner-chat',
            message: [{ role: 'char', data: 'owner row', chatId: 'owner-message' }],
            scriptstate: {},
          },
        ],
      },
    ] as never
    charactersResourceState.currentChar = 0
    charactersResourceState.status = 'ready'
    settingsResourceState.value = { enabledModules: ['module-owner'], agentPresets: [] }
    settingsResourceState.status = 'ready'
    settingsResourceState.groupStatuses.modules = 'ready'
    collectionsResourceState.values = {
      modules: [
        {
          id: 'module-owner',
          name: 'Owner module',
          description: '',
          assets: [['frame', 'owner-frame', 'png']],
        },
        {
          id: 'module-generation',
          name: 'Generation module',
          description: '',
          assets: [['generation', 'generation-frame', 'png']],
        },
      ],
      promptPresets: [],
      personas: [],
    } as never
    collectionsResourceState.statuses = {
      modules: 'ready',
      promptPresets: 'ready',
      personas: 'ready',
    }
    collectionsResourceState.status = 'ready'

    const output = await ParseMarkdown('{{raw::frame}}', simpleCharacter('owner-character'), 'back', 0)

    expect(output).toContain('/resolved/owner-frame')
    expect(output).not.toContain('compatibility-frame')
    expect(mocks.requestServerDisplaySource).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'owner-chat',
        messageId: 'owner-message',
        index: 0,
      }),
    )

    const generationOutput = await ParseMarkdown(
      '{{raw::generation}}',
      {
        type: 'character',
        chaId: 'owner-character',
        chatPage: 0,
        chats: [{ id: 'generation-chat', message: [], scriptstate: {} }],
        modules: ['module-generation'],
        additionalAssets: [],
        emotionImages: [],
        customscript: [],
        triggerscript: [],
      } as never,
      'back',
      0,
    )
    expect(generationOutput).toContain('/resolved/generation-frame')
  })

  it('keeps pinned-navigation display requests bound to the rendered chat target', async () => {
    charactersResourceState.characters = [
      {
        chaId: 'character-a',
        type: 'character',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a1',
            message: [{ role: 'char', data: 'first chat row', chatId: 'message-a1' }],
            scriptstate: {},
          },
          {
            id: 'chat-a2',
            message: [{ role: 'char', data: 'second chat row', chatId: 'message-a2' }],
            scriptstate: {},
          },
        ],
      },
      {
        chaId: 'character-b',
        type: 'character',
        chatPage: 0,
        chats: [
          {
            id: 'chat-b2',
            message: [{ role: 'char', data: 'second character row', chatId: 'message-b2' }],
            scriptstate: {},
          },
        ],
      },
    ] as never
    charactersResourceState.currentChar = 0
    charactersResourceState.status = 'ready'

    await ParseMarkdown(
      'first chat row',
      simpleCharacter('character-a'),
      'notrim',
      0,
      { chatRole: 'char' },
      {
        chatId: 'chat-a1',
        messageId: 'message-a1',
      },
    )
    charactersResourceState.currentChar = 1
    await ParseMarkdown(
      'second character row',
      simpleCharacter('character-b'),
      'notrim',
      0,
      { chatRole: 'char' },
      {
        chatId: 'chat-b2',
        messageId: 'message-b2',
      },
    )
    charactersResourceState.currentChar = 0
    await ParseMarkdown(
      'first chat row',
      simpleCharacter('character-a'),
      'notrim',
      0,
      { chatRole: 'char' },
      {
        chatId: 'chat-a1',
        messageId: 'message-a1',
      },
    )
    await ParseMarkdown(
      'second chat row',
      simpleCharacter('character-a'),
      'notrim',
      0,
      { chatRole: 'char' },
      {
        chatId: 'chat-a2',
        messageId: 'message-a2',
      },
    )

    expect(
      mocks.requestServerDisplaySource.mock.calls.map(([request]) => (request as { chatId: string }).chatId),
    ).toEqual(['chat-a1', 'chat-b2', 'chat-a1', 'chat-a2'])
    expect(mocks.requestServerDisplaySource).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: 'chat-a2', messageId: 'message-a2', source: 'second chat row' }),
    )
  })
})
