import { IDBFactory } from 'fake-indexeddb'
import {
  authorizeClientWriterRecovery,
  authenticateClientSessionReadView,
  beginClientPromotion,
  beginClientSession,
  beginClientWriterResume,
  completeClientWriterRecovery,
  failClientSessionOperation,
  getClientSessionSnapshot,
  observeClientWriter,
  settleClientReader,
  setClientProjectionReady,
  setClientConnectionState,
  resetClientSessionForTests,
  requireClientAuthentication,
} from '../ts/clientSession'
import { changeLanguage, language } from '../lang'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DynamicGUI } from '../ts/stores.svelte'

import type { AppRoute } from '../ts/routerRoute'
import type { Database, character } from '../ts/storage/database.svelte'
import type { ConnectedWriterPromotionResult } from '../ts/bootstrap'

const readOnlyWorkspaceMocks = vi.hoisted(() => ({
  hydrateCharacterShell: vi.fn(async () => true),
  hydrationState: { rows: {} as Record<string, { status: string; error: string | null }> },
  navigate: vi.fn(),
  promoteConnectedReader: vi.fn<() => Promise<ConnectedWriterPromotionResult>>(async () => ({ status: 'cancelled' })),
  routerExports: undefined as
    | {
        characterRoutePath: (characterId: string, chatId?: string) => string
        currentRoute: import('svelte/store').Writable<AppRoute>
        navigate: (path: string, options?: { replace?: boolean }) => void
      }
    | undefined,
}))

async function createRouterMock() {
  if (!readOnlyWorkspaceMocks.routerExports) {
    const [{ writable }, { characterRoutePath, parseRoute }] = await Promise.all([
      import('svelte/store'),
      import('../ts/routerRoute'),
    ])
    const currentRoute = writable<AppRoute>({ kind: 'home', path: '/' })
    readOnlyWorkspaceMocks.routerExports = {
      characterRoutePath,
      currentRoute,
      navigate: (path: string, options?: { replace?: boolean }) => {
        if (options) readOnlyWorkspaceMocks.navigate(path, options)
        else readOnlyWorkspaceMocks.navigate(path)
        if (options?.replace) window.history.replaceState(null, '', path)
        else window.history.pushState(null, '', path)
        currentRoute.set(parseRoute(path))
      },
    }
  }
  return readOnlyWorkspaceMocks.routerExports
}

vi.mock('../ts/router', createRouterMock)
vi.mock('./ReaderTranscript.svelte', async () => ({
  default: (await import('./ReaderTranscript.testStub.svelte')).default,
}))
vi.mock('../ts/server/characterShellHydration.svelte', () => ({
  characterShellHydrationState: readOnlyWorkspaceMocks.hydrationState,
  hydrateCharacterShell: readOnlyWorkspaceMocks.hydrateCharacterShell,
}))
vi.mock('../ts/bootstrap', () => ({
  promoteConnectedReader: readOnlyWorkspaceMocks.promoteConnectedReader,
}))

import {
  clearPendingMutationOutbox,
  countPendingMutationRecords,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from '../ts/server/pendingMutationOutbox'
import { SERVER_CHARACTER_SUMMARY_VERSION } from '@risuai/protocol/character-summary-resource'
import {
  charactersResourceState,
  replaceResourceDatabase,
  applyCharactersResource,
  applyCharacterResource,
} from '../ts/server/resourceState.svelte'
import { withTestDatabaseWrite } from '../ts/__tests__/resourceDatabaseState'
import { peekReaderRouteIntent, resetReaderRouteIntentForTests } from '../ts/readerRouteIntent'
import {
  resetReaderWorkspaceLifecycleForTests,
  setReaderWorkspaceLifecycleMode,
} from '../ts/readerWorkspaceLifecycle.svelte'
import { selectedCharID } from '../ts/stores.svelte'
import { recordReaderNavigationSettings } from '../ts/server/readerTranscriptProjection.svelte'

const { default: Workspace } = await import('./Workspace.svelte')

type MountedWorkspace = Parameters<typeof unmount>[0]

let component: MountedWorkspace | undefined
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

async function mountWorkspace(): Promise<void> {
  if (component) await unmount(component)
  component = mount(Workspace, { target, props: { readerMode: true } })
  await tick()
}

async function expandReaderHamburger(): Promise<HTMLButtonElement> {
  const toggle = target.querySelector<HTMLButtonElement>('[data-reader-navigation] [data-risu-hamburger-menu-toggle]')
  expect(toggle).not.toBeNull()
  if (toggle!.getAttribute('aria-expanded') !== 'true') {
    toggle!.click()
    await tick()
  }
  return toggle!
}

async function showConnectedReaderChat(): Promise<void> {
  const reader = makeDetailedCharacter()
  reader.chats.push({ ...reader.chats[0], id: 'chat-b', name: 'Second reader chat', message: [] })
  replaceResourceDatabase({ characters: [reader], currentChar: -1 } as unknown as Database)
  const operation = beginClientSession('reader-a')
  settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
  publishReaderCharacters()
  setClientProjectionReady(true)
  setClientConnectionState('live')
  const router = await createRouterMock()
  router.navigate('/character/char-a/chat-a')
  await vi.waitFor(() => expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull())
}

function publishReaderCharacters() {
  applyCharactersResource({
    version: SERVER_CHARACTER_SUMMARY_VERSION,
    revision: (charactersResourceState.revision ?? 0) + 1,
    characters: JSON.parse(JSON.stringify(charactersResourceState.characters)),
    characterOrder: [],
    currentChar: charactersResourceState.currentChar,
  })
}

function useThisDeviceButton(): HTMLButtonElement {
  return target.querySelector<HTMLButtonElement>('[data-reader-use-this-device]')!
}

function deferredPromotion() {
  let resolve!: (result: ConnectedWriterPromotionResult) => void
  const promise = new Promise<ConnectedWriterPromotionResult>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function beginAutomaticPreview(phase: 'resolving' | 'recovering' | 'resuming') {
  const operation = beginClientSession('preview-writer')
  authenticateClientSessionReadView(operation, { databaseLineage: 'database-a', writer: { sessionId: null, epoch: 1 } })
  setClientProjectionReady(true)
  setClientConnectionState('live')
  if (phase === 'resolving') return operation
  const ownership = { databaseLineage: 'database-a', writer: { sessionId: 'preview-writer', epoch: 2 } }
  authorizeClientWriterRecovery(operation, ownership)
  if (phase === 'recovering') return operation
  setClientConnectionState('interrupted')
  const resumed = beginClientWriterResume()!
  authorizeClientWriterRecovery(resumed, ownership)
  setClientConnectionState('live')
  return resumed
}

describe('read-only workspace', () => {
  it.each(['resolving', 'recovering', 'resuming'] as const)(
    'keeps the automatic %s shell visible without detail or transcript work',
    async (phase) => {
      const operation = beginAutomaticPreview(phase)
      publishReaderCharacters()
      const router = await createRouterMock()
      router.navigate('/character/char-a/chat-a')
      await mountWorkspace()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await tick()
      expect(target.querySelector('[data-risu-workspace]')).not.toBeNull()
      expect(target.textContent).toContain('Character A')
      expect(readOnlyWorkspaceMocks.hydrateCharacterShell).not.toHaveBeenCalled()
      expect(target.querySelector('[data-reader-test-transcript]')).toBeNull()
      applyCharacterResource({ revision: 3, character: makeDetailedCharacter() })
      await tick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(target.querySelector('[data-reader-test-transcript]')).toBeNull()
      const writer = getClientSessionSnapshot().writer!
      expect(settleClientReader(operation, { databaseLineage: 'database-a', writer })).toBe(true)
      await vi.waitFor(() => expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull())
      expect(get(selectedCharID)).toBe(-1)
      expect(await countPendingMutationRecords()).toBe(0)
    },
  )

  it.each(['/character/char-a/pending-chat', '/character/pending-character/pending-chat'])(
    'does not repair a provisional startup route %s before reader disposition',
    async (path) => {
      for (const phase of ['resolving', 'recovering', 'resuming'] as const) {
        beginAutomaticPreview(phase)
        publishReaderCharacters()
        const router = await createRouterMock()
        router.navigate(path)
        readOnlyWorkspaceMocks.navigate.mockClear()
        await mountWorkspace()
        expect(get(router.currentRoute).path).toBe(path)
        expect(readOnlyWorkspaceMocks.navigate).not.toHaveBeenCalled()
        expect(readOnlyWorkspaceMocks.hydrateCharacterShell).not.toHaveBeenCalled()
        expect(target.querySelector('[data-reader-test-transcript]')).toBeNull()
      }
    },
  )

  it('gates an authoring URL while keeping keyboard-focusable reader navigation and honest connection status', async () => {
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    publishReaderCharacters()
    setClientProjectionReady(true)
    setClientConnectionState('live')
    const router = await createRouterMock()
    router.navigate('/settings/persona')
    await mountWorkspace()
    expect(target.querySelector('[data-reader-authoring-gate]')?.textContent).toBe(
      language.connectedReaders.writeAccessRequired,
    )
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.connected,
    )
    expect(target.querySelector('input:not([type="search"]), textarea, [contenteditable="true"]')).toBeNull()
    await expandReaderHamburger()
    const home = target.querySelector<HTMLButtonElement>('[data-reader-navigation] button[aria-label="Home"]')!
    home.focus()
    expect(document.activeElement).toBe(home)
    home.click()
    await tick()
    expect(get(router.currentRoute).kind).toBe('home')
    expect(target.querySelector('[data-reader-authoring-gate]')).toBeNull()
    setClientConnectionState('interrupted')
    await tick()
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.interrupted,
    )
  })

  beforeEach(async () => {
    await changeLanguage('en')
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
    resetReaderRouteIntentForTests()
    resetReaderWorkspaceLifecycleForTests()
    readOnlyWorkspaceMocks.hydrationState.rows = {}
    readOnlyWorkspaceMocks.hydrateCharacterShell.mockReset().mockResolvedValue(true)
    readOnlyWorkspaceMocks.promoteConnectedReader.mockReset().mockResolvedValue({ status: 'cancelled' })
    readOnlyWorkspaceMocks.navigate.mockClear()
    readOnlyWorkspaceMocks.routerExports?.currentRoute.set({ kind: 'home', path: '/' })
    selectedCharID.set(-1)
    DynamicGUI.set(false)
    seedShellDatabase()
    target = document.createElement('div')
    document.body.appendChild(target)
    await mountWorkspace()
  })

  afterEach(async () => {
    resetClientSessionForTests()
    if (component) {
      unmount(component)
      component = undefined
    }
    await clearPendingMutationOutbox()
    resetPendingMutationOutboxForTests()
    resetReaderRouteIntentForTests()
    resetReaderWorkspaceLifecycleForTests()
    replaceResourceDatabase({} as Database)
    target.remove()
    await changeLanguage('en')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('announces read-only mode and uses keyboard-native navigation controls', () => {
    const status = target.querySelector('[data-reader-access-status]')
    const characterButton = target.querySelector<HTMLButtonElement>('button[aria-label="Open Character A"]')

    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.textContent).toContain(language.connectedReaders.title)
    expect(status?.closest('[data-risu-device-access-action]')).not.toBeNull()
    expect(target.querySelector('header')).toBeNull()
    expect(characterButton?.type).toBe('button')
  })

  it('uses the writer hamburger UI while keeping Settings and Playground unavailable', async () => {
    recordReaderNavigationSettings({ menuSideBar: false, hamburgerButtonBottom: false }, [
      'menuSideBar',
      'hamburgerButtonBottom',
    ])
    await mountWorkspace()

    const characterControls = target.querySelector<HTMLElement>('[data-risu-sidebar-character-controls]')!
    expect(target.querySelector('[data-reader-navigation] button[aria-label="Home"]')).toBeNull()
    const toggle = await expandReaderHamburger()
    const menu = target.querySelector<HTMLElement>('[data-reader-navigation] [data-risu-hamburger-menu]')!
    const settings = menu.querySelector<HTMLButtonElement>('button[aria-label^="Settings:"]')!
    const playground = menu.querySelector<HTMLButtonElement>('button[aria-label^="Playground:"]')!
    const home = menu.querySelector<HTMLButtonElement>('button[aria-label="Home"]')!
    const grid = menu.querySelector<HTMLButtonElement>('button[aria-label="Grid"]')!

    expect(menu).not.toBeNull()
    expect(menu.parentElement?.dataset.risuHamburgerMenuPlacement).toBe('top')
    expect(settings.disabled).toBe(true)
    expect(settings.title).toBe(language.connectedReaders.writeAccessRequired)
    expect(playground.disabled).toBe(true)
    expect(playground.title).toBe(language.connectedReaders.writeAccessRequired)
    expect(home.disabled).toBe(false)
    expect(grid.disabled).toBe(false)
    expect(characterControls.hasAttribute('inert')).toBe(true)

    settings.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    playground.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(get((await createRouterMock()).currentRoute).path).toBe('/')
    expect(fetch).not.toHaveBeenCalled()

    toggle.click()
    await tick()
    expect(characterControls.hasAttribute('inert')).toBe(false)
  })

  it('places the read-only hamburger at the saved bottom position', async () => {
    recordReaderNavigationSettings({ menuSideBar: false, hamburgerButtonBottom: true }, [
      'menuSideBar',
      'hamburgerButtonBottom',
    ])
    await mountWorkspace()

    const anchor = target.querySelector<HTMLElement>('[data-risu-hamburger-menu-anchor]')!
    const toggle = target.querySelector<HTMLElement>('[data-risu-hamburger-menu-toggle]')!
    expect(anchor.dataset.risuHamburgerMenuPlacement).toBe('bottom')
    expect(anchor.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('uses one certified geometry model for wide and responsive reader navigation', async () => {
    recordReaderNavigationSettings({ sideBarSize: 3, desktopSidebarColumns: 4, mobileSidebarColumns: 2 }, [
      'sideBarSize',
      'desktopSidebarColumns',
      'mobileSidebarColumns',
    ])
    await mountWorkspace()

    const wideRail = target.querySelector<HTMLElement>('[data-risu-navigation-rail]')!
    const widePanel = target.querySelector<HTMLElement>('[data-risu-shell-sidebar-panel]')!
    expect(wideRail.dataset.risuNavigationColumns).toBe('4')
    expect(wideRail.style.width).toBe('20rem')
    expect(widePanel.style.width).toBe('36rem')
    expect(widePanel.style.minWidth).toBe('36rem')
    expect(target.querySelector('[data-risu-shell-main]')).not.toBeNull()

    DynamicGUI.set(true)
    await tick()
    target.querySelector<HTMLButtonElement>('[data-reader-navigation-toggle]')!.click()
    await tick()

    const responsiveRail = target.querySelector<HTMLElement>('[data-risu-navigation-rail]')!
    const responsivePanel = target.querySelector<HTMLElement>('[data-risu-shell-sidebar-panel]')!
    expect(responsiveRail.dataset.risuNavigationColumns).toBe('2')
    expect(responsiveRail.style.width).toBe('10rem')
    expect(responsivePanel.style.width).toBe('36rem')
    expect(responsivePanel.style.minWidth).toBe('')
    expect(target.querySelector('[data-risu-responsive-shell="shared-sidebar-dialog"]')).not.toBeNull()
  })

  it('keeps the latest character/chat choice local with no command request or pending record', async () => {
    target.querySelector<HTMLButtonElement>('button[aria-label="Open Character A"]')?.click()
    await tick()
    target.querySelector<HTMLButtonElement>('button[aria-label="Open chat Pinned chat"]')?.click()
    await tick()

    expect(readOnlyWorkspaceMocks.navigate).toHaveBeenNthCalledWith(1, '/character/char-a')
    expect(readOnlyWorkspaceMocks.navigate).toHaveBeenNthCalledWith(2, '/character/char-a/chat-a')
    expect(peekReaderRouteIntent()?.route).toEqual({
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
    expect(target.querySelector('[data-reader-character-summary]')).not.toBeNull()
    expect(target.textContent).toContain('Summary preview')

    readOnlyWorkspaceMocks.hydrateCharacterShell.mockImplementationOnce(async () => {
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

    expect(readOnlyWorkspaceMocks.hydrateCharacterShell).toHaveBeenCalledWith('char-a', { supersede: true })
    expect(target.querySelector('[data-reader-character-summary]')).toBeNull()
    expect(target.textContent).toContain('Read-only details')
    expect(target.querySelector('button[aria-label="Open chat Detailed chat"]')).not.toBeNull()
    expect(await countPendingMutationRecords()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [
      'en',
      'Use this device',
      'Move write access to this device. The other device will keep receiving updates in read-only mode.',
    ],
    [
      'ko',
      '이 기기 사용하기',
      '쓰기 권한을 이 기기로 옮깁니다. 다른 기기는 읽기 전용으로 변경 사항을 계속 받아볼 수 있습니다.',
    ],
  ])('localizes the explicit switch and its effect in %s', async (code, label, help) => {
    await changeLanguage(code)
    await showConnectedReaderChat()
    await mountWorkspace()
    const button = useThisDeviceButton()
    expect(button.textContent?.trim()).toBe(label)
    expect(button.type).toBe('button')
    expect(button.disabled).toBe(false)
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent?.trim()).toBe(help)
    expect(target.querySelector('[data-reader-access-status]')?.getAttribute('aria-live')).toBe('polite')

    button.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
        language.connectedReaders.switchCancelled,
      ),
    )
  })

  it('calls promotion once and keeps only local Back navigation available through recovery', async () => {
    await showConnectedReaderChat()
    const pending = deferredPromotion()
    let operation: ReturnType<typeof beginClientPromotion>
    readOnlyWorkspaceMocks.promoteConnectedReader.mockImplementationOnce(() => {
      operation = beginClientPromotion()
      return pending.promise
    })
    const { promoteConnectedReader } = await import('../ts/bootstrap')
    const button = useThisDeviceButton()
    expect(target.querySelectorAll('[data-reader-use-this-device]')).toHaveLength(1)
    expect(button.closest('[data-risu-device-access-action]')).not.toBeNull()
    const transcript = target.querySelector('[data-reader-test-transcript]')
    button.click()
    button.click()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(promoteConnectedReader).toHaveBeenCalledOnce())
    await tick()

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent?.trim()).toBe(language.connectedReaders.switchingDevice)
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.switching,
    )
    expect(target.querySelector('[data-reader-test-transcript]')).toBe(transcript)
    expect(transcript?.closest('[inert], [aria-disabled="true"]')).toBeNull()
    expect(getClientSessionSnapshot().lifecycle).toBe('promoting')

    expect(target.querySelector('button[aria-label="Open chat Second reader chat"]')).toBeNull()
    const back = target.querySelector<HTMLButtonElement>('[data-reader-go-back]')!
    expect(back.disabled).toBe(false)
    expect(back.closest('[inert]')).toBeNull()
    expect(
      authorizeClientWriterRecovery(operation!, {
        databaseLineage: 'database-a',
        writer: { sessionId: 'reader-a', epoch: 2 },
      }),
    ).toBe(true)
    await tick()
    expect(getClientSessionSnapshot().lifecycle).toBe('recovering-writer')
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.switching,
    )
    expect(useThisDeviceButton().disabled).toBe(true)
    expect(target.querySelector('[data-reader-test-transcript]')?.getAttribute('data-chat-id')).toBe('chat-a')
    expect(get(selectedCharID)).toBe(-1)
    expect(await countPendingMutationRecords()).toBe(0)

    expect(completeClientWriterRecovery(operation!)).toBe(true)
    pending.resolve({ status: 'promoted' })
    await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'))
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    expect(target.querySelector('[data-reader-writer-switch-result]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('makes Back the only interactive sidebar control on a reader chat route', async () => {
    await showConnectedReaderChat()
    const navigation = target.querySelector<HTMLElement>('[data-reader-navigation]')!
    const interactive = [
      ...navigation.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'),
    ]

    expect(interactive).toHaveLength(1)
    expect(interactive[0].matches('[data-reader-go-back]')).toBe(true)
    expect(interactive[0].closest('[inert]')).toBeNull()
    interactive[0].click()
    await tick()
    expect(get((await createRouterMock()).currentRoute)).toMatchObject({ kind: 'character', chaId: 'char-a' })
  })

  it.each([
    [{ status: 'cancelled' }, 'switchCancelled'],
    [{ status: 'superseded' }, 'switchSuperseded'],
    [{ status: 'failed', reason: 'retained-work' }, 'switchRetainedWork'],
    [{ status: 'failed', reason: 'unavailable' }, 'switchUnavailable'],
    [{ status: 'failed', reason: 'interrupted' }, 'switchInterrupted'],
  ] as const)('leaves reading and an explicit retry available after %j', async (result, messageKey) => {
    await showConnectedReaderChat()
    const pending = deferredPromotion()
    let operation: ReturnType<typeof beginClientPromotion>
    readOnlyWorkspaceMocks.promoteConnectedReader.mockImplementationOnce(() => {
      operation = beginClientPromotion()
      return pending.promise
    })
    const transcript = target.querySelector('[data-reader-test-transcript]')
    const button = useThisDeviceButton()
    button.focus()
    button.click()
    await vi.waitFor(() => expect(readOnlyWorkspaceMocks.promoteConnectedReader).toHaveBeenCalledOnce())
    if (result.status === 'superseded') observeClientWriter({ sessionId: 'writer-c', epoch: 3 })
    else failClientSessionOperation(operation!)
    pending.resolve(result)
    await vi.waitFor(() => expect(button.disabled).toBe(false))

    expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
      language.connectedReaders[messageKey],
    )
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.connected,
    )
    expect(target.querySelector('[data-reader-test-transcript]')).toBe(transcript)
    expect(transcript?.closest('[inert], [aria-disabled="true"]')).toBeNull()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    expect(document.activeElement).toBe(button)
    expect(button.textContent?.trim()).toBe(language.connectedReaders.useThisDevice)
    expect(readOnlyWorkspaceMocks.promoteConnectedReader).toHaveBeenCalledOnce()

    const back = target.querySelector<HTMLButtonElement>('[data-reader-go-back]')!
    back.click()
    await tick()
    await expandReaderHamburger()
    const home = target.querySelector<HTMLButtonElement>('button[aria-label="Home"]')!
    home.click()
    await tick()
    expect(get((await createRouterMock()).currentRoute).kind).toBe('home')
    button.click()
    await vi.waitFor(() => expect(readOnlyWorkspaceMocks.promoteConnectedReader).toHaveBeenCalledTimes(2))
    expect(await countPendingMutationRecords()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('blocks switching during interruption and keeps reader focus when an operation settles', async () => {
    await showConnectedReaderChat()
    const button = useThisDeviceButton()
    setClientConnectionState('interrupted')
    await tick()
    button.click()
    expect(button.disabled).toBe(true)
    expect(readOnlyWorkspaceMocks.promoteConnectedReader).not.toHaveBeenCalled()
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()

    setClientConnectionState('live')
    await tick()
    const pending = deferredPromotion()
    readOnlyWorkspaceMocks.promoteConnectedReader.mockImplementationOnce(() => {
      beginClientPromotion()
      return pending.promise
    })
    button.click()
    await vi.waitFor(() => expect(readOnlyWorkspaceMocks.promoteConnectedReader).toHaveBeenCalledOnce())
    const home = target.querySelector<HTMLButtonElement>('nav button')!
    home.focus()
    setClientConnectionState('interrupted')
    pending.resolve({ status: 'failed', reason: 'interrupted' })
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
        language.connectedReaders.switchInterrupted,
      ),
    )
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.interrupted,
    )
    expect(button.disabled).toBe(true)
    expect(document.activeElement).toBe(home)
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
    setClientConnectionState('live')
    await tick()
    expect(button.disabled).toBe(false)
    expect(readOnlyWorkspaceMocks.promoteConnectedReader).toHaveBeenCalledOnce()
  })

  it('keeps a failed operation import or request readable without exposing protocol errors', async () => {
    await showConnectedReaderChat()
    readOnlyWorkspaceMocks.promoteConnectedReader.mockRejectedValueOnce(new Error('private_protocol_failure'))
    useThisDeviceButton().click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
        language.connectedReaders.switchUnavailable,
      ),
    )
    expect(target.textContent).not.toContain('private_protocol_failure')
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
    expect(useThisDeviceButton().disabled).toBe(false)
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
  })

  it('does not announce active switching for an interrupted former writer or start a second recovery', async () => {
    await showConnectedReaderChat()
    const operation = beginClientPromotion()!
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'database-a',
      writer: { sessionId: 'reader-a', epoch: 2 },
    })
    completeClientWriterRecovery(operation)
    setClientConnectionState('interrupted')
    await tick()
    const button = useThisDeviceButton()

    expect(getClientSessionSnapshot().lifecycle).toBe('recovering-writer')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('false')
    expect(button.textContent?.trim()).toBe(language.connectedReaders.useThisDevice)
    expect(target.querySelector('[data-reader-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.interrupted,
    )
    button.click()
    expect(readOnlyWorkspaceMocks.promoteConnectedReader).not.toHaveBeenCalled()
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
  })

  it('preserves reader navigation focus when a live switch fails', async () => {
    await showConnectedReaderChat()
    const pending = deferredPromotion()
    readOnlyWorkspaceMocks.promoteConnectedReader.mockReturnValueOnce(pending.promise)
    useThisDeviceButton().click()
    await vi.waitFor(() => expect(readOnlyWorkspaceMocks.promoteConnectedReader).toHaveBeenCalledOnce())
    const home = target.querySelector<HTMLButtonElement>('nav button')!
    home.focus()
    pending.resolve({ status: 'failed', reason: 'unavailable' })
    await vi.waitFor(() => expect(useThisDeviceButton().disabled).toBe(false))

    expect(document.activeElement).toBe(home)
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
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
    publishReaderCharacters()
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
    publishReaderCharacters()
    setClientProjectionReady(true)
    const router = await createRouterMock()
    router.navigate('/character/char-a/chat-a')
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]'), target.innerHTML).not.toBeNull(),
    )
    const deletedChat = JSON.parse(JSON.stringify(charactersResourceState.characters[0])) as character
    deletedChat.chats.splice(0, 1)
    applyCharacterResource({ revision: 2, character: deletedChat })
    await vi.waitFor(() => expect(get(router.currentRoute).path).toBe('/character/char-a/chat-b'))
    await tick()
    expect(readOnlyWorkspaceMocks.navigate).toHaveBeenLastCalledWith('/character/char-a/chat-b', { replace: true })
    expect(target.querySelector('[data-reader-route-notice]')?.textContent).toBe(
      language.connectedReaders.chatUnavailable,
    )
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 3,
      characters: [],
      characterOrder: [],
      currentChar: -1,
    })
    await vi.waitFor(() => expect(get(router.currentRoute).path).toBe('/'))
    await tick()
    expect(readOnlyWorkspaceMocks.navigate).toHaveBeenLastCalledWith('/', { replace: true })
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
    publishReaderCharacters()
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
    publishReaderCharacters()
    await tick()
    expect(target.querySelector('[data-reader-ambiguous-target]')?.textContent).toBe(
      language.connectedReaders.ambiguousConversation,
    )
    expect(target.querySelector('[data-reader-test-transcript]')).toBeNull()
    expect(get(router.currentRoute).path).toBe('/character/char-a/chat-a')
  })
  it('retains reader membership and labels while the former writer has optimistic edits or deletion', async () => {
    await showConnectedReaderChat()
    withTestDatabaseWrite(() => {
      charactersResourceState.characters[0].displayName = 'Pending character name'
      charactersResourceState.characters[0].chats[0].name = 'Pending chat name'
      charactersResourceState.characters[0].chats.splice(0, 1)
    })
    await tick()
    const router = await createRouterMock()
    expect(get(router.currentRoute).path).toBe('/character/char-a/chat-a')
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
    expect(target.textContent).not.toContain('Pending character name')
    expect(target.textContent).not.toContain('Pending chat name')
  })
  it('shares committed folders, pins, search and cards while retaining independent reader selection', async () => {
    const first = makeDetailedCharacter()
    first.chatFolders = [{ id: 'chat-folder', name: 'Stories', color: 'blue', folded: true }]
    first.chats[0].folderId = 'chat-folder'
    first.chats[0].pinned = true
    const second = {
      ...makeDetailedCharacter(),
      chaId: 'char-b',
      name: 'Character B',
      displayName: 'Character B',
      chats: [{ ...first.chats[0], id: 'chat-b', name: 'Other conversation', folderId: undefined, pinned: false }],
    }
    const order = [{ id: 'character-folder', name: 'Favorites', color: 'green', data: ['char-b', 'char-a'] }]
    replaceResourceDatabase({
      characters: [first, second],
      characterOrder: order,
      currentChar: 1,
    } as unknown as Database)
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'database-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision: 3,
      characters: [first, second] as never,
      characterOrder: order,
      currentChar: 1,
    })
    setClientProjectionReady(true)
    setClientConnectionState('live')
    const router = await createRouterMock()
    router.navigate('/character/char-a')
    await tick()
    const folder = target.querySelector<HTMLButtonElement>('[data-reader-character-folder] button')!
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    folder.click()
    await tick()
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    expect(
      Array.from(target.querySelectorAll('[data-reader-character]')).map((row) =>
        row.getAttribute('data-reader-character'),
      ),
    ).toEqual(['char-b', 'char-a'])
    expect(target.querySelector('[data-risu-pinned-chat="chat-a"]')).not.toBeNull()
    const chatFolder = target.querySelector<HTMLButtonElement>('[data-risu-chat-folder-id="chat-folder"] button')!
    chatFolder.click()
    await tick()
    expect(chatFolder.getAttribute('aria-expanded')).toBe('true')
    expect(charactersResourceState.characters[0].chatFolders[0].folded).toBe(true)
    const search = target.querySelector<HTMLInputElement>('input[aria-label="Search: Character"]')!
    search.value = 'Character B'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(target.querySelector('[data-reader-character="char-a"]')).toBeNull()
    setClientConnectionState('interrupted')
    setClientConnectionState('live')
    await tick()
    expect(search.value).toBe('Character B')
    expect(chatFolder.getAttribute('aria-expanded')).toBe('true')
    await expandReaderHamburger()
    target.querySelector<HTMLButtonElement>('[data-reader-navigation] button[aria-label="Home"]')!.click()
    await tick()
    expect(target.querySelectorAll('[data-risu-grid-character-row]')).toHaveLength(2)
    await expandReaderHamburger()
    const settings = target.querySelector<HTMLButtonElement>('button[aria-label^="Settings:"]')!
    expect(settings.disabled).toBe(true)
    settings.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(get(router.currentRoute).path).toBe('/')
    expect(charactersResourceState.currentChar).toBe(1)
    expect(await countPendingMutationRecords()).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains the latest valid reading route through direct restricted URLs and clears it on authentication loss', async () => {
    await showConnectedReaderChat()
    const router = await createRouterMock()
    router.navigate('/character/char-a/chat-b')
    await tick()
    router.navigate('/settings/persona')
    await tick()
    expect(peekReaderRouteIntent()?.route.path).toBe('/character/char-a/chat-b')
    const back = target.querySelector<HTMLButtonElement>('[data-reader-return-to-reading]')!
    expect(back).not.toBeNull()
    back.click()
    await tick()
    expect(get(router.currentRoute).path).toBe('/character/char-a/chat-b')
    router.navigate('/settings/persona')
    await tick()
    await expandReaderHamburger()
    const staleHome = target.querySelector<HTMLButtonElement>('[data-reader-navigation] button[aria-label="Home"]')!
    requireClientAuthentication()
    staleHome.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    expect(get(router.currentRoute).path).toBe('/settings/persona')
    expect(target.querySelector('[data-reader-return-to-reading]')).toBeNull()
    expect(target.querySelector('[data-reader-test-transcript]')).toBeNull()
    expect(await countPendingMutationRecords()).toBe(0)
  })

  it('opens one focus-trapped mobile navigation drawer and restores focus when Escape closes it', async () => {
    await showConnectedReaderChat()
    DynamicGUI.set(true)
    await mountWorkspace()
    const toggle = target.querySelector<HTMLButtonElement>('[data-reader-navigation-toggle]')!
    const drawer = target.querySelector<HTMLElement>('#reader-navigation')!
    expect(drawer.hidden).toBe(true)
    toggle.focus()
    toggle.click()
    await tick()
    expect(drawer.hidden).toBe(false)
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(drawer.contains(document.activeElement)).toBe(true)
    expect(target.querySelector<HTMLElement>('[data-risu-shell-main]')?.inert).toBe(true)
    expect(target.querySelector('[data-risu-shell-main]')?.getAttribute('aria-hidden')).toBe('true')
    expect(target.querySelectorAll('[data-reader-navigation]')).toHaveLength(1)
    drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    expect(drawer.hidden).toBe(true)
    expect(target.querySelector<HTMLElement>('[data-risu-shell-main]')?.inert).toBe(false)
    expect(target.querySelector('#reader-navigation')).toBe(drawer)
    expect(document.activeElement).toBe(toggle)
    expect(get((await createRouterMock()).currentRoute).path).toBe('/character/char-a/chat-a')
    expect(await countPendingMutationRecords()).toBe(0)
  })
})
