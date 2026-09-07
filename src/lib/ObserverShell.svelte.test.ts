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
} from '../ts/clientSession'
import { changeLanguage, language } from '../lang'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppRoute } from '../ts/routerRoute'
import type { Database, character } from '../ts/storage/database.svelte'
import type { ConnectedWriterPromotionResult } from '../ts/bootstrap'

const observerShellMocks = vi.hoisted(() => ({
  hydrateCharacterShell: vi.fn(async () => true),
  hydrationState: { rows: {} as Record<string, { status: string; error: string | null }> },
  navigate: vi.fn(),
  retryObserverWriterPromotion: vi.fn(async () => false),
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
  promoteConnectedReader: observerShellMocks.promoteConnectedReader,
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

describe('pre-writer ObserverShell', () => {
  it.each(['resolving', 'recovering', 'resuming'] as const)(
    'keeps the automatic %s shell visible without detail or transcript work',
    async (phase) => {
      const operation = beginAutomaticPreview(phase)
      publishReaderCharacters()
      const router = await createRouterMock()
      router.navigate('/character/char-a/chat-a')
      await mountObserverShell()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await tick()
      expect(target.querySelector('[data-observer-shell]')).not.toBeNull()
      expect(target.textContent).toContain('Character A')
      expect(observerShellMocks.hydrateCharacterShell).not.toHaveBeenCalled()
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
        observerShellMocks.navigate.mockClear()
        await mountObserverShell()
        expect(get(router.currentRoute).path).toBe(path)
        expect(observerShellMocks.navigate).not.toHaveBeenCalled()
        expect(observerShellMocks.hydrateCharacterShell).not.toHaveBeenCalled()
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
    resetObserverRouteIntentForTests()
    resetObserverShellLifecycleForTests()
    observerShellMocks.hydrationState.rows = {}
    observerShellMocks.hydrateCharacterShell.mockReset().mockResolvedValue(true)
    observerShellMocks.retryObserverWriterPromotion.mockReset().mockResolvedValue(false)
    observerShellMocks.promoteConnectedReader.mockReset().mockResolvedValue({ status: 'cancelled' })
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
    await changeLanguage('en')
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
    expect(target.querySelector('[data-reader-use-this-device]')).toBeNull()
    expect(observerShellMocks.promoteConnectedReader).not.toHaveBeenCalled()
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
    await mountObserverShell()
    setObserverShellLifecycleMode('retrying')
    await tick()

    const button = useThisDeviceButton()
    expect(button.textContent?.trim()).toBe(label)
    expect(button.type).toBe('button')
    expect(button.disabled).toBe(false)
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent?.trim()).toBe(help)
    expect(target.querySelector('[data-observer-writer-retry]')).toBeNull()
    expect(target.querySelector('[data-observer-read-only-status]')?.getAttribute('aria-live')).toBe('polite')

    button.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
        language.connectedReaders.switchCancelled,
      ),
    )
  })

  it('calls the exported promotion operation once and keeps reader navigation available through writer recovery', async () => {
    await showConnectedReaderChat()
    const pending = deferredPromotion()
    let operation: ReturnType<typeof beginClientPromotion>
    observerShellMocks.promoteConnectedReader.mockImplementationOnce(() => {
      operation = beginClientPromotion()
      return pending.promise
    })
    const { promoteConnectedReader } = await import('../ts/bootstrap')
    const button = useThisDeviceButton()
    const transcript = target.querySelector('[data-reader-test-transcript]')
    button.click()
    button.click()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(promoteConnectedReader).toHaveBeenCalledOnce())
    await tick()

    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.textContent?.trim()).toBe(language.connectedReaders.switchingDevice)
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.switching,
    )
    expect(target.querySelector('[data-reader-test-transcript]')).toBe(transcript)
    expect(transcript?.closest('[inert], [aria-disabled="true"]')).toBeNull()
    expect(getClientSessionSnapshot().lifecycle).toBe('promoting')

    const secondChat = target.querySelector<HTMLButtonElement>('button[aria-label="Open chat Second reader chat"]')!
    expect(secondChat.disabled).toBe(false)
    secondChat.focus()
    secondChat.click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-test-transcript]')?.getAttribute('data-chat-id')).toBe('chat-b'),
    )
    expect(
      authorizeClientWriterRecovery(operation!, {
        databaseLineage: 'database-a',
        writer: { sessionId: 'reader-a', epoch: 2 },
      }),
    ).toBe(true)
    await tick()
    expect(getClientSessionSnapshot().lifecycle).toBe('recovering-writer')
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.switching,
    )
    expect(useThisDeviceButton().disabled).toBe(true)
    expect(target.querySelector('[data-reader-test-transcript]')?.getAttribute('data-chat-id')).toBe('chat-b')
    expect(get(selectedCharID)).toBe(-1)
    expect(await countPendingMutationRecords()).toBe(0)

    expect(completeClientWriterRecovery(operation!)).toBe(true)
    pending.resolve({ status: 'promoted' })
    await vi.waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'))
    expect(getClientSessionSnapshot().lifecycle).toBe('writing')
    expect(target.querySelector('[data-reader-writer-switch-result]')).toBeNull()
    expect(observerShellMocks.retryObserverWriterPromotion).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
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
    observerShellMocks.promoteConnectedReader.mockImplementationOnce(() => {
      operation = beginClientPromotion()
      return pending.promise
    })
    const transcript = target.querySelector('[data-reader-test-transcript]')
    const button = useThisDeviceButton()
    button.focus()
    button.click()
    await vi.waitFor(() => expect(observerShellMocks.promoteConnectedReader).toHaveBeenCalledOnce())
    if (result.status === 'superseded') observeClientWriter({ sessionId: 'writer-c', epoch: 3 })
    else failClientSessionOperation(operation!)
    pending.resolve(result)
    await vi.waitFor(() => expect(button.disabled).toBe(false))

    expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
      language.connectedReaders[messageKey],
    )
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.connected,
    )
    expect(target.querySelector('[data-reader-test-transcript]')).toBe(transcript)
    expect(transcript?.closest('[inert], [aria-disabled="true"]')).toBeNull()
    expect(getClientSessionSnapshot().lifecycle).toBe('reading')
    expect(document.activeElement).toBe(button)
    expect(button.textContent?.trim()).toBe(language.connectedReaders.useThisDevice)
    expect(observerShellMocks.promoteConnectedReader).toHaveBeenCalledOnce()

    const home = target.querySelector<HTMLButtonElement>('nav button')!
    home.click()
    await tick()
    expect(get((await createRouterMock()).currentRoute).kind).toBe('home')
    button.click()
    await vi.waitFor(() => expect(observerShellMocks.promoteConnectedReader).toHaveBeenCalledTimes(2))
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
    expect(observerShellMocks.promoteConnectedReader).not.toHaveBeenCalled()
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()

    setClientConnectionState('live')
    await tick()
    const pending = deferredPromotion()
    observerShellMocks.promoteConnectedReader.mockImplementationOnce(() => {
      beginClientPromotion()
      return pending.promise
    })
    button.click()
    await vi.waitFor(() => expect(observerShellMocks.promoteConnectedReader).toHaveBeenCalledOnce())
    const home = target.querySelector<HTMLButtonElement>('nav button')!
    home.focus()
    setClientConnectionState('interrupted')
    pending.resolve({ status: 'failed', reason: 'interrupted' })
    await vi.waitFor(() =>
      expect(target.querySelector('[data-reader-writer-switch-result]')?.textContent?.trim()).toBe(
        language.connectedReaders.switchInterrupted,
      ),
    )
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.interrupted,
    )
    expect(button.disabled).toBe(true)
    expect(document.activeElement).toBe(home)
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
    setClientConnectionState('live')
    await tick()
    expect(button.disabled).toBe(false)
    expect(observerShellMocks.promoteConnectedReader).toHaveBeenCalledOnce()
  })

  it('keeps a failed operation import or request readable without exposing protocol errors', async () => {
    await showConnectedReaderChat()
    observerShellMocks.promoteConnectedReader.mockRejectedValueOnce(new Error('private_protocol_failure'))
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
    expect(target.querySelector('[data-observer-lifecycle-status]')?.textContent).toBe(
      language.connectedReaders.interrupted,
    )
    button.click()
    expect(observerShellMocks.promoteConnectedReader).not.toHaveBeenCalled()
    expect(target.querySelector('[data-reader-test-transcript]')).not.toBeNull()
  })

  it('preserves reader navigation focus when a live switch fails', async () => {
    await showConnectedReaderChat()
    const pending = deferredPromotion()
    observerShellMocks.promoteConnectedReader.mockReturnValueOnce(pending.promise)
    useThisDeviceButton().click()
    await vi.waitFor(() => expect(observerShellMocks.promoteConnectedReader).toHaveBeenCalledOnce())
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
    expect(observerShellMocks.navigate).toHaveBeenLastCalledWith('/character/char-a/chat-b', { replace: true })
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
})
