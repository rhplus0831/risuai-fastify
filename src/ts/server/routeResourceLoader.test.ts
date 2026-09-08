import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { beginClientSession, demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import type { ResourceRequirement } from './resourceManifest'

const loaderMocks = vi.hoisted(() => ({
  activeChat: vi.fn(async () => true),
  routeChat: vi.fn(async () => true),
  prompt: vi.fn(async () => true),
  promptOwner: vi.fn((): string | null => null),
  refresh: vi.fn(),
  requirements: [] as ResourceRequirement[],
  standalone: vi.fn(),
}))

vi.mock('./resourceManifest', () => ({
  RESOURCE_SURFACE_MANIFEST: { test: { requirements: [] } },
  resourceSurfacesForRoute: (route: { path: string }) => ['shared:app-shell', `test:${route.path}`],
  resolveResourceRequirements: () => loaderMocks.requirements,
  resourceRequirementIdentity: (requirement: ResourceRequirement) => {
    switch (requirement.kind) {
      case 'settings-group':
        return `settings-group:${requirement.group}`
      case 'collection':
        return `collection:${requirement.collection}`
      case 'standalone-setting':
        return `standalone-setting:${requirement.setting}`
      case 'projection':
        return `projection:${requirement.projection}`
    }
  },
}))

vi.mock('./resourceInvalidation', () => ({
  refreshServerResourceTargets: loaderMocks.refresh,
}))

vi.mock('./resourceReads', () => ({
  fetchServerStandaloneSetting: loaderMocks.standalone,
}))

vi.mock('./characterShellHydration.svelte', () => ({
  hydrateCharacterShell: async (
    characterId: string,
    options: { signal: AbortSignal | null; minimumRevision?: number },
  ) => {
    const result = await loaderMocks.refresh(
      { characterIds: [characterId], minimumRevision: options.minimumRevision },
      { signal: options.signal },
    )
    return result.status === 'ok'
  },
}))

vi.mock('./chatMessageHydration.svelte', () => ({
  hydrateActiveChat: loaderMocks.activeChat,
  hydrateChatMessageWindow: loaderMocks.routeChat,
}))

vi.mock('./promptTemplateHydration', () => ({
  currentPromptTemplateOwnerId: loaderMocks.promptOwner,
  ensurePromptTemplateHydrated: loaderMocks.prompt,
}))

import { clearAppliedServerResourceRevision, setAppliedServerResourceRevision } from './commands'
import {
  currentRouteResourceLoadState,
  ensureResourceSurfaces,
  failActiveRouteLoad,
  finishRouteResources,
  prefetchCharacterRouteResource,
  prefetchRoutePathResources,
  prepareRouteResources,
  routeResourceLoadState,
  startLikelyCharacterRouteWarmup,
  stopRouteResourceLoader,
} from './routeResourceLoader'
import {
  applyCharactersResource,
  applySettingsGroupResource,
  resetServerResourceState,
  settingsResourceState,
} from './resourceState.svelte'

import { lorebookPageOwner } from './lorebookPageOwner.svelte'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

function requirement<T extends ResourceRequirement>(value: T): T {
  return value
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetClientSessionForTests()
  stopRouteResourceLoader()
  lorebookPageOwner.reset()
  withTestDatabaseWrite(resetServerResourceState)
  clearAppliedServerResourceRevision()
  setAppliedServerResourceRevision(4)
  loaderMocks.requirements = []
  loaderMocks.refresh.mockReset().mockResolvedValue({ status: 'ok', revision: 5, scope: 'targeted' })
  loaderMocks.standalone.mockReset().mockResolvedValue({
    status: 'ok',
    revision: 5,
    setting: 'selectedPersona',
    state: { present: true, value: 0 },
  })
  loaderMocks.activeChat.mockReset().mockResolvedValue(true)
  loaderMocks.routeChat.mockReset().mockResolvedValue(true)
  loaderMocks.prompt.mockReset().mockResolvedValue(true)
  loaderMocks.promptOwner.mockReset().mockReturnValue(null)
})

afterEach(() => {
  stopRouteResourceLoader()
  clearAppliedServerResourceRevision()
  Reflect.deleteProperty(window, 'requestIdleCallback')
  Reflect.deleteProperty(window, 'cancelIdleCallback')
})

describe('route resource loader', () => {
  it('hydrates the lorebook page owner from the route read without a duplicate request', async () => {
    loaderMocks.requirements = [
      requirement({ kind: 'standalone-setting', setting: 'loreBookPage', purposes: ['render', 'mutate'] }),
    ]
    loaderMocks.standalone.mockResolvedValue({
      status: 'ok',
      revision: 5,
      setting: 'loreBookPage',
      state: { present: true, value: 2 },
    })
    const route = {
      kind: 'settings',
      path: '/settings/global-lorebook',
      section: 'global-lorebook',
      index: 8,
    } as const

    await expect(prepareRouteResources(route)).resolves.toBe(true)

    expect(loaderMocks.standalone).toHaveBeenCalledTimes(1)
    expect(lorebookPageOwner.snapshot()).toMatchObject({
      status: 'ready',
      revision: 5,
      state: { present: true, value: 2 },
    })
  })

  it('loads granular declarations with the request-start revision', async () => {
    loaderMocks.requirements = [
      requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] }),
      requirement({ kind: 'collection', collection: 'personas', purposes: ['render'] }),
      requirement({ kind: 'standalone-setting', setting: 'selectedPersona', purposes: ['render'] }),
      requirement({ kind: 'projection', projection: 'selected-character', purposes: ['render'] }),
    ]
    const route = { kind: 'character', path: '/character/char-a', chaId: 'char-a' } as const

    await expect(prepareRouteResources(route)).resolves.toBe(true)
    await expect(finishRouteResources(route)).resolves.toBe(true)

    expect(loaderMocks.refresh).toHaveBeenCalledTimes(3)
    expect(loaderMocks.refresh.mock.calls.map(([target]) => target)).toEqual(
      expect.arrayContaining([
        { settingsGroups: ['display'], minimumRevision: 4 },
        { collections: ['personas'], minimumRevision: 4 },
        { characterIds: ['char-a'], minimumRevision: 4 },
      ]),
    )
    expect(getResourceDatabase().selectedPersona).toBe(0)
    expect(get(routeResourceLoadState)).toEqual({
      error: null,
      routeKey: 'character:char-a:',
      status: 'ready',
    })
  })

  it('aborts an older route and drops its terminal state', async () => {
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] })]
    const secondRead = deferred<{ status: 'ok'; revision: number; scope: 'targeted' }>()
    loaderMocks.refresh
      .mockImplementationOnce(async (_target, options: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { status: 'error', error: 'aborted' }
      })
      .mockImplementationOnce(() => secondRead.promise)

    const first = prepareRouteResources({ kind: 'home', path: '/' })
    const secondRoute = { kind: 'grid', path: '/grid' } as const
    const second = prepareRouteResources(secondRoute)
    secondRead.resolve({ status: 'ok', revision: 5, scope: 'targeted' })

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
    await expect(finishRouteResources(secondRoute)).resolves.toBe(true)
    expect(currentRouteResourceLoadState()).toMatchObject({ routeKey: 'grid', status: 'ready' })
  })

  it('keeps a resource failure local and permits a clean retry', async () => {
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] })]
    loaderMocks.refresh
      .mockResolvedValueOnce({ status: 'error', error: 'display unavailable' })
      .mockResolvedValueOnce({ status: 'ok', revision: 6, scope: 'targeted' })
    const route = { kind: 'settings', path: '/settings/display', section: 'display', index: 3 } as const

    await expect(prepareRouteResources(route)).resolves.toBe(false)
    expect(currentRouteResourceLoadState()).toMatchObject({ status: 'error', error: 'display unavailable' })
    expect(settingsResourceState.groupErrors.display).toBe('display unavailable')

    await expect(prepareRouteResources(route)).resolves.toBe(true)
    await expect(finishRouteResources(route)).resolves.toBe(true)
    expect(currentRouteResourceLoadState()).toMatchObject({ status: 'ready', error: null })
    expect(settingsResourceState.groupErrors.display).toBeUndefined()
  })

  it('reuses a ready resident route requirement on later navigation', async () => {
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] })]
    loaderMocks.refresh.mockImplementationOnce(async () => {
      withTestDatabaseWrite(() =>
        applySettingsGroupResource({ revision: 5, group: 'display', settings: { theme: 'dark' } }, ['theme']),
      )
      return { status: 'ok', revision: 5, scope: 'targeted' as const }
    })
    const route = { kind: 'settings', path: '/settings/display', section: 'display', index: 3 } as const

    await expect(prepareRouteResources(route)).resolves.toBe(true)
    await expect(finishRouteResources(route)).resolves.toBe(true)
    await expect(prepareRouteResources(route)).resolves.toBe(true)
    await expect(finishRouteResources(route)).resolves.toBe(true)

    expect(loaderMocks.refresh).toHaveBeenCalledOnce()
  })

  it('accepts a component failure only from the active route transition', async () => {
    const route = { kind: 'grid', path: '/grid' } as const
    await expect(prepareRouteResources(route)).resolves.toBe(true)

    expect(failActiveRouteLoad({ kind: 'home', path: '/' }, new Error('stale'))).toBe(false)
    expect(failActiveRouteLoad(route, new Error('missing route chunk'))).toBe(true)
    expect(currentRouteResourceLoadState()).toEqual({
      error: 'missing route chunk',
      errorKind: 'component',
      offline: false,
      routeKey: 'grid',
      status: 'error',
    })
  })

  it('deduplicates concurrent deferred consumers per surface', async () => {
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'providers', purposes: ['interact'] })]
    const read = deferred<{ status: 'ok'; revision: number; scope: 'targeted' }>()
    loaderMocks.refresh.mockReturnValue(read.promise)

    const first = ensureResourceSurfaces(['runtime:plugins'])
    const second = ensureResourceSurfaces(['runtime:plugins'])
    expect(first).toBe(second)
    expect(loaderMocks.refresh).toHaveBeenCalledOnce()

    read.resolve({ status: 'ok', revision: 5, scope: 'targeted' })
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })

  it('lets a deferred consumer join a route-owned request for the same resource', async () => {
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] })]
    const read = deferred<{ status: 'ok'; revision: number; scope: 'targeted' }>()
    loaderMocks.refresh.mockReturnValue(read.promise)
    const route = { kind: 'home', path: '/' } as const

    const routeLoad = prepareRouteResources(route)
    const deferredLoad = ensureResourceSurfaces(['runtime:background-effects'])
    expect(loaderMocks.refresh).toHaveBeenCalledOnce()

    read.resolve({ status: 'ok', revision: 5, scope: 'targeted' })
    await expect(routeLoad).resolves.toBe(true)
    await expect(deferredLoad).resolves.toBeUndefined()
    await expect(finishRouteResources(route)).resolves.toBe(true)
  })

  it('hydrates a chat-owned prompt template without replacing the global compatibility owner', async () => {
    loaderMocks.requirements = []
    loaderMocks.promptOwner.mockReturnValue('prompt-a')
    withTestDatabaseWrite(() =>
      applyCharactersResource({
        version: 1,
        revision: 4,
        characters: [
          {
            chaId: 'char-a',
            type: 'character',
            name: 'Ada',
            chats: [
              {
                id: 'chat-b',
                name: 'Chat B',
                message: [],
                generationSettings: { promptPresetId: 'prompt-b' },
              },
            ],
            chatPage: 0,
            chatFolders: [],
          } as never,
        ],
        characterOrder: ['char-a'],
        currentChar: 0,
      }),
    )
    const route = { kind: 'character', path: '/character/char-a/chat-b', chaId: 'char-a', chatId: 'chat-b' } as const

    const chatRead = deferred<boolean>()
    const promptRead = deferred<boolean>()
    loaderMocks.routeChat.mockReturnValueOnce(chatRead.promise)
    loaderMocks.prompt.mockReturnValueOnce(promptRead.promise)
    const preparing = prepareRouteResources(route)
    // Both requests must start before either body has finished loading.
    await vi.waitFor(() => expect(loaderMocks.routeChat).toHaveBeenCalledOnce())
    expect(loaderMocks.prompt).toHaveBeenCalledOnce()
    promptRead.resolve(true)
    await Promise.resolve()
    expect(currentRouteResourceLoadState().status).toBe('loading')
    chatRead.resolve(true)
    await expect(preparing).resolves.toBe(true)
    await expect(finishRouteResources(route)).resolves.toBe(true)
    expect(loaderMocks.routeChat).toHaveBeenCalledWith('chat-b', expect.any(Number))
    expect(loaderMocks.prompt).toHaveBeenCalledWith({
      applyProjection: false,
      minimumRevision: 4,
      promptPresetId: 'prompt-b',
    })
  })

  it('prefetches only one hovered shell row during idle time', async () => {
    loaderMocks.requirements = []
    const route = { kind: 'grid', path: '/grid' } as const
    await prepareRouteResources(route)
    await finishRouteResources(route)
    withTestDatabaseWrite(() =>
      applyCharactersResource({
        version: 1,
        revision: 4,
        characters: [
          {
            __serverCharacterShell: true,
            chaId: 'char-a',
            type: 'character',
            name: 'Ada',
            chats: [],
            chatPage: 0,
            chatFolders: [],
          } as never,
        ],
        characterOrder: ['char-a'],
        currentChar: 0,
      }),
    )
    let idleCallback: (() => void) | null = null
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        idleCallback = callback
        return 1
      }),
    })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: vi.fn() })

    prefetchCharacterRouteResource('char-a')
    prefetchCharacterRouteResource('char-a')
    expect(loaderMocks.refresh).not.toHaveBeenCalled()
    expect(window.requestIdleCallback).toHaveBeenCalledOnce()

    idleCallback?.()
    await vi.waitFor(() => expect(loaderMocks.refresh).toHaveBeenCalledOnce())
    expect(loaderMocks.refresh).toHaveBeenCalledWith(
      { characterIds: ['char-a'], minimumRevision: 4 },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('promotes matching character intent so navigation joins the in-flight read', async () => {
    loaderMocks.requirements = [
      requirement({ kind: 'projection', projection: 'selected-character', purposes: ['render'] }),
    ]
    const gridRoute = { kind: 'grid', path: '/grid' } as const
    await prepareRouteResources(gridRoute)
    await finishRouteResources(gridRoute)
    withTestDatabaseWrite(() =>
      applyCharactersResource({
        version: 1,
        revision: 4,
        characters: [
          {
            __serverCharacterShell: true,
            chaId: 'char-a',
            type: 'character',
            name: 'Ada',
            chats: [],
            chatPage: 0,
            chatFolders: [],
          } as never,
        ],
        characterOrder: ['char-a'],
        currentChar: 0,
      }),
    )
    const read = deferred<{ status: 'ok'; revision: number; scope: 'targeted' }>()
    loaderMocks.refresh.mockReturnValue(read.promise)
    let idleCallback: (() => void) | null = null
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        idleCallback = callback
        return 7
      }),
    })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: vi.fn() })

    prefetchCharacterRouteResource('char-a')
    const characterRoute = { kind: 'character', path: '/character/char-a', chaId: 'char-a' } as const
    const navigation = prepareRouteResources(characterRoute)

    expect(idleCallback).not.toBeNull()
    expect(window.cancelIdleCallback).toHaveBeenCalledWith(7)
    expect(loaderMocks.refresh).toHaveBeenCalledOnce()

    read.resolve({ status: 'ok', revision: 5, scope: 'targeted' })
    await expect(navigation).resolves.toBe(true)
    await expect(finishRouteResources(characterRoute)).resolves.toBe(true)
    expect(loaderMocks.refresh).toHaveBeenCalledOnce()
  })

  it('denies direct reader resource warming and a queued idle prefetch after writer loss', async () => {
    enterClientWriter()
    const route = { kind: 'grid', path: '/grid' } as const
    await prepareRouteResources(route)
    await finishRouteResources(route)
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] })]
    let idleCallback: (() => void) | undefined
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        idleCallback = callback
        return 11
      }),
    })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: vi.fn() })
    prefetchRoutePathResources('/settings/display')
    expect(idleCallback).toBeDefined()
    demoteClientSession()
    repromoteClientWriter()
    idleCallback?.()
    expect(loaderMocks.refresh).not.toHaveBeenCalled()
    expect(window.cancelIdleCallback).toHaveBeenCalledWith(11)

    beginClientSession('reader-a')
    vi.mocked(window.requestIdleCallback).mockClear()
    prefetchRoutePathResources('/settings/display')
    prefetchCharacterRouteResource('char-a')
    startLikelyCharacterRouteWarmup()
    await expect(prepareRouteResources(route)).resolves.toBe(false)
    expect(window.requestIdleCallback).not.toHaveBeenCalled()
    expect(loaderMocks.refresh).not.toHaveBeenCalled()
  })

  it('prefetches the exact declared resources for an intended settings route', async () => {
    const gridRoute = { kind: 'grid', path: '/grid' } as const
    await prepareRouteResources(gridRoute)
    await finishRouteResources(gridRoute)
    loaderMocks.requirements = [requirement({ kind: 'settings-group', group: 'display', purposes: ['render'] })]
    let idleCallback: (() => void) | null = null
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        idleCallback = callback
        return 11
      }),
    })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: vi.fn() })

    prefetchRoutePathResources('/settings/display')
    expect(loaderMocks.refresh).not.toHaveBeenCalled()
    expect(idleCallback).not.toBeNull()

    idleCallback?.()
    await vi.waitFor(() => expect(loaderMocks.refresh).toHaveBeenCalledOnce())
    expect(loaderMocks.refresh).toHaveBeenCalledWith(
      { settingsGroups: ['display'], minimumRevision: 4 },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('warms at most three likely character details sequentially after startup', async () => {
    loaderMocks.requirements = []
    const route = { kind: 'grid', path: '/grid' } as const
    await prepareRouteResources(route)
    await finishRouteResources(route)
    withTestDatabaseWrite(() =>
      applyCharactersResource({
        version: 1,
        revision: 4,
        characters: [
          {
            __serverCharacterShell: true,
            chaId: 'char-a',
            type: 'character',
            name: 'Ada',
            lastInteraction: 10,
            pinnedChats: [],
            chats: [],
          },
          {
            __serverCharacterShell: true,
            chaId: 'char-b',
            type: 'character',
            name: 'Bea',
            lastInteraction: 30,
            pinnedChats: [],
            chats: [],
          },
          {
            __serverCharacterShell: true,
            chaId: 'char-c',
            type: 'character',
            name: 'Cy',
            lastInteraction: 5,
            pinnedChats: [{ id: 'chat-c', name: 'Pinned' }],
            chats: [],
          },
          {
            __serverCharacterShell: true,
            chaId: 'char-d',
            type: 'character',
            name: 'Dee',
            lastInteraction: 20,
            pinnedChats: [],
            chats: [],
          },
        ] as never,
        characterOrder: ['char-a', 'char-b', 'char-c', 'char-d'],
        currentChar: 0,
      }),
    )
    const idleCallbacks: Array<() => void> = []
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        idleCallbacks.push(callback)
        return idleCallbacks.length
      }),
    })
    Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: vi.fn() })

    startLikelyCharacterRouteWarmup(10)
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(idleCallbacks[index]).toBeTypeOf('function'))
      idleCallbacks[index]!()
      await vi.waitFor(() => expect(loaderMocks.refresh).toHaveBeenCalledTimes(index + 1))
    }

    expect(loaderMocks.refresh.mock.calls.map(([target]) => target.characterIds?.[0])).toEqual([
      'char-c',
      'char-b',
      'char-d',
    ])
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(3)
  })

  it('rejects a standalone response superseded after request start', async () => {
    loaderMocks.requirements = [
      requirement({ kind: 'standalone-setting', setting: 'selectedPersona', purposes: ['render'] }),
    ]
    const read = deferred<{
      status: 'ok'
      revision: number
      setting: 'selectedPersona'
      state: { present: true; value: number }
    }>()
    loaderMocks.standalone.mockReturnValue(read.promise)
    const route = { kind: 'character', path: '/character/char-a', chaId: 'char-a' } as const
    const loading = prepareRouteResources(route)

    withTestDatabaseWrite(() =>
      applySettingsGroupResource({ revision: 7, group: 'display', settings: { theme: 'newer' } }, ['theme']),
    )
    read.resolve({
      status: 'ok',
      revision: 6,
      setting: 'selectedPersona',
      state: { present: true, value: 2 },
    })

    await expect(loading).resolves.toBe(false)
    expect(currentRouteResourceLoadState()).toMatchObject({
      status: 'error',
      error: 'Standalone setting selectedPersona was superseded before apply',
    })
    expect(getResourceDatabase().selectedPersona).toBeUndefined()
  })

  it('reports selected-chat failure locally and retries the pre-commit detail', async () => {
    loaderMocks.requirements = [
      requirement({ kind: 'projection', projection: 'selected-chat', purposes: ['render'] }),
      requirement({ kind: 'projection', projection: 'selected-prompt-template', purposes: ['generate'] }),
    ]
    const route = {
      kind: 'character',
      path: '/character/char-a/chat-a',
      chaId: 'char-a',
      chatId: 'chat-a',
    } as const
    withTestDatabaseWrite(() =>
      applyCharactersResource({
        version: 1,
        revision: 4,
        characters: [
          {
            chaId: 'char-a',
            type: 'character',
            name: 'Ada',
            chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
            chatPage: 0,
            chatFolders: [],
          } as never,
        ],
        characterOrder: ['char-a'],
        currentChar: 0,
      }),
    )
    loaderMocks.routeChat.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(prepareRouteResources(route)).resolves.toBe(false)
    expect(currentRouteResourceLoadState()).toMatchObject({ status: 'error', error: 'Selected chat hydration failed' })

    await expect(prepareRouteResources(route)).resolves.toBe(true)
    await expect(finishRouteResources(route)).resolves.toBe(true)
    expect(loaderMocks.routeChat).toHaveBeenCalledTimes(2)
    expect(loaderMocks.prompt).toHaveBeenCalledTimes(3)
    expect(currentRouteResourceLoadState()).toMatchObject({ status: 'ready' })
  })
})
