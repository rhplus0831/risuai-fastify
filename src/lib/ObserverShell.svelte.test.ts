import { IDBFactory } from 'fake-indexeddb'
import {
  beginClientSession,
  settleClientReader,
  setClientProjectionReady,
  setClientConnectionState,
  resetClientSessionForTests,
} from '../ts/clientSession'
import { language } from '../lang'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppRoute } from '../ts/routerRoute'
import type { Database, character } from '../ts/storage/database.svelte'

const observerShellMocks = vi.hoisted(() => ({
  hydrateCharacterShell: vi.fn(async () => true),
  hydrationState: { rows: {} as Record<string, { status: string; error: string | null }> },
  navigate: vi.fn(),
  retryObserverWriterPromotion: vi.fn(async () => false),
  routerExports: undefined as
    | {
        characterRoutePath: (characterId: string, chatId?: string) => string
        currentRoute: import('svelte/store').Writable<AppRoute>
        navigate: (path: string, options?: { replace?: boolean }) => void
      }
    | undefined,
}))

async function createRouterMock() {
  if (!observerShellMocks.routerExports) {
    const [{ writable }, { characterRoutePath, parseRoute }] = await Promise.all([
      import('svelte/store'),
      import('../ts/routerRoute'),
    ])
    const currentRoute = writable<AppRoute>({ kind: 'home', path: '/' })
    observerShellMocks.routerExports = {
      characterRoutePath,
      currentRoute,
      navigate: (path: string, options?: { replace?: boolean }) => {
        if (options) observerShellMocks.navigate(path, options)
        else observerShellMocks.navigate(path)
        if (options?.replace) window.history.replaceState(null, '', path)
        else window.history.pushState(null, '', path)
        currentRoute.set(parseRoute(path))
      },
    }
  }
  return observerShellMocks.routerExports
}

vi.mock('../ts/router', createRouterMock)
vi.mock('./ReaderTranscript.svelte', async () => ({
  default: (await import('./ReaderTranscript.testStub.svelte')).default,
}))
vi.mock('../ts/server/characterShellHydration.svelte', () => ({
  characterShellHydrationState: observerShellMocks.hydrationState,
  hydrateCharacterShell: observerShellMocks.hydrateCharacterShell,
}))
vi.mock('../ts/bootstrap', () => ({
  retryObserverWriterPromotion: observerShellMocks.retryObserverWriterPromotion,
}))

import {
  clearPendingMutationOutbox,
  countPendingMutationRecords,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from '../ts/server/pendingMutationOutbox'
import { charactersResourceState, replaceResourceDatabase } from '../ts/server/resourceState.svelte'
import { withTestDatabaseWrite } from '../ts/__tests__/resourceDatabaseState'
import { peekObserverRouteIntent, resetObserverRouteIntentForTests } from '../ts/observerRouteIntent'
import { resetObserverShellLifecycleForTests, setObserverShellLifecycleMode } from '../ts/observerShellLifecycle.svelte'
import { selectedCharID } from '../ts/stores.svelte'

const { default: ObserverShell } = await import('./ObserverShell.svelte')

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function makeShell(characterId: string, name: string) {
  return {
    __serverCharacterShell: true,
    activeChatId: 'chat-a',
    chaId: characterId,
    chatCount: 2,
    chatIds: ['chat-a', 'chat-b'],
    creation_date: null,
    creatorNotes: 'A compact server summary.',
    displayName: name,
    image: '',
    lastInteraction: null,
    modification_date: null,
    name,
    pinnedChats: [{ id: 'chat-a', name: 'Pinned chat' }],
    trashTime: null,
    type: 'character' as const,
  }
}

function makeDetailedCharacter(): character {
  return {
    ...makeShell('char-a', 'Character A'),
    __serverCharacterShell: undefined,
    alternateGreetings: [],
    bias: [],
    characterVersion: '',
    chatFolders: [],
    chatPage: 0,
    chats: [{ id: 'chat-a', localLore: [], message: [], modules: [], name: 'Detailed chat', note: '' }],
    creator: '',
    customscript: [],
    desc: '',
    emotionImages: [],
    exampleMessage: '',
    firstMessage: '',
    firstMsgIndex: 0,
    globalLore: [],
    notes: '',
    personality: '',
    postHistoryInstructions: '',
    scenario: '',
    sdData: [],
    systemPrompt: '',
    tags: [],
    triggerscript: [],
    utilityBot: false,
    viewScreen: 'none',
  } as unknown as character
}

function seedShellDatabase(): void {
  replaceResourceDatabase({
    characterOrder: ['char-a'],
    characters: [makeShell('char-a', 'Character A')],
    currentChar: -1,
  } as unknown as Database)
}

async function mountObserverShell(): Promise<void> {
  if (component) await unmount(component)
  component = mount(ObserverShell, { target })
  await tick()
}

describe('pre-writer ObserverShell', () => {
  it('gates an authoring URL while keeping keyboard-focusable reader navigation and honest connection status', async () => {
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    setClientProjectionReady(true)
    setClientConnectionState('live')
    const router = await createRouterMock()
    router.navigate('/settings/persona')
    await mountObserverShell()
    expect(target.querySelector('[data-reader-authoring-gate]')?.textContent).toBe(
      language.connectedReaders.writeAccessRequired,
    )
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.connected,
    )
    expect(target.querySelector('input, textarea, [contenteditable="true"]')).toBeNull()
    const home = target.querySelector<HTMLButtonElement>('nav button')!
    home.focus()
    expect(document.activeElement).toBe(home)
    home.click()
    await tick()
    expect(get(router.currentRoute).kind).toBe('home')
    expect(target.querySelector('[data-reader-authoring-gate]')).toBeNull()
    setClientConnectionState('interrupted')
    await tick()
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.interrupted,
    )
    expect(observerShellMocks.retryObserverWriterPromotion).not.toHaveBeenCalled()
  })

  beforeEach(async () => {
    resetClientSessionForTests()
    vi.stubGlobal('indexedDB', new IDBFactory())
    vi.stubGlobal('fetch', vi.fn())
    resetPendingMutationOutboxForTests()
    await preparePendingMutationOutbox({
      writerSessionId: 'writer-a',
      writerEpoch: 1,
      databaseLineage: 'database-a',
      requestedWriterWasActive: true,
    })
    resetObserverRouteIntentForTests()
    resetObserverShellLifecycleForTests()
    observerShellMocks.hydrationState.rows = {}
    observerShellMocks.hydrateCharacterShell.mockReset().mockResolvedValue(true)
    observerShellMocks.retryObserverWriterPromotion.mockReset().mockResolvedValue(false)
    observerShellMocks.navigate.mockClear()
    observerShellMocks.routerExports?.currentRoute.set({ kind: 'home', path: '/' })
    selectedCharID.set(-1)
    seedShellDatabase()
    target = document.createElement('div')
    document.body.appendChild(target)
    await mountObserverShell()
  })

  afterEach(async () => {
    resetClientSessionForTests()
    if (component) {
      unmount(component)
      component = undefined
    }
    await clearPendingMutationOutbox()
    resetPendingMutationOutboxForTests()
    resetObserverRouteIntentForTests()
    resetObserverShellLifecycleForTests()
    replaceResourceDatabase({} as Database)
    target.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('announces read-only mode and uses keyboard-native navigation controls', () => {
    const status = target.querySelector('[data-observer-read-only-status]')
    const characterButton = target.querySelector<HTMLButtonElement>('button[aria-label="Open Character A"]')

    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.textContent).toContain('Read only')
    expect(characterButton?.type).toBe('button')
  })

  it('keeps the latest character/chat choice local with no command request or pending record', async () => {
    target.querySelector<HTMLButtonElement>('button[aria-label="Open Character A"]')?.click()
    await tick()
    target.querySelector<HTMLButtonElement>('button[aria-label="Open chat Pinned chat"]')?.click()
    await tick()

    expect(observerShellMocks.navigate).toHaveBeenNthCalledWith(1, '/character/char-a')
    expect(observerShellMocks.navigate).toHaveBeenNthCalledWith(2, '/character/char-a/chat-a')
    expect(peekObserverRouteIntent()?.route).toEqual({
      kind: 'character',
      path: '/character/char-a/chat-a',
      chaId: 'char-a',
      chatId: 'chat-a',
    })
    expect(get(selectedCharID)).toBe(-1)
    expect(await countPendingMutationRecords()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps summary and optional detail states distinct without writer-side effects', async () => {
    target.querySelector<HTMLButtonElement>('button[aria-label="Open Character A"]')?.click()
    await tick()
    expect(target.querySelector('[data-observer-character-summary]')).not.toBeNull()
    expect(target.textContent).toContain('Summary preview')

    observerShellMocks.hydrateCharacterShell.mockImplementationOnce(async () => {
      replaceResourceDatabase({
        characterOrder: ['char-a'],
        characters: [makeDetailedCharacter()],
        currentChar: -1,
      } as unknown as Database)
      return true
    })
    target.querySelector<HTMLButtonElement>('button[aria-label="Load read-only details for Character A"]')?.click()
    await tick()
    await tick()

    expect(observerShellMocks.hydrateCharacterShell).toHaveBeenCalledWith('char-a', { supersede: true })
    expect(target.querySelector('[data-observer-character-summary]')).toBeNull()
    expect(target.textContent).toContain('Read-only details')
    expect(target.querySelector('button[aria-label="Open chat Detailed chat"]')).not.toBeNull()
    expect(await countPendingMutationRecords()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the observer visible with targeted retry status and restores focus after failure', async () => {
    setObserverShellLifecycleMode('writer-lost')
    await tick()

    const retry = target.querySelector<HTMLButtonElement>('[data-observer-writer-retry]')
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toContain(
      'Write access moved to another session',
    )
    expect(retry?.textContent).toContain('Retry write access')

    retry?.click()
    await vi.waitFor(() => expect(observerShellMocks.retryObserverWriterPromotion).toHaveBeenCalledOnce())
    await tick()

    expect(document.activeElement).toBe(retry)
    expect(target.querySelector('[data-observer-shell]')).not.toBeNull()
  })
  it('browses a reader chat independently of canonical selection and follows local history routes', async () => {
    const writer = makeDetailedCharacter()
    writer.chaId = 'writer-character'
    writer.name = 'Writer character'
    writer.displayName = 'Writer character'
    writer.chats[0].id = 'writer-chat'
    const reader = makeDetailedCharacter()
    reader.chats.push({ ...reader.chats[0], id: 'chat-b', name: 'Second reader chat', message: [] })
    replaceResourceDatabase({ characters: [writer, reader], currentChar: 0 } as unknown as Database)
    selectedCharID.set(0)
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    setClientProjectionReady(true)
    setClientConnectionState('live')
    await tick()
    const router = await createRouterMock()
    target.querySelector<HTMLButtonElement>('button[aria-label="Open Character A"]')!.click()
    await tick()
    target.querySelector<HTMLButtonElement>('button[aria-label="Open chat Second reader chat"]')!.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]')?.getAttribute('data-chat-id')).toBe('chat-b'),
    )
    expect(get(selectedCharID)).toBe(0)
    expect(charactersResourceState.currentChar).toBe(0)
    expect(charactersResourceState.characters[1].chatPage).toBe(0)
    // Browser/notification navigation delivers a route, never writer selection.
    router.currentRoute.set({ kind: 'character', path: '/character/char-a/chat-a', chaId: 'char-a', chatId: 'chat-a' })
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]')?.getAttribute('data-chat-id')).toBe('chat-a'),
    )
    router.currentRoute.set({ kind: 'character', path: '/character/char-a/chat-b', chaId: 'char-a', chatId: 'chat-b' })
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]')?.getAttribute('data-chat-id')).toBe('chat-b'),
    )
    expect(get(selectedCharID)).toBe(0)
    expect(await countPendingMutationRecords()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('replaces only the local URL when the selected chat or character is authoritatively deleted', async () => {
    const reader = makeDetailedCharacter()
    reader.chats.push({ ...reader.chats[0], id: 'chat-b', name: 'Surviving chat', message: [] })
    replaceResourceDatabase({ characters: [reader], currentChar: -1 } as unknown as Database)
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    setClientProjectionReady(true)
    const router = await createRouterMock()
    router.navigate('/character/char-a/chat-a')
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]'), target.innerHTML).not.toBeNull(),
    )
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[0].chats.splice(0, 1)
    })
    await vi.waitFor(() => expect(get(router.currentRoute).path).toBe('/character/char-a/chat-b'))
    await tick()
    expect(observerShellMocks.navigate).toHaveBeenLastCalledWith('/character/char-a/chat-b', { replace: true })
    expect(target.querySelector('[data-reader-route-notice]')?.textContent).toBe(
      language.connectedReaders.chatUnavailable,
    )
    withTestDatabaseWrite(() => {
      charactersResourceState.characters = []
    })
    await vi.waitFor(() => expect(get(router.currentRoute).path).toBe('/'))
    await tick()
    expect(observerShellMocks.navigate).toHaveBeenLastCalledWith('/', { replace: true })
    expect(target.querySelector('[data-reader-route-notice]')?.textContent).toBe(
      language.connectedReaders.characterUnavailable,
    )
    expect(get(selectedCharID)).toBe(-1)
    expect(await countPendingMutationRecords()).toBe(0)
  })

  it('does not replace the route for failed reads and rejects duplicate IDs without mounting a transcript', async () => {
    const reader = makeDetailedCharacter()
    replaceResourceDatabase({ characters: [reader], currentChar: -1 } as unknown as Database)
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    setClientProjectionReady(true)
    const router = await createRouterMock()
    router.navigate('/character/char-a/chat-a')
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]'), target.innerHTML).not.toBeNull(),
    )
    withTestDatabaseWrite(() => {
      charactersResourceState.status = 'error'
    })
    await tick()
    expect(get(router.currentRoute).path).toBe('/character/char-a/chat-a')
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
    expect(target.querySelector('[data-reader-resource-read-failed]')?.textContent).toBe(
      language.connectedReaders.readFailed,
    )
    withTestDatabaseWrite(() => {
      charactersResourceState.status = 'ready'
      charactersResourceState.characters.push({ ...reader, chaId: 'duplicate-chat-owner' })
    })
    await tick()
    expect(target.querySelector('[data-reader-ambiguous-target]')?.textContent).toBe(
      language.connectedReaders.ambiguousConversation,
    )
    expect(target.querySelector('[data-reader-test-transcript]')).toBeNull()
    expect(get(router.currentRoute).path).toBe('/character/char-a/chat-a')
  })
})
