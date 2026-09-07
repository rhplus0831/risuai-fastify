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
  applyCharactersResource,
  applyCharacterResource,
  applyCollectionsResource,
  applySettingsGroupResource,
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
import { SERVER_CHARACTER_SUMMARY_VERSION } from '@risuai/protocol/character-summary-resource'
import { demoteClientSession } from '../ts/clientSession'
import { setManagedWriterForTest } from '../ts/__tests__/managedClientSession'
import { appendOptimisticGenerationOperationUserMessage } from '../ts/chatCommands'
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
  publishReaderFixtures()
}

function publishReaderFixtures() {
  const source = JSON.parse(JSON.stringify(charactersResourceState.characters)) as character[]
  applyCharactersResource({
    version: SERVER_CHARACTER_SUMMARY_VERSION,
    revision: 1,
    characters: source,
    characterOrder: [],
    currentChar: 0,
  })
  for (const character of source)
    for (const chat of character.chats) {
      hydration.applyServerChatMessagesResource(chat.id!, chat.message, undefined, [])
    }
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
  vi.spyOn(hydration, 'hydrateReaderChatMessageWindow').mockResolvedValue(true)
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
      expect(hydration.hydrateReaderChatMessageWindow).not.toHaveBeenCalled()
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
    expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenLastCalledWith('reader-chat', 4, { force: false })
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
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValueOnce(false)
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
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValue(false)
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[1].chats[0].message = []
    })
    hydration.resetChatHydration()
    await settle()
    expect(target.textContent).toContain('Reader message 2')
    expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenCalledTimes(1)
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
  it('keeps staged writer rows and metadata out of a demoted reader during held and failed refresh', async () => {
    setManagedWriterForTest()
    seedReaderChat(2)
    publishReaderFixtures()
    const previous = JSON.parse(JSON.stringify(charactersResourceState.characters[0])) as character
    const chatId = previous.chats[0].id!
    const committed = previous.chats[0].message[1].data
    const appended = appendOptimisticGenerationOperationUserMessage(
      {
        selectedCharID: 0,
        chatPage: 0,
        characterId: previous.chaId,
        chatId,
      },
      { role: 'user', data: 'Pending writer send', chatId: 'pending-send' },
    )
    expect(appended.status).toBe('ok')
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[0].displayName = 'Pending character name'
      charactersResourceState.characters[0].chats[0].name = 'Pending chat name'
      charactersResourceState.characters[0].firstMessage = 'Pending greeting'
    })
    let finish!: (value: boolean) => void
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    demoteClientSession()
    component = mount(ReaderTranscript, { target, props: { characterId: previous.chaId, chatId } })
    await settle()
    expect(hydration.hydrateReaderChatMessageWindow).toHaveBeenCalledOnce()
    expect(target.textContent).toContain(committed)
    expect(target.textContent).not.toContain('Pending writer send')
    expect(target.textContent).not.toContain('Pending character name')
    expect(target.textContent).not.toContain('Pending chat name')
    expect(target.textContent).not.toContain('Pending greeting')
    finish(false)
    await settle()
    expect(target.textContent).toContain(committed)
    expect(target.querySelector('[data-reader-read-failed]')).not.toBeNull()
    // A late obsolete rollback cannot change the newer certified reader body.
    const accepted = [
      ...previous.chats[0].message,
      { role: 'user', data: 'Server accepted send', chatId: 'pending-send' },
    ] as Message[]
    hydration.applyServerChatMessagesResource(chatId, accepted, undefined, [])
    if (appended.status === 'ok') appended.rollback()
    await settle()
    expect(charactersResourceState.characters[0].chats[0].message.at(-1)?.data).toBe('Server accepted send')
    expect(target.textContent).toContain('Server accepted send')
    expect(target.textContent).not.toContain('Pending writer send')
  })

  it('keeps committed body and details when a newer sparse shell cannot hydrate, including leave and return', async () => {
    setManagedWriterForTest()
    seedReaderChat(2)
    publishReaderFixtures()
    const previous = JSON.parse(JSON.stringify(charactersResourceState.characters[0])) as character
    const chatId = previous.chats[0].id!
    const committed = previous.chats[0].message[1].data
    demoteClientSession()
    const summary = {
      chaId: previous.chaId,
      name: 'New committed summary name',
      type: 'character',
      __serverCharacterShell: true,
      chatIds: [chatId],
      chatCount: 1,
    } as unknown as character
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 2,
      characters: [summary],
      characterOrder: [],
      currentChar: 0,
    })
    vi.mocked(hydration.hydrateReaderChatMessageWindow).mockResolvedValue(false)
    for (let visit = 0; visit < 2; visit += 1) {
      component = mount(ReaderTranscript, { target, props: { characterId: previous.chaId, chatId } })
      await settle()
      expect(target.textContent).toContain(committed)
      expect(target.querySelector('[data-reader-read-failed]')).not.toBeNull()
      expect(target.textContent).toContain('New committed summary name')
      await unmount(component)
      component = undefined
    }
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 3,
      characters: [{ ...summary, chatIds: [] } as unknown as character],
      characterOrder: [],
      currentChar: 0,
    })
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 4,
      characters: [summary],
      characterOrder: [],
      currentChar: 0,
    })
    expect(hydration.getReaderChatMessageOwnerState(chatId)?.messages).toEqual([])
    component = mount(ReaderTranscript, { target, props: { characterId: previous.chaId, chatId } })
    await settle()
    expect(target.textContent).not.toContain(committed)
  })

  it('uses certified persona bindings and names while newer local edits remain pending', async () => {
    seedReaderChat(1)
    startReader()
    const source = JSON.parse(JSON.stringify(charactersResourceState.characters[1])) as character
    source.chats[0].generationSettings = { personaId: 'persona-a' }
    source.chats[0].message[0].role = 'user'
    hydration.applyServerChatMessagesResource('reader-chat', source.chats[0].message, undefined, [])
    applyCharacterResource({ revision: 2, character: source })
    applyCollectionsResource({
      revision: 2,
      collections: {
        personas: [
          { id: 'persona-a', name: 'Committed persona', icon: '', largePortrait: false, personaPrompt: '' },
          { id: 'persona-b', name: 'Other persona', icon: '', largePortrait: false, personaPrompt: '' },
        ],
      },
    })
    applySettingsGroupResource({ revision: 2, group: 'display', settings: { username: 'Committed user' } }, [
      'username',
    ])
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[1].chats[0].generationSettings = { personaId: 'persona-b' }
      collectionsResourceState.values.personas![0].name = 'Pending persona name'
    })
    component = mount(ReaderTranscript, { target, props: { characterId: 'reader-character', chatId: 'reader-chat' } })
    await settle()
    expect(target.textContent).toContain('Committed persona')
    expect(target.textContent).not.toContain('Other persona')
    expect(target.textContent).not.toContain('Pending persona name')
  })
})
