import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReaderTranscript from './ReaderTranscript.svelte'
import { language } from '../lang'
import { seedRenderCostMessages } from '../ts/__tests__/renderCostHarness'
import { withTestDatabaseWrite } from '../ts/__tests__/resourceDatabaseState'
import {
  charactersResourceState,
  settingsResourceState,
  collectionsResourceState,
} from '../ts/server/resourceState.svelte'
import * as hydration from '../ts/server/chatMessageHydration.svelte'
import * as resourceReads from '../ts/server/resourceReads'
import { resetReaderDisplayResourcesForTests } from '../ts/server/readerDisplayResources'
import * as parser from '../ts/parser/parser.svelte'
import { selectedCharID, SizeStore } from '../ts/stores.svelte'
import {
  beginClientSession,
  settleClientReader,
  setClientProjectionReady,
  setClientConnectionState,
  resetClientSessionForTests,
  requireClientAuthentication,
} from '../ts/clientSession'
import { resetStartupReadinessForTests } from '../ts/startupReadiness'
import { clearChatBodyParseMemo } from './ChatScreens/ChatBodyParseMemo'
import type { character, Message } from '../ts/storage/database.svelte'

vi.mock('../ts/process/modules', async (importActual) => ({
  ...(await importActual<typeof import('../ts/process/modules')>()),
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleRegexScripts: () => [],
  getModuleTriggers: () => [],
  getModules: () => [],
  moduleUpdate: () => {},
}))

let target: HTMLElement
let component: ReturnType<typeof mount> | undefined

async function settle() {
  flushSync()
  for (let index = 0; index < 6; index += 1) {
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function startReader() {
  const operation = beginClientSession('reader')
  settleClientReader(operation, { databaseLineage: 'reader-tests', writer: { sessionId: 'writer', epoch: 1 } })
  setClientProjectionReady(true)
  setClientConnectionState('live')
}

function seedReaderChat(count = 3) {
  seedRenderCostMessages(count)
  const writer = charactersResourceState.characters[0]
  const reader = JSON.parse(JSON.stringify(writer)) as character
  reader.chaId = 'reader-character'
  reader.name = 'Reader character'
  reader.firstMessage = ''
  reader.alternateGreetings = []
  reader.chats[0].id = 'reader-chat'
  reader.chats[0].name = 'Reader conversation'
  reader.chats[0].message = reader.chats[0].message.map((message, index) => ({
    ...message,
    data: `Reader message ${index}`,
  }))
  withTestDatabaseWrite(() => {
    charactersResourceState.characters.push(reader)
    settingsResourceState.value.useChatCopy = true
    settingsResourceState.value.clickToEdit = true
    settingsResourceState.value.chatLoadInitialPages = 2
    settingsResourceState.value.chatLoadAdditionalPages = 2
    collectionsResourceState.values.promptPresets = []
    collectionsResourceState.statuses.promptPresets = 'ready'
    collectionsResourceState.values.personas = []
    collectionsResourceState.statuses.personas = 'ready'
  })
  return charactersResourceState.characters[1]
}

beforeEach(() => {
  resetReaderDisplayResourcesForTests()
  resetClientSessionForTests()
  resetStartupReadinessForTests()
  hydration.resetChatHydration()
  clearChatBodyParseMemo()
  target = document.createElement('div')
  document.body.appendChild(target)
  vi.spyOn(parser, 'ParseMarkdown').mockImplementation(async (source) => `<p>${source}</p>`)
  vi.spyOn(hydration, 'hydrateChatMessageWindow').mockResolvedValue(true)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('unexpected network request'))),
  )
  SizeStore.set({ w: 900, h: 700 })
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  resetReaderDisplayResourcesForTests()
  resetClientSessionForTests()
  hydration.resetChatHydration()
  clearChatBodyParseMemo()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  target.remove()
})

describe('connected reader transcript', () => {
  it('renders its explicit chat with copy and a disabled composer without changing writer selection', async () => {
    seedReaderChat()
    startReader()
    const clipboard = { writeText: vi.fn(async () => undefined) }
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard })
    try {
      component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
      await settle()
      expect(target.textContent).toContain('Reader message 2')
      expect(target.textContent).not.toContain('Phase 0 render-cost message')
      expect(target.querySelector<HTMLTextAreaElement>('[data-reader-composer] textarea')?.disabled).toBe(true)
      expect(
        target.querySelector(
          '[data-risu-message-action="edit"], [data-risu-message-action="remove"], [data-risu-message-action="translate"], [data-risu-message-action="reroll"]',
        ),
      ).toBeNull()
      const copy = target.querySelector<HTMLButtonElement>('[data-risu-message-action="copy"]')
      expect(copy).not.toBeNull()
      copy!.click()
      await settle()
      expect(clipboard.writeText).toHaveBeenCalledWith('Reader message 2')
      expect(hydration.hydrateChatMessageWindow).toHaveBeenCalledWith('reader-chat', 2, { force: false })
      expect(get(selectedCharID)).toBe(0)
      expect(charactersResourceState.currentChar).toBe(0)
      expect(charactersResourceState.characters[0].chatPage).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      if (descriptor) Object.defineProperty(window.navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(window.navigator, 'clipboard')
    }
  })

  it('loads shell-only display inputs before exposing mobile copy and adopts the configured initial window', async () => {
    seedReaderChat(5)
    withTestDatabaseWrite(() => {
      settingsResourceState.value = { username: 'Shell user', language: 'en' }
      settingsResourceState.groupStatuses = {}
      settingsResourceState.groupRevisions = {}
      settingsResourceState.fullRevision = null
      settingsResourceState.standaloneStatuses = {}
      settingsResourceState.standaloneRevisions = {}
      collectionsResourceState.values = {}
      collectionsResourceState.statuses = {}
      collectionsResourceState.revisions = {}
      collectionsResourceState.fullRevision = null
    })
    let finishDisplay!: (value: Awaited<ReturnType<typeof resourceReads.fetchServerSettingsGroup>>) => void
    const pendingDisplay = new Promise<Awaited<ReturnType<typeof resourceReads.fetchServerSettingsGroup>>>(
      (resolve) => {
        finishDisplay = resolve
      },
    )
    vi.spyOn(resourceReads, 'fetchServerSettingsGroup').mockImplementation(async (group) =>
      group === 'display' ? pendingDisplay : { status: 'ok', revision: 7, group, settings: {} },
    )
    vi.spyOn(resourceReads, 'fetchServerCollection').mockImplementation(async (name) => ({
      status: 'ok',
      revision: 7,
      collections: { [name]: [] },
    }))
    vi.spyOn(resourceReads, 'fetchServerStandaloneSetting').mockImplementation(async (setting) => ({
      status: 'ok',
      revision: 7,
      setting,
      state: { present: false },
    }))
    SizeStore.set({ w: 320, h: 700 })
    startReader()
    const clipboard = { writeText: vi.fn(async () => undefined) }
    const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: clipboard })
    try {
      component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
      await settle()
      expect(target.textContent).toContain('Reader message 4')
      expect(target.querySelector('[data-risu-message-action="copy"]')).toBeNull()
      expect(resourceReads.fetchServerSettingsGroup).toHaveBeenCalledWith('display', expect.any(AbortSignal))
      finishDisplay({
        status: 'ok',
        revision: 7,
        group: 'display',
        settings: { useChatCopy: true, chatLoadInitialPages: 1, chatLoadAdditionalPages: 2 },
      })
      await settle()
      expect(target.querySelectorAll('.risu-chat')).toHaveLength(1)
      expect(target.querySelector('[data-reader-load-more]')).not.toBeNull()
      const copy = target.querySelector<HTMLButtonElement>('[data-risu-message-action="copy"]')
      expect(copy).not.toBeNull()
      copy!.click()
      await settle()
      expect(clipboard.writeText).toHaveBeenCalledWith('Reader message 4')
      expect(target.querySelector<HTMLTextAreaElement>('[data-reader-composer] textarea')?.disabled).toBe(true)
      expect(get(selectedCharID)).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      if (descriptor) Object.defineProperty(window.navigator, 'clipboard', descriptor)
      else Reflect.deleteProperty(window.navigator, 'clipboard')
    }
  })

  it('keeps readable text on display dependency failure and retries dependencies with Refresh', async () => {
    seedReaderChat()
    withTestDatabaseWrite(() => {
      delete settingsResourceState.value.useChatCopy
      settingsResourceState.groupStatuses.display = 'idle'
      delete settingsResourceState.groupRevisions.display
      settingsResourceState.fullRevision = null
    })
    const displayRead = vi
      .spyOn(resourceReads, 'fetchServerSettingsGroup')
      .mockResolvedValueOnce({ status: 'error', error: 'Display read unavailable' })
      .mockResolvedValue({
        status: 'ok',
        revision: 7,
        group: 'display',
        settings: { useChatCopy: true, chatLoadInitialPages: 2 },
      })
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    expect(target.querySelector('[data-reader-read-failed]')?.textContent).toBe(language.connectedReaders.readFailed)
    target.querySelector<HTMLButtonElement>('[data-reader-refresh]')!.click()
    await settle()
    expect(displayRead).toHaveBeenCalledTimes(2)
    expect(settingsResourceState.groupStatuses.display, settingsResourceState.groupErrors.display).toBe('ready')
    expect(settingsResourceState.value.useChatCopy).toBe(true)
    expect(target.querySelector('[data-risu-message-action="copy"]'), target.innerHTML).not.toBeNull()
    expect(target.querySelector('[data-reader-read-failed]')).toBeNull()
  })

  it('loads older history through the explicit chat window while reusing existing transcript rows', async () => {
    seedReaderChat(5)
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.querySelectorAll('.risu-chat')).toHaveLength(2)
    const newest = target.querySelector('[data-risu-message-id="render-cost-message-4"]')
    target.querySelector<HTMLButtonElement>('[data-reader-load-more]')!.click()
    await settle()
    expect(hydration.hydrateChatMessageWindow).toHaveBeenLastCalledWith('reader-chat', 4, { force: false })
    expect(target.querySelectorAll('.risu-chat')).toHaveLength(4)
    expect(target.querySelector('[data-risu-message-id="render-cost-message-4"]')).toBe(newest)
    expect(get(selectedCharID)).toBe(0)
  })

  it('shows committed updates and keeps the same content when refresh fails', async () => {
    const reader = seedReaderChat()
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    const committed = JSON.parse(JSON.stringify(reader.chats[0].message)) as Message[]
    committed[2].data = 'Committed reader update'
    hydration.applyServerChatMessagesResource('reader-chat', committed, undefined, [])
    await settle()
    expect(target.textContent).toContain('Committed reader update')
    vi.mocked(hydration.hydrateChatMessageWindow).mockResolvedValueOnce(false)
    target.querySelector<HTMLButtonElement>('[data-reader-refresh]')!.click()
    await settle()
    expect(target.querySelector('[data-reader-read-failed]')?.textContent).toBe(language.connectedReaders.readFailed)
    expect(target.textContent).toContain('Committed reader update')
    setClientConnectionState('interrupted')
    await settle()
    expect(target.textContent).toContain('Committed reader update')
  })

  it('retains the last usable same-route view while a full refresh re-stubs its body', async () => {
    seedReaderChat()
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    vi.mocked(hydration.hydrateChatMessageWindow).mockResolvedValue(false)
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[1].chats[0].message = []
    })
    hydration.resetChatHydration()
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    expect(hydration.hydrateChatMessageWindow).toHaveBeenCalledTimes(2)
    expect(target.querySelector('[data-reader-read-failed]')).not.toBeNull()
  })
  it('clears live and retained transcript content when authentication is lost', async () => {
    seedReaderChat()
    startReader()
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    requireClientAuthentication()
    await settle()
    expect(target.textContent).not.toContain('Reader message 2')
    expect(target.querySelector('.risu-chat')).toBeNull()
  })
})
