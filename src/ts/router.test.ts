import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { getResourceDatabase, withTestDatabaseWrite } from './__tests__/resourceDatabaseState'

const routerMocks = vi.hoisted(() => ({
  changeChar: vi.fn<(...args: any[]) => Promise<void> | void>(),
  changeChatTo: vi.fn(),
  changeUserPersonaWithOutcome: vi.fn(),
  findCharacterIndexbyId: vi.fn<(characterId: string) => number>(() => -1),
  openPlaygroundChat: vi.fn(),
  finishRouteResources: vi.fn(async () => true),
  failActiveRouteLoad: vi.fn(),
  preloadRouteComponents: vi.fn(async () => undefined),
  prepareRouteResources: vi.fn(async () => true),
}))

vi.mock('./server/routeResourceLoader', () => ({
  finishRouteResources: routerMocks.finishRouteResources,
  failActiveRouteLoad: routerMocks.failActiveRouteLoad,
  prepareRouteResources: routerMocks.prepareRouteResources,
}))

vi.mock('./routeComponentPreload', () => ({
  preloadRouteComponents: routerMocks.preloadRouteComponents,
}))

vi.mock('./characters', () => ({
  changeChar: routerMocks.changeChar,
}))

vi.mock('./globalApi.svelte', () => ({
  changeChatTo: routerMocks.changeChatTo,
  downloadFile: vi.fn(),
  saveAsset: vi.fn(),
}))

vi.mock('./playground', () => ({
  PLAYGROUND_CHARACTER_ID: 'playground',
  openPlaygroundChat: routerMocks.openPlaygroundChat,
}))

vi.mock('./persona', () => ({
  changeUserPersonaWithOutcome: routerMocks.changeUserPersonaWithOutcome,
}))

vi.mock('./process/index.svelte', async () => {
  const { writable } = await import('svelte/store')
  return {
    activeGenerationTarget: writable(null),
    doingChat: writable(false),
  }
})

vi.mock('./characterState', () => ({
  findCharacterIndexbyId: routerMocks.findCharacterIndexbyId,
}))

vi.mock('./stores.svelte', async () => {
  const { writable } = await import('svelte/store')
  return {
    CharEmotion: writable({}),
    CustomGUISettingMenuStore: writable(false),
    OpenRealmStore: writable(false),
    PlaygroundStore: writable(0),
    ScrollToMessageStore: { value: -1 },
    SettingsMenuIndex: writable(1),
    botMakerMode: writable(false),
    selectedCharID: writable(-1),
    settingsOpen: writable(false),
  }
})

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function importRouterAt(path: string) {
  vi.resetModules()
  window.history.replaceState(null, '', path)
  return await import('./router')
}

beforeEach(() => {
  routerMocks.changeChar.mockReset()
  routerMocks.changeChatTo.mockReset()
  routerMocks.changeUserPersonaWithOutcome.mockReset()
  routerMocks.findCharacterIndexbyId.mockReset()
  routerMocks.findCharacterIndexbyId.mockReturnValue(-1)
  routerMocks.openPlaygroundChat.mockReset()
  routerMocks.finishRouteResources.mockReset().mockResolvedValue(true)
  routerMocks.failActiveRouteLoad.mockReset()
  routerMocks.preloadRouteComponents.mockReset().mockResolvedValue(undefined)
  routerMocks.prepareRouteResources.mockReset().mockResolvedValue(true)
})

afterEach(async () => {
  const { activeGenerationTarget, doingChat } = await import('./process/index.svelte')
  activeGenerationTarget.set(null)
  doingChat.set(false)
})

describe('router initial application', () => {
  it('retains reader navigation on in-app authoring entry and leaves direct routes for the shared gate', async () => {
    const router = await importRouterAt('/character/reader/chat-a')
    const { enterClientWriter } = await import('./__tests__/clientSession')
    const { demoteClientSession } = await import('./clientSession')
    enterClientWriter()
    demoteClientSession()
    for (const path of ['/settings', '/settings/plugins', '/playground', '/inlay']) {
      router.navigate(path)
      expect(window.location.pathname).toBe('/character/reader/chat-a')
      expect(get(router.currentRoute)).toMatchObject({ kind: 'character', chaId: 'reader', chatId: 'chat-a' })
    }
    router.openSettingsRoute()
    router.navigateToPersonaSettings('persona-a')
    expect(window.location.pathname).toBe('/character/reader/chat-a')
    expect(routerMocks.prepareRouteResources).not.toHaveBeenCalled()
    expect(routerMocks.preloadRouteComponents).not.toHaveBeenCalled()

    router.installRouter()
    window.history.replaceState(null, '', '/settings/plugins')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(get(router.currentRoute)).toMatchObject({ kind: 'settings' })
    await expect(router.applyRouteToStores(get(router.currentRoute))).resolves.toBe(false)
    expect(routerMocks.prepareRouteResources).not.toHaveBeenCalled()
    expect(routerMocks.preloadRouteComponents).not.toHaveBeenCalled()
  })

  it('does not apply a retired writer route after reader navigation while its chunk is loading', async () => {
    const router = await importRouterAt('/')
    const { enterClientWriter } = await import('./__tests__/clientSession')
    const { demoteClientSession } = await import('./clientSession')
    enterClientWriter()
    const stores = await import('./stores.svelte')
    const chunk = deferred()
    routerMocks.preloadRouteComponents.mockReturnValueOnce(chunk.promise)
    const applying = router.applyRouteToStores({
      kind: 'settings',
      path: '/settings/display',
      section: 'display',
      index: 3,
    })
    await vi.waitFor(() => expect(routerMocks.preloadRouteComponents).toHaveBeenCalledOnce())
    demoteClientSession()
    router.navigate('/character/reader/reader-chat')
    chunk.resolve()
    await expect(applying).resolves.toBe(false)
    expect(get(stores.settingsOpen)).toBe(false)
    expect(window.location.pathname).toBe('/character/reader/reader-chat')
    expect(routerMocks.finishRouteResources).not.toHaveBeenCalled()
    expect(routerMocks.changeChar).not.toHaveBeenCalled()
  })

  it('keeps route stores unchanged until the target component chunks are ready', async () => {
    const router = await importRouterAt('/')
    const stores = await import('./stores.svelte')
    const componentLoad = deferred()
    routerMocks.preloadRouteComponents.mockReturnValueOnce(componentLoad.promise)
    const route = { kind: 'settings', path: '/settings/display', section: 'display', index: 3 } as const

    const applying = router.applyRouteToStores(route)
    await vi.waitFor(() => expect(routerMocks.preloadRouteComponents).toHaveBeenCalledWith(route))

    expect(get(stores.settingsOpen)).toBe(false)
    expect(get(stores.SettingsMenuIndex)).toBe(1)

    componentLoad.resolve()
    await expect(applying).resolves.toBe(true)
    expect(get(stores.settingsOpen)).toBe(true)
    expect(get(stores.SettingsMenuIndex)).toBe(3)
  })

  it('keeps the previous route stores and exposes a local error when a target chunk fails', async () => {
    const router = await importRouterAt('/')
    const stores = await import('./stores.svelte')
    const error = new Error('missing route chunk')
    routerMocks.preloadRouteComponents.mockRejectedValueOnce(error)
    const route = { kind: 'grid', path: '/grid' } as const
    const previousSelection = get(stores.selectedCharID)
    const previousSettingsOpen = get(stores.settingsOpen)

    await expect(router.applyRouteToStores(route)).resolves.toBe(false)

    expect(get(stores.selectedCharID)).toBe(previousSelection)
    expect(get(stores.settingsOpen)).toBe(previousSettingsOpen)
    expect(routerMocks.failActiveRouteLoad).toHaveBeenCalledWith(route, error)
  })

  it('opens a direct route for a bot left in retired Mood Light metadata', async () => {
    const router = await importRouterAt('/character/char-private/chat-a')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-private',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
      ],
      characterOrder: ['char-private'],
      moodLightMembership: { characterIds: ['char-private'], folders: [] },
    } as any)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    routerMocks.changeChar.mockImplementation(async (index: number) => {
      stores.selectedCharID.set(index)
    })

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/character/char-private/chat-a')
    expect(get(stores.selectedCharID)).toBe(0)
    expect(routerMocks.changeChar).toHaveBeenCalledWith(0, expect.objectContaining({ isFresh: expect.any(Function) }))
  }, 15_000)

  it('does not treat initial root load as a pending home navigation', async () => {
    const router = await importRouterAt('/')

    expect(get(router.currentRoute)).toMatchObject({ kind: 'home', path: '/' })
    expect(router.hasPendingRouteApplication()).toBe(false)
  })

  it('still applies a deep link route on initial load', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')

    expect(get(router.currentRoute)).toMatchObject({
      kind: 'character',
      chaId: 'char-a',
      chatId: 'chat-a',
    })
    expect(router.hasPendingRouteApplication()).toBe(true)
  })

  it('keeps the bare settings route as the settings menu state', async () => {
    const router = await importRouterAt('/settings')
    const stores = await import('./stores.svelte')
    const { SettingsMenuIndex, settingsOpen } = stores

    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings',
      section: '',
      index: -1,
    })

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(get(settingsOpen)).toBe(true)
    expect(get(SettingsMenuIndex)).toBe(-1)
  })

  it('serializes the open settings menu as the bare settings route', async () => {
    const router = await importRouterAt('/')

    router.syncRouteFromState({
      currentRouteKind: 'home',
      settingsOpen: true,
      settingsMenuIndex: -1,
      selectedCharID: -1,
      playgroundStore: 0,
    })

    expect(window.location.pathname).toBe('/settings')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings',
      section: '',
      index: -1,
    })
  })

  it.each(['/settings/other-bots', '/settings/otherbots'])('canonicalizes the legacy Memory route %s', async (path) => {
    const router = await importRouterAt(path)
    const stores = await import('./stores.svelte')

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/settings/memory')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/memory',
      section: 'memory',
      index: 2,
    })
    expect(get(stores.SettingsMenuIndex)).toBe(2)
  })

  it('routes and serializes the Source Code settings section', async () => {
    const router = await importRouterAt('/settings/source-code')
    const stores = await import('./stores.svelte')
    const { SettingsMenuIndex, settingsOpen } = stores

    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/source-code',
      section: 'source-code',
      index: 22,
    })

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(get(settingsOpen)).toBe(true)
    expect(get(SettingsMenuIndex)).toBe(22)

    router.syncRouteFromState({
      currentRouteKind: 'settings',
      settingsOpen: true,
      settingsMenuIndex: 22,
      selectedCharID: -1,
      playgroundStore: 0,
    })

    expect(window.location.pathname).toBe('/settings/source-code')
  })

  it('routes a specific persona id and selects it through the persona command path', async () => {
    const router = await importRouterAt('/settings/persona/persona-b')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      selectedPersonaId: 'persona-a',
      selectedPersona: 0,
      username: 'A',
      userIcon: '',
      personaPrompt: '',
      userNote: '',
      personas: [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: '', note: '' },
      ],
    } as any)
    routerMocks.changeUserPersonaWithOutcome.mockResolvedValue('accepted')

    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/persona/persona-b',
      section: 'persona',
      index: 12,
      personaId: 'persona-b',
    })

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(routerMocks.changeUserPersonaWithOutcome).toHaveBeenCalledWith(1)
    expect(get(stores.settingsOpen)).toBe(true)
    expect(get(stores.SettingsMenuIndex)).toBe(12)
  })

  it('serializes a selected persona id in the settings route', async () => {
    const router = await importRouterAt('/settings/persona')

    router.syncRouteFromState({
      currentRouteKind: 'settings',
      settingsOpen: true,
      settingsMenuIndex: 12,
      selectedCharID: -1,
      playgroundStore: 0,
      personaId: 'persona / one',
    })

    expect(window.location.pathname).toBe('/settings/persona/persona%20%2F%20one')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      index: 12,
      personaId: 'persona / one',
    })
  })

  it('replaces an unknown persona route with the current valid selection', async () => {
    const router = await importRouterAt('/settings/persona/missing-persona')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      selectedPersonaId: 'persona-a',
      selectedPersona: 0,
      username: 'A',
      userIcon: '',
      personaPrompt: '',
      userNote: '',
      personas: [{ id: 'persona-a', name: 'A', icon: '', personaPrompt: '', note: '' }],
    } as any)
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/settings/persona/persona-a')
    expect(routerMocks.changeUserPersonaWithOutcome).not.toHaveBeenCalled()
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenCalledOnce()
    replaceState.mockRestore()
    pushState.mockRestore()
  })
})

describe('router grid history', () => {
  it('marks an in-app grid entry and closes it through browser history', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    router.openGridRoute()

    expect(window.location.pathname).toBe('/grid')
    expect(get(router.currentRoute)).toEqual({ kind: 'grid', path: '/grid' })
    expect(window.history.state).toEqual({
      __risuGridNavigation: {
        originPath: '/character/char-a/chat-a',
        version: 1,
      },
    })

    router.closeGridRoute()
    router.closeGridRoute()

    expect(back).toHaveBeenCalledOnce()
    back.mockRestore()
  })

  it('replaces a direct grid entry with home instead of adding a stale grid entry', async () => {
    const router = await importRouterAt('/grid')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    router.closeGridRoute()

    expect(window.location.pathname).toBe('/')
    expect(get(router.currentRoute)).toEqual({ kind: 'home', path: '/' })
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    pushState.mockRestore()
    replaceState.mockRestore()
  })
})

describe('router settings history', () => {
  it('keeps the current Settings section when an active module editor cancels navigation', async () => {
    const router = await importRouterAt('/settings/modules')
    const { registerModuleEditorLeaveGuard } = await import('./moduleEditorLeaveGuard')
    const guard = vi.fn(() => false)
    const unregister = registerModuleEditorLeaveGuard(guard)

    try {
      router.navigate('/settings/display')

      expect(guard).toHaveBeenCalledOnce()
      expect(window.location.pathname).toBe('/settings/modules')
      expect(get(router.currentRoute)).toMatchObject({ kind: 'settings', index: 14 })
    } finally {
      unregister()
    }
  })

  it('does not start Settings history traversal when an active module editor cancels leaving', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const { registerModuleEditorLeaveGuard } = await import('./moduleEditorLeaveGuard')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    router.openSettingsRoute('/settings/modules')
    const unregister = registerModuleEditorLeaveGuard(() => false)

    try {
      router.closeSettingsRoute()

      expect(back).not.toHaveBeenCalled()
      expect(window.location.pathname).toBe('/settings/modules')
    } finally {
      unregister()
      back.mockRestore()
    }
  })

  it('reverses browser history traversal when an active module editor cancels leaving', async () => {
    const router = await importRouterAt('/settings/modules')
    const { registerModuleEditorLeaveGuard } = await import('./moduleEditorLeaveGuard')
    const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {})
    const unregister = registerModuleEditorLeaveGuard(() => false)
    router.installRouter()

    try {
      window.history.pushState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))

      expect(forward).toHaveBeenCalledOnce()
      expect(get(router.currentRoute)).toMatchObject({ kind: 'settings', index: 14 })
    } finally {
      unregister()
      forward.mockRestore()
    }
  })

  it('uses one marked history entry for an in-app Settings session', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    router.openSettingsRoute()

    expect(window.location.pathname).toBe('/settings')
    expect(window.history.state).toEqual({
      __risuSettingsNavigation: {
        originPath: '/character/char-a/chat-a',
        version: 1,
      },
    })

    router.navigate('/settings/model')
    router.navigate('/settings/display')

    expect(window.location.pathname).toBe('/settings/display')
    expect(pushState).toHaveBeenCalledOnce()
    expect(replaceState).toHaveBeenCalledTimes(2)
    expect(window.history.state).toEqual({
      __risuSettingsNavigation: {
        originPath: '/character/char-a/chat-a',
        version: 1,
      },
    })

    router.closeSettingsRoute()
    router.closeSettingsRoute()

    expect(back).toHaveBeenCalledOnce()
    pushState.mockRestore()
    replaceState.mockRestore()
    back.mockRestore()
  })

  it('replaces a direct Settings entry with home when there is no marked origin', async () => {
    const router = await importRouterAt('/settings/model')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})

    router.navigate('/settings/display')

    expect(window.location.pathname).toBe('/settings/display')
    expect(window.history.state).toBeNull()

    router.closeSettingsRoute()

    expect(window.location.pathname).toBe('/')
    expect(pushState).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/')
    pushState.mockRestore()
    replaceState.mockRestore()
    back.mockRestore()
  })

  it('marks legacy store-driven Settings openings and preserves the origin across sections', async () => {
    const router = await importRouterAt('/grid')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    router.syncRouteFromState({
      currentRouteKind: 'grid',
      settingsOpen: true,
      settingsMenuIndex: -1,
      selectedCharID: -1,
      playgroundStore: 0,
    })
    router.syncRouteFromState({
      currentRouteKind: 'settings',
      settingsOpen: true,
      settingsMenuIndex: 17,
      selectedCharID: -1,
      playgroundStore: 0,
    })

    expect(window.location.pathname).toBe('/settings/model')
    expect(pushState).toHaveBeenCalledOnce()
    expect(replaceState).toHaveBeenCalledOnce()
    expect(window.history.state).toEqual({
      __risuSettingsNavigation: {
        originPath: '/grid',
        version: 1,
      },
    })
    pushState.mockRestore()
    replaceState.mockRestore()
  })

  it('replaces the current settings entry when navigating between personas', async () => {
    const router = await importRouterAt('/settings/persona/persona-a')
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    router.navigateToPersonaSettings('persona-b')

    expect(window.location.pathname).toBe('/settings/persona/persona-b')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'settings',
      index: 12,
      personaId: 'persona-b',
    })
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenCalledOnce()
    replaceState.mockRestore()
    pushState.mockRestore()
  })
})

describe('router character route freshness', () => {
  it('delivers a queued message jump once after applying its chat route', async () => {
    const router = await importRouterAt('/character/char-a')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
      ],
    } as any)
    stores.selectedCharID.set(0)
    stores.ScrollToMessageStore.value = -1
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )

    router.navigateToCharacterChatMessage('char-a', 'chat-a', 12)

    expect(window.location.pathname).toBe('/character/char-a/chat-a')
    expect(stores.ScrollToMessageStore.value).toBe(-1)

    await router.applyRouteToStores(get(router.currentRoute))
    expect(stores.ScrollToMessageStore.value).toBe(12)

    stores.ScrollToMessageStore.value = -1
    await router.applyRouteToStores(get(router.currentRoute))
    expect(stores.ScrollToMessageStore.value).toBe(-1)
  })

  it('restores a same-entry character sidebar view without carrying it into same-character route navigation', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-a', name: 'Chat A', message: [] },
            { id: 'chat-b', name: 'Chat B', message: [] },
          ],
        },
      ],
    } as any)
    stores.selectedCharID.set(0)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )

    await router.applyRouteToStores(get(router.currentRoute))
    router.setCharacterSidebarViewMode('character')
    expect(get(stores.botMakerMode)).toBe(true)

    // A database-lineage recovery reload recreates the JS stores but retains
    // the current browser history entry. Model that reset before reapplying the
    // unchanged route.
    stores.botMakerMode.set(false)
    await router.applyRouteToStores(get(router.currentRoute))
    expect(get(stores.botMakerMode)).toBe(true)

    router.navigate('/character/char-a/chat-b')
    await router.applyRouteToStores(get(router.currentRoute))

    expect(routerMocks.changeChatTo).toHaveBeenCalledWith('chat-b')
    expect(get(stores.botMakerMode)).toBe(false)
  })

  it.each(['ready', 'loading', 'error', 'different-character', 'duplicate-character', 'reader', 'new-route'] as const)(
    'restores only a valid writer history presentation without selection commands: %s',
    async (state) => {
      const router = await importRouterAt('/character/char-a/chat-a')
      const { enterClientWriter } = await import('./__tests__/clientSession')
      enterClientWriter()
      const stores = await import('./stores.svelte')
      const { charactersResourceState, replaceResourceDatabase } = await import('./server/resourceState.svelte')
      const character = { chaId: 'char-a', chatPage: 0, chats: [{ id: 'chat-a', message: [] }] }
      replaceResourceDatabase({ characters: [character] } as any)
      stores.selectedCharID.set(0)
      router.setCharacterSidebarViewMode('character')
      stores.botMakerMode.set(false)
      if (state === 'loading' || state === 'error') charactersResourceState.status = state
      if (state === 'different-character') charactersResourceState.characters[0].chaId = 'char-b'
      if (state === 'duplicate-character') charactersResourceState.characters.push({ ...character } as any)
      if (state === 'reader') {
        const { demoteClientSession } = await import('./clientSession')
        demoteClientSession()
      }
      if (state === 'new-route') router.navigate('/character/char-a/chat-b')

      router.restoreCharacterSidebarViewFromHistory()

      expect(get(stores.botMakerMode)).toBe(state === 'ready')
      expect(routerMocks.changeChar).not.toHaveBeenCalled()
      expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
      expect(routerMocks.prepareRouteResources).not.toHaveBeenCalled()
    },
  )

  it.each(['idle', 'loading'] as const)(
    'does not restore the sidebar while character owners are %s',
    async (status) => {
      const router = await importRouterAt('/character/char-a/chat-a')
      const stores = await import('./stores.svelte')
      const { charactersResourceState, replaceResourceDatabase } = await import('./server/resourceState.svelte')
      replaceResourceDatabase({
        characters: [
          {
            chaId: 'char-a',
            chatPage: 0,
            chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
          },
        ],
      } as any)
      stores.selectedCharID.set(0)
      routerMocks.findCharacterIndexbyId.mockReturnValue(0)
      router.setCharacterSidebarViewMode('character')
      stores.botMakerMode.set(false)
      charactersResourceState.status = status

      await router.applyRouteToStores(get(router.currentRoute))

      expect(get(stores.botMakerMode)).toBe(false)
    },
  )

  it('fails closed instead of restoring a sidebar view from an errored character owner', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const stores = await import('./stores.svelte')
    const { charactersResourceState, replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
      ],
    } as any)
    stores.selectedCharID.set(0)
    routerMocks.findCharacterIndexbyId.mockReturnValue(0)
    router.setCharacterSidebarViewMode('character')
    stores.botMakerMode.set(false)
    charactersResourceState.status = 'error'

    await router.applyRouteToStores(get(router.currentRoute))

    expect(get(stores.botMakerMode)).toBe(false)
  })

  it('allows character-only navigation away from an active generation', async () => {
    const router = await importRouterAt('/')
    const { activeGenerationTarget, doingChat } = await import('./process/index.svelte')
    activeGenerationTarget.set({
      selectedCharID: 0,
      chatPage: 1,
      characterId: 'char-a',
      chatId: 'chat-owner',
    })
    doingChat.set(true)

    router.navigate('/character/char-a')

    expect(window.location.pathname).toBe('/character/char-a')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'character',
      chaId: 'char-a',
    })

    router.navigate('/character/char-b')
    expect(window.location.pathname).toBe('/character/char-b')
  })

  it('reopens exactly the active generation owner after leaving the chat', async () => {
    const router = await importRouterAt('/settings/model')
    const stores = await import('./stores.svelte')
    const { activeGenerationTarget, doingChat } = await import('./process/index.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    const { selectedCharID } = stores
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-a', name: 'Chat A', message: [] },
            { id: 'chat-owner', name: 'Generating chat', message: [] },
          ],
        },
        {
          chaId: 'char-b',
          chatPage: 0,
          chats: [{ id: 'chat-b', name: 'Chat B', message: [] }],
        },
      ],
    } as any)
    selectedCharID.set(-1)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    routerMocks.changeChar.mockImplementation(async (index: number) => {
      selectedCharID.set(index)
    })
    activeGenerationTarget.set({
      selectedCharID: 0,
      chatPage: 1,
      characterId: 'char-a',
      chatId: 'chat-owner',
    })
    doingChat.set(true)

    router.navigate('/character/char-a/chat-a')
    router.navigate('/character/char-b/chat-b')
    expect(window.location.pathname).toBe('/character/char-b/chat-b')

    router.navigate('/character/char-a/chat-owner')
    expect(window.location.pathname).toBe('/character/char-a/chat-owner')
    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(routerMocks.changeChar).toHaveBeenCalledWith(0, {
      isFresh: expect.any(Function),
    })
    expect(routerMocks.changeChatTo).toHaveBeenCalledWith('chat-owner')
    expect(get(selectedCharID)).toBe(0)
  })

  it('applies history navigation to another chat during an active generation', async () => {
    const router = await importRouterAt('/character/char-a/chat-other')
    const stores = await import('./stores.svelte')
    const { activeGenerationTarget, doingChat } = await import('./process/index.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-owner', name: 'Generating chat', message: [] },
            { id: 'chat-other', name: 'Other chat', message: [] },
          ],
        },
      ],
    } as any)
    stores.selectedCharID.set(-1)
    routerMocks.findCharacterIndexbyId.mockReturnValue(0)
    routerMocks.changeChar.mockImplementation(async (index: number) => {
      stores.selectedCharID.set(index)
    })
    activeGenerationTarget.set({
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'char-a',
      chatId: 'chat-owner',
    })
    doingChat.set(true)

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/character/char-a/chat-other')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'character',
      chaId: 'char-a',
      chatId: 'chat-other',
    })
    expect(routerMocks.changeChar).toHaveBeenCalledWith(0, {
      isFresh: expect.any(Function),
    })
    expect(routerMocks.changeChatTo).toHaveBeenCalledWith('chat-other')
    expect(get(stores.selectedCharID)).toBe(0)
  })

  it('allows in-app navigation to another character during generation', async () => {
    const router = await importRouterAt('/')
    const stores = await import('./stores.svelte')
    const { activeGenerationTarget, doingChat } = await import('./process/index.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    const { selectedCharID } = stores
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
        {
          chaId: 'char-b',
          chatPage: 0,
          chats: [{ id: 'chat-b', name: 'Chat B', message: [] }],
        },
      ],
    } as any)
    selectedCharID.set(0)
    router.syncRouteFromState({
      currentRouteKind: 'home',
      settingsOpen: false,
      settingsMenuIndex: 1,
      selectedCharID: 0,
      playgroundStore: 0,
      characterId: 'char-a',
      chatId: 'chat-a',
    })
    activeGenerationTarget.set({
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'char-a',
      chatId: 'chat-a',
    })
    doingChat.set(true)

    router.navigate('/character/char-b/chat-b')

    expect(window.location.pathname).toBe('/character/char-b/chat-b')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'character',
      chaId: 'char-b',
      chatId: 'chat-b',
    })
    expect(get(selectedCharID)).toBe(0)
    expect(routerMocks.changeChar).not.toHaveBeenCalled()
  })

  it('canonicalizes a deep or history route when character selection is refused', async () => {
    const router = await importRouterAt('/character/char-b/chat-b')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    const { selectedCharID } = stores
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
        {
          chaId: 'char-b',
          chatPage: 0,
          chats: [{ id: 'chat-b', name: 'Chat B', message: [] }],
        },
      ],
    } as any)
    selectedCharID.set(0)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    routerMocks.changeChar.mockResolvedValue(undefined)

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(routerMocks.changeChar).toHaveBeenCalledWith(1, { isFresh: expect.any(Function) })
    expect(get(selectedCharID)).toBe(0)
    expect(window.location.pathname).toBe('/character/char-a/chat-a')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'character',
      chaId: 'char-a',
      chatId: 'chat-a',
    })
    expect(router.isApplyingRouteToStores()).toBe(false)
    expect(router.hasPendingRouteApplication()).toBe(false)
  })

  it('canonicalizes a missing chat to the bare selected character route', async () => {
    const router = await importRouterAt('/character/char-a/missing-chat')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
      ],
    } as any)
    stores.selectedCharID.set(0)
    routerMocks.findCharacterIndexbyId.mockReturnValue(0)

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(routerMocks.changeChar).not.toHaveBeenCalled()
    expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/character/char-a')
    expect(get(router.currentRoute)).toEqual({
      kind: 'character',
      path: '/character/char-a',
      chaId: 'char-a',
      chatId: undefined,
    })
    expect(get(stores.selectedCharID)).toBe(0)
    expect(router.isApplyingRouteToStores()).toBe(false)
    expect(router.hasPendingRouteApplication()).toBe(false)
  })

  it('does not persist a reconciled observer route when authoritative character and chat selection already match', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', name: 'Chat A', message: [] }],
        },
      ],
    } as any)
    stores.selectedCharID.set(0)
    routerMocks.findCharacterIndexbyId.mockReturnValue(0)

    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(routerMocks.changeChar).not.toHaveBeenCalled()
    expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
    expect(get(stores.selectedCharID)).toBe(0)
    expect(window.location.pathname).toBe('/character/char-a/chat-a')
  })

  it('canonicalizes a missing character to home during generation and preserves back-forward history', async () => {
    const router = await importRouterAt('/character/char-a/chat-owner')
    const stores = await import('./stores.svelte')
    const { activeGenerationTarget, doingChat } = await import('./process/index.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [{ id: 'chat-owner', name: 'Generating chat', message: [] }],
        },
      ],
    } as any)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    routerMocks.changeChar.mockImplementation(async (index: number) => {
      stores.selectedCharID.set(index)
    })
    stores.selectedCharID.set(0)
    router.installRouter()
    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    const generationTarget = {
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'char-a',
      chatId: 'chat-owner',
    }
    activeGenerationTarget.set(generationTarget)
    doingChat.set(true)
    stores.settingsOpen.set(true)
    stores.PlaygroundStore.set(14)
    stores.OpenRealmStore.set(true)
    const replaceState = vi.spyOn(window.history, 'replaceState')

    router.navigate('/character/deleted-id/deleted-chat')
    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/')
    expect(get(router.currentRoute)).toEqual({ kind: 'home', path: '/' })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(get(stores.selectedCharID)).toBe(-1)
    expect(get(stores.settingsOpen)).toBe(false)
    expect(get(stores.PlaygroundStore)).toBe(0)
    expect(get(stores.OpenRealmStore)).toBe(false)
    expect(get(activeGenerationTarget)).toEqual(generationTarget)
    expect(get(doingChat)).toBe(true)
    expect(routerMocks.changeChar).not.toHaveBeenCalled()
    expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
    expect(router.consumeStateDrivenRouteUpdate()).toBe(true)

    window.history.back()
    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/character/char-a/chat-owner')
    expect(get(router.currentRoute)).toMatchObject({
      kind: 'character',
      chaId: 'char-a',
      chatId: 'chat-owner',
    })
    expect(get(stores.selectedCharID)).toBe(0)
    expect(get(activeGenerationTarget)).toEqual(generationTarget)
    expect(get(doingChat)).toBe(true)

    window.history.forward()
    await router.applyRouteToStores(get(router.currentRoute))
    await flushMicrotasks()

    expect(window.location.pathname).toBe('/')
    expect(get(router.currentRoute)).toEqual({ kind: 'home', path: '/' })
    expect(get(stores.selectedCharID)).toBe(-1)
    expect(get(activeGenerationTarget)).toEqual(generationTarget)
    expect(get(doingChat)).toBe(true)
    expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
    replaceState.mockRestore()
  })

  it('does not let a stale character route clear a newer pending character route', async () => {
    const router = await importRouterAt('/character/char-a/chat-a')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    const { selectedCharID } = stores
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-old-a', name: 'Old A', message: [] },
            { id: 'chat-a', name: 'Chat A', message: [] },
          ],
        },
        {
          chaId: 'char-b',
          chatPage: 0,
          chats: [
            { id: 'chat-old-b', name: 'Old B', message: [] },
            { id: 'chat-b', name: 'Chat B', message: [] },
          ],
        },
      ],
    } as any)
    selectedCharID.set(-1)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    const staleSelection = deferred()
    const latestSelection = deferred()
    routerMocks.changeChar
      .mockImplementationOnce(async () => {
        await staleSelection.promise
      })
      .mockImplementationOnce(async () => {
        await latestSelection.promise
      })

    const staleRoute = router.applyRouteToStores({
      kind: 'character',
      path: '/character/char-a/chat-a',
      chaId: 'char-a',
      chatId: 'chat-a',
    })
    await vi.waitFor(() => {
      expect(routerMocks.changeChar).toHaveBeenCalledTimes(1)
    })

    router.navigate('/character/char-b/chat-b')
    const latestRoute = router.applyRouteToStores({
      kind: 'character',
      path: '/character/char-b/chat-b',
      chaId: 'char-b',
      chatId: 'chat-b',
    })
    await vi.waitFor(() => {
      expect(routerMocks.changeChar).toHaveBeenCalledTimes(2)
    })

    staleSelection.resolve()
    await staleRoute
    await flushMicrotasks()

    expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
    expect(router.isApplyingRouteToStores()).toBe(true)
    expect(router.hasPendingRouteApplication()).toBe(true)

    selectedCharID.set(1)
    latestSelection.resolve()
    await latestRoute
    await flushMicrotasks()

    expect(routerMocks.changeChatTo).toHaveBeenCalledTimes(1)
    expect(routerMocks.changeChatTo).toHaveBeenCalledWith('chat-b')
    expect(router.isApplyingRouteToStores()).toBe(false)
    expect(router.hasPendingRouteApplication()).toBe(false)
  })

  it('does not let a stale delayed character route select a chat after a newer settings route wins', async () => {
    const router = await importRouterAt('/character/char-a/chat-target')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    const { PlaygroundStore, SettingsMenuIndex, selectedCharID, settingsOpen } = stores
    replaceResourceDatabase({
      characters: [
        {
          chaId: 'char-a',
          chatPage: 0,
          chats: [
            { id: 'chat-old', name: 'Old chat', message: [] },
            { id: 'chat-target', name: 'Target chat', message: [] },
          ],
        },
      ],
    } as any)
    selectedCharID.set(-1)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    const pendingSelection = deferred()
    routerMocks.changeChar.mockImplementation(async () => {
      await pendingSelection.promise
    })

    const staleRoute = router.applyRouteToStores({
      kind: 'character',
      path: '/character/char-a/chat-target',
      chaId: 'char-a',
      chatId: 'chat-target',
    })
    await vi.waitFor(() => {
      expect(routerMocks.changeChar).toHaveBeenCalledWith(0, { isFresh: expect.any(Function) })
    })

    const latestRoute = router.applyRouteToStores({
      kind: 'settings',
      path: '/settings/model',
      section: 'model',
      index: 17,
    })
    await latestRoute
    await flushMicrotasks()

    expect(get(settingsOpen)).toBe(true)
    expect(get(SettingsMenuIndex)).toBe(17)
    expect(get(PlaygroundStore)).toBe(0)
    expect(get(selectedCharID)).toBe(-1)
    expect(router.isApplyingRouteToStores()).toBe(false)
    expect(router.hasPendingRouteApplication()).toBe(false)

    pendingSelection.resolve()
    await staleRoute
    await flushMicrotasks()

    expect(routerMocks.changeChatTo).not.toHaveBeenCalled()
    expect(get(settingsOpen)).toBe(true)
    expect(get(selectedCharID)).toBe(-1)
    expect(router.isApplyingRouteToStores()).toBe(false)
    expect(router.hasPendingRouteApplication()).toBe(false)
  })

  it('re-resolves the live character index after character selection before selecting the routed chat', async () => {
    const router = await importRouterAt('/')
    const stores = await import('./stores.svelte')
    const { replaceResourceDatabase } = await import('./server/resourceState.svelte')
    const { selectedCharID } = stores
    const charA = {
      chaId: 'char-a',
      chatPage: 0,
      chats: [
        { id: 'chat-old', name: 'Old chat', message: [] },
        { id: 'chat-target', name: 'Target chat', message: [] },
      ],
    }
    const charB = {
      chaId: 'char-b',
      chatPage: 0,
      chats: [{ id: 'chat-b', name: 'B chat', message: [] }],
    }
    replaceResourceDatabase({
      characters: [charA, charB],
    } as any)
    selectedCharID.set(-1)
    routerMocks.findCharacterIndexbyId.mockImplementation(
      (characterId: string) =>
        getResourceDatabase().characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1,
    )
    routerMocks.changeChar.mockImplementation(async (_index: number) => {
      replaceResourceDatabase({ characters: [charB, charA] } as any)
      selectedCharID.set(1)
    })

    await router.applyRouteToStores({
      kind: 'character',
      path: '/character/char-a/chat-target',
      chaId: 'char-a',
      chatId: 'chat-target',
    })

    expect(routerMocks.changeChar).toHaveBeenCalledWith(0, { isFresh: expect.any(Function) })
    expect(routerMocks.changeChatTo).toHaveBeenCalledWith('chat-target')
  })
})

describe('router playground route freshness', () => {
  it('passes route ownership into an asynchronous playground open', async () => {
    const router = await importRouterAt('/playground/chat')
    const stores = await import('./stores.svelte')
    const { PlaygroundStore, selectedCharID } = stores
    const pendingOpen = deferred()
    let routeIsFresh: (() => boolean) | undefined
    routerMocks.openPlaygroundChat.mockImplementationOnce(async (options: { isFresh?: () => boolean } = {}) => {
      routeIsFresh = options.isFresh
      await pendingOpen.promise
      if (routeIsFresh?.()) {
        selectedCharID.set(3)
      }
    })

    const staleRoute = router.applyRouteToStores({
      kind: 'playground',
      path: '/playground/chat',
      tool: 'chat',
      index: 2,
    })
    await vi.waitFor(() => expect(routerMocks.openPlaygroundChat).toHaveBeenCalledTimes(1))

    await router.applyRouteToStores({ kind: 'home', path: '/' })
    await flushMicrotasks()
    expect(routeIsFresh?.()).toBe(false)

    pendingOpen.resolve()
    await staleRoute
    await flushMicrotasks()

    expect(get(PlaygroundStore)).toBe(0)
    expect(get(selectedCharID)).toBe(-1)
  })
})
