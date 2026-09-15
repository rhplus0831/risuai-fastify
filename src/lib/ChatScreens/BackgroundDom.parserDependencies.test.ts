import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../../ts/storage/database.svelte'

const backgroundParserMocks = vi.hoisted(() => ({
  ParseMarkdown: vi.fn(async (html: string) => html),
  risuChatParser: vi.fn(
    (
      html: string,
      arg?: {
        chara?: {
          name?: string
          nickname?: string
          personality?: string
        }
      },
    ) => {
      const chara = arg?.chara
      const charName = chara?.nickname || chara?.name || ''
      return html.replaceAll('{{char}}', charName).replaceAll('{{personality}}', chara?.personality ?? '')
    },
  ),
}))

vi.mock('src/ts/parser/parser.svelte', () => ({
  ParseMarkdown: backgroundParserMocks.ParseMarkdown,
  risuChatParser: backgroundParserMocks.risuChatParser,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
  reapplyPendingPresetProjections: () => {},
}))

vi.mock('src/ts/process/modules', () => ({
  applyModule: vi.fn(),
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  readModule: vi.fn(),
  refreshModules: vi.fn(),
}))

import BackgroundDom from './BackgroundDom.svelte'
import { charactersResourceState, replaceResourceDatabase } from '../../ts/server/resourceState.svelte'
import {
  ReloadGUIPointer,
  VariableReloadGUIPointer,
  moduleBackgroundEmbedding,
  selIdState,
  selectedCharID,
} from '../../ts/stores.svelte'
import {
  RegexDisplayReloadPointer,
  RegexDisplayReloadScope,
  reloadRegexDisplay,
  resetRegexDisplayReloadForTests,
} from '../../ts/process/regexDisplayReload'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

import { invalidateModuleRenderRevision, resetModuleRenderRevisionForTests } from '../../ts/moduleRenderRevision'

type MountedComponent = Parameters<typeof unmount>[0]

const previousDb = getResourceDatabase({ snapshot: true })
const previousSelectedChar = get(selectedCharID)
const previousReloadGui = get(ReloadGUIPointer)
const previousVariableReloadGui = get(VariableReloadGUIPointer)
const previousRegexDisplayScope = get(RegexDisplayReloadScope)
const previousRegexDisplayReload = get(RegexDisplayReloadPointer)
const previousModuleBackgroundEmbedding = get(moduleBackgroundEmbedding)

let target: HTMLElement
let component: MountedComponent | undefined

function seedDatabase(backgroundHTML = '<section>background one</section>') {
  selectedCharID.set(0)
  selIdState.selId = 0
  ReloadGUIPointer.set(0)
  VariableReloadGUIPointer.set(0)
  resetRegexDisplayReloadForTests()
  moduleBackgroundEmbedding.set('')
  replaceResourceDatabase({
    characters: [
      {
        backgroundHTML,
        chaId: 'background-dom-character',
        chatPage: 0,
        chats: [
          {
            id: 'background-dom-chat',
            name: 'Background Dom Chat',
            message: [
              {
                chatId: 'background-dom-message',
                data: 'visible chat text',
                role: 'char',
              },
            ],
            localLore: [],
          },
        ],
        customscript: [],
        desc: 'background description',
        emotionImages: [],
        exampleMessage: 'background example',
        hideChatIcon: false,
        image: '',
        name: 'Background Character',
        personality: 'background personality',
        scenario: 'background scenario',
        triggerscript: [],
        type: 'character',
      },
    ],
    currentChar: 0,
    enabledModules: [],
    moduleIntergration: '',
    modules: [],
  } as unknown as Database)
}

// Drain Svelte updates before negative assertions; positive assertions wait for their outcome.
async function settle() {
  flushSync()
  await tick()
  await Promise.resolve()
  flushSync()
  await tick()
}

async function waitUntil(assertion: () => void) {
  await vi.waitFor(async () => {
    await settle()
    assertion()
  })
}

async function expectBackground(text: string) {
  await waitUntil(() => expect(target.textContent?.trim()).toBe(text))
}

const pendingParses = new Set<(html: string) => void>()

function deferParse({ subsequentCalls = false } = {}) {
  let started = false
  let resolve!: (html: string) => void
  const promise = new Promise<string>((done) => {
    resolve = (html) => {
      pendingParses.delete(resolve)
      done(html)
    }
  })
  pendingParses.add(resolve)
  const parse = () => {
    started = true
    return promise
  }
  if (subsequentCalls) backgroundParserMocks.ParseMarkdown.mockImplementation(parse)
  else backgroundParserMocks.ParseMarkdown.mockImplementationOnce(parse)
  return {
    resolve,
    waitUntilStarted: () => waitUntil(() => expect(started).toBe(true)),
  }
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  backgroundParserMocks.ParseMarkdown.mockReset()
  backgroundParserMocks.risuChatParser.mockReset()
  resetRegexDisplayReloadForTests()
  resetModuleRenderRevisionForTests()
})

afterEach(async () => {
  if (component) {
    await unmount(component)
    component = undefined
  }
  for (const resolve of pendingParses) resolve('')
  await settle()
  replaceResourceDatabase(previousDb)
  selectedCharID.set(previousSelectedChar)
  ReloadGUIPointer.set(previousReloadGui)
  VariableReloadGUIPointer.set(previousVariableReloadGui)
  RegexDisplayReloadScope.set(previousRegexDisplayScope)
  RegexDisplayReloadPointer.set(previousRegexDisplayReload)
  resetModuleRenderRevisionForTests()
  moduleBackgroundEmbedding.set(previousModuleBackgroundEmbedding)
  target.remove()
})

describe('BackgroundDom parser dependencies', () => {
  it('does not render the retained character background when the home screen has no visible selection', async () => {
    seedDatabase('Popup Editor\n\nMonaco editor\n\nMarkdown\nPreview\nX')
    moduleBackgroundEmbedding.set('<section>Module background</section>')
    selectedCharID.set(-1)
    component = mount(BackgroundDom, { target })
    await settle()

    expect(charactersResourceState.currentChar).toBe(0)
    expect(backgroundParserMocks.risuChatParser).not.toHaveBeenCalled()
    expect(target.textContent).toBe('')
  })

  it('clears the background on deselection even when a reparse finishes later', async () => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')

    const pending = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await pending.waitUntilStarted()

    selectedCharID.set(-1)
    await expectBackground('')
    pending.resolve('<section>Late character background</section>')
    await settle()
    expect(target.textContent).toBe('')

    selectedCharID.set(0)
    await expectBackground('background one')
  })

  it('fails closed when a ready projection has no selected owner', async () => {
    seedDatabase()
    charactersResourceState.currentChar = 99
    component = mount(BackgroundDom, { target })
    await settle()

    expect(backgroundParserMocks.risuChatParser).not.toHaveBeenCalled()
    expect(target.textContent).toBe('')
  })

  it('fails closed when a ready projection has duplicate selected owners', async () => {
    seedDatabase()
    charactersResourceState.characters = [
      charactersResourceState.characters[0],
      { ...charactersResourceState.characters[0] },
    ]
    component = mount(BackgroundDom, { target })
    await settle()

    expect(backgroundParserMocks.risuChatParser).not.toHaveBeenCalled()
    expect(target.textContent).toBe('')
  })

  it.each(['resource', 'row'] as const)('hides backgrounds when the %s is already in error', async (owner) => {
    seedDatabase()
    if (owner === 'resource') charactersResourceState.status = 'error'
    else charactersResourceState.rowStatuses['background-dom-character'] = 'error'
    component = mount(BackgroundDom, { target })
    await settle()
    expect(backgroundParserMocks.ParseMarkdown).not.toHaveBeenCalled()
    expect(target.textContent).toBe('')
  })

  it.each(['resource', 'row'] as const)('clears a visible background when the %s enters error', async (owner) => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    const pending = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await pending.waitUntilStarted()

    if (owner === 'resource') charactersResourceState.status = 'error'
    else charactersResourceState.rowStatuses['background-dom-character'] = 'error'
    await expectBackground('')
    pending.resolve('<section>stale background</section>')
    await settle()
    expect(target.textContent).toBe('')
  })

  it('keeps the background without additional parsing during unrelated message updates', async () => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    const parserCalls = backgroundParserMocks.risuChatParser.mock.calls.length
    const markdownCalls = backgroundParserMocks.ParseMarkdown.mock.calls.length

    for (const frame of ['stream frame one', 'stream frame two', 'stream frame three']) {
      withTestDatabaseWrite(() => {
        getResourceDatabase().characters[0].chats[0].message[0].data = frame
      })
      await settle()
      expect(target.textContent?.trim()).toBe('background one')
      expect(backgroundParserMocks.risuChatParser).toHaveBeenCalledTimes(parserCalls)
      expect(backgroundParserMocks.ParseMarkdown).toHaveBeenCalledTimes(markdownCalls)
    }
  })

  it('updates rendered character substitutions when personality or nickname changes', async () => {
    seedDatabase('<section>{{char}} {{personality}}</section>')
    component = mount(BackgroundDom, { target })
    await expectBackground('Background Character background personality')

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].personality = 'new personality'
    })
    await expectBackground('Background Character new personality')

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].nickname = 'Nickname'
    })
    await expectBackground('Nickname new personality')
  })

  it('renders changes to background HTML and module embedding', async () => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].backgroundHTML = '<section>background two</section>'
    })
    await expectBackground('background two')

    moduleBackgroundEmbedding.set('<aside>module background</aside>')
    await waitUntil(() => {
      expect(target.querySelector('section')?.textContent).toBe('background two')
      expect(target.querySelector('aside')?.textContent).toBe('module background')
      expect(target.textContent).not.toContain('background one')
    })
  })

  it.each([
    ['GUI', () => ReloadGUIPointer.update((value) => value + 1)],
    ['variables', () => VariableReloadGUIPointer.update((value) => value + 1)],
    ['modules', () => invalidateModuleRenderRevision()],
  ] as const)('displays refreshed parser output after %s invalidation', async (_name, invalidate) => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    backgroundParserMocks.ParseMarkdown.mockResolvedValue('<section>refreshed background</section>')
    invalidate()
    await expectBackground('refreshed background')
  })

  it('defers regex edits until a relevant owner is activated', async () => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    backgroundParserMocks.risuChatParser.mockClear()
    backgroundParserMocks.ParseMarkdown.mockClear()
    // Stand in for the parser output after activation; regex correctness belongs to parser tests.
    backgroundParserMocks.ParseMarkdown.mockResolvedValue('<section>activated background</section>')
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].customscript = [
        {
          id: 'background-display-script',
          comment: 'Background display script',
          in: 'background',
          out: 'delayed',
          type: 'editdisplay',
        },
      ]
    })
    await settle()
    expect(target.textContent?.trim()).toBe('background one')
    expect(backgroundParserMocks.ParseMarkdown).not.toHaveBeenCalled()

    for (const owner of ['character:other', 'module:other', 'preset:other']) {
      reloadRegexDisplay(owner)
      await settle()
      expect(backgroundParserMocks.risuChatParser).not.toHaveBeenCalled()
      expect(backgroundParserMocks.ParseMarkdown).not.toHaveBeenCalled()
      expect(target.textContent?.trim()).toBe('background one')
    }
    reloadRegexDisplay('character:background-dom-character')
    await expectBackground('activated background')
  })

  it('keeps the background visible while switching chats and parses in the new chat context', async () => {
    seedDatabase()
    const database = getResourceDatabase({ snapshot: true })
    database.characters[0].chats.push({ ...database.characters[0].chats[0], id: 'second-chat' })
    replaceResourceDatabase(database)
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    const pending = deferParse()
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chatPage = 1
    })
    await pending.waitUntilStarted()
    expect(target.textContent?.trim()).toBe('background one')
    expect(backgroundParserMocks.ParseMarkdown).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ chaId: 'background-dom-character' }),
      'back',
      -1,
      expect.any(Object),
      expect.objectContaining({ chatId: 'second-chat' }),
    )
    pending.resolve('<section>second chat background</section>')
    await expectBackground('second chat background')
  })

  it('hides the previous character background while another character loads and ignores late results', async () => {
    seedDatabase()
    const database = getResourceDatabase({ snapshot: true })
    database.characters.push({
      ...database.characters[0],
      chaId: 'second-character',
      backgroundHTML: '<section>second character</section>',
      chats: [{ ...database.characters[0].chats[0], id: 'second-chat' }],
    })
    replaceResourceDatabase(database)
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    const first = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await first.waitUntilStarted()
    // Selection and derived source updates can schedule more than one parse.
    // Hold every replacement parse so this checks visibility throughout loading.
    const second = deferParse({ subsequentCalls: true })
    charactersResourceState.currentChar = 1
    selectedCharID.set(1)
    await second.waitUntilStarted()
    expect(target.textContent).toBe('')
    second.resolve('<section>second character</section>')
    await expectBackground('second character')
    first.resolve('<section>late first character</section>')
    await settle()
    expect(target.textContent?.trim()).toBe('second character')
  })

  it('retains the newest result when same-character parses complete out of order', async () => {
    seedDatabase()
    component = mount(BackgroundDom, { target })
    await expectBackground('background one')
    const older = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await older.waitUntilStarted()
    const newer = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await newer.waitUntilStarted()
    expect(target.textContent?.trim()).toBe('background one')
    newer.resolve('<section>newest background</section>')
    await expectBackground('newest background')
    older.resolve('<section>obsolete background</section>')
    await settle()
    expect(target.textContent?.trim()).toBe('newest background')

    // A stale completion must not poison the retained content used by the next refresh.
    const next = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await next.waitUntilStarted()
    expect(target.textContent?.trim()).toBe('newest background')
    next.resolve('<section>final background</section>')
    await expectBackground('final background')
  })

  it('renders module-only backgrounds and clears removed sources despite a pending parse', async () => {
    seedDatabase('')
    moduleBackgroundEmbedding.set('<aside>module only</aside>')
    component = mount(BackgroundDom, { target })
    await expectBackground('module only')
    const pending = deferParse()
    ReloadGUIPointer.update((value) => value + 1)
    await pending.waitUntilStarted()
    moduleBackgroundEmbedding.set('')
    await expectBackground('')
    expect(target.children).toHaveLength(0)
    pending.resolve('<aside>removed module</aside>')
    await settle()
    expect(target.children).toHaveLength(0)
  })
})
