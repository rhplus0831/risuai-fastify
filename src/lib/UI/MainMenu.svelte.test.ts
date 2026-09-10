import { get, type Writable } from 'svelte/store'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mainMenuMocks = vi.hoisted(() => ({
  settings: {
    language: 'en',
    doNotWarnExternalServers: true,
    roundIcons: false,
  },
  characterOrder: ['character-a', 'character-b', 'character-trash', '§playground'],
  characters: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
  openGridRoute: vi.fn(),
  markChatRead: vi.fn(),
  alertConfirm: vi.fn(async () => true),
}))

vi.mock('src/ts/server/resourceState.svelte', () => ({
  charactersResourceState: {
    characters: mainMenuMocks.characters,
    characterOrder: mainMenuMocks.characterOrder,
    status: 'ready',
    listRevision: 1,
    orderRevision: 1,
    rowStatuses: {},
  },
  settingsResourceState: {
    value: mainMenuMocks.settings,
    status: 'ready',
    shellRevision: 1,
    groupStatuses: {},
  },
}))

vi.mock('src/ts/stores.svelte', async () => {
  const { writable } = await import('svelte/store')
  return { OpenRealmStore: writable(false) }
})

vi.mock('src/ts/characterImage', () => ({
  getCharImage: vi.fn(async (source: string) => (source ? `/assets/${source}` : '/none.webp')),
}))

vi.mock('src/ts/router', () => ({
  characterRoutePath: (characterId: string, chatId?: string) =>
    chatId ? `/character/${characterId}/${chatId}` : `/character/${characterId}`,
  navigate: mainMenuMocks.navigate,
  openGridRoute: mainMenuMocks.openGridRoute,
}))

vi.mock('src/ts/process/generationActivity.svelte', async () => {
  const { writable } = await import('svelte/store')
  return {
    activeChatGenerations: writable([{ chatId: 'pinned-3', kind: 'message' }]),
  }
})

vi.mock('src/ts/process/reattach', async () => {
  const { writable } = await import('svelte/store')
  return {
    activeGenerationJobs: writable([{ chatId: 'pinned-2' }]),
    generationJobLifecycles: writable({ warning: { chatId: 'pinned-2', status: 'exhausted-dead' } }),
  }
})

vi.mock('src/ts/process/chatUnread.svelte', async () => {
  const { writable } = await import('svelte/store')
  return {
    unreadChatIds: writable(new Set(['pinned-4'])),
    markChatRead: mainMenuMocks.markChatRead,
  }
})

vi.mock('src/ts/globalApi.svelte', () => ({
  getVersionString: () => 'test-version',
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: mainMenuMocks.alertConfirm,
}))

vi.mock('./Realm/RealmMain.svelte', () => ({ default: () => {} }))
vi.mock('./Title.svelte', () => ({ default: () => {} }))

import MainMenu from './MainMenu.svelte'
import { changeLanguage, language } from 'src/lang'
import { OpenRealmStore } from 'src/ts/stores.svelte'
import { charactersResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function chat(id: string, name: string, pinned = false) {
  return { id, name, pinned }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  changeLanguage('en')
  mainMenuMocks.navigate.mockReset()
  mainMenuMocks.openGridRoute.mockReset()
  mainMenuMocks.markChatRead.mockReset()
  mainMenuMocks.alertConfirm.mockClear()
  ;(OpenRealmStore as Writable<boolean>).set(false)
  mainMenuMocks.settings.language = 'en'
  mainMenuMocks.settings.doNotWarnExternalServers = true
  mainMenuMocks.settings.roundIcons = false
  mainMenuMocks.characterOrder = ['character-a', 'character-b', 'character-trash', '§playground']
  mainMenuMocks.characters = [
    {
      chaId: 'character-a',
      name: 'Character A',
      image: 'a.webp',
      lastInteraction: Date.now() - 60_000,
      chatPage: 0,
      chats: Array.from({ length: 7 }, (_, index) => chat(`pinned-${index + 1}`, `Pinned ${index + 1}`, true)),
    },
    {
      chaId: 'character-b',
      name: 'Character B',
      image: 'b.webp',
      lastInteraction: Date.now() - 30_000,
      chatPage: 1,
      chats: [chat('b-first', 'First'), chat('b-active', 'Active')],
    },
    {
      chaId: 'character-trash',
      name: 'Trashed',
      lastInteraction: Date.now(),
      trashTime: 1,
      chatPage: 0,
      chats: [],
    },
    {
      chaId: '§playground',
      name: 'Playground',
      lastInteraction: Date.now(),
      chatPage: 0,
      chats: [],
    },
  ]
  charactersResourceState.characters = mainMenuMocks.characters as any
  charactersResourceState.characterOrder = mainMenuMocks.characterOrder as any
  charactersResourceState.status = 'ready'
  charactersResourceState.listRevision = 1
  charactersResourceState.orderRevision = 1
  charactersResourceState.rowStatuses = Object.fromEntries(
    mainMenuMocks.characters.map((character) => [character.chaId, 'ready']),
  ) as any
  settingsResourceState.value = mainMenuMocks.settings as any
  settingsResourceState.status = 'ready'
  settingsResourceState.shellRevision = 1
  settingsResourceState.groupStatuses = {}
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  vi.clearAllTimers()
  vi.useRealTimers()
  target.remove()
})

describe('MainMenu home dashboard', () => {
  it('uses ready owner rows for pinned and recent chat navigation', async () => {
    charactersResourceState.characters = mainMenuMocks.characters.map((character, index) =>
      index === 0 ? { ...character, name: 'Owner A', chats: [chat('pinned-1', 'Owner pinned', true)] } : character,
    ) as any

    component = mount(MainMenu, { target })
    await tick()

    expect(target.querySelector('[data-risu-home-pinned-chat="pinned-1"]')?.textContent).toContain('Owner A')
    expect(target.querySelector('[data-risu-home-recent-character="character-a"]')?.textContent).toContain('Owner A')
  })

  it('fails closed for duplicate ready owner IDs instead of rendering ambiguous chat rows', async () => {
    const owner = mainMenuMocks.characters[0]
    charactersResourceState.characters = [
      { ...owner, chats: [chat('pinned-1', 'First', true)] },
      { ...owner, chats: [chat('pinned-2', 'Second', true)] },
    ] as any
    charactersResourceState.characterOrder = ['character-a'] as any

    component = mount(MainMenu, { target })
    await tick()

    expect(target.querySelector('[data-risu-home-pinned-chat]')).toBeNull()
    expect(target.querySelector('[data-risu-home-recent-character]')).toBeNull()
  })

  it('keeps revisioned owner rows visible while the collection and shell groups refresh', async () => {
    charactersResourceState.status = 'loading'
    settingsResourceState.groupStatuses = {
      language: 'loading',
      advanced: 'loading',
      display: 'loading',
    }
    mainMenuMocks.settings.roundIcons = true

    component = mount(MainMenu, { target })
    await tick()

    expect(target.querySelectorAll('[data-risu-home-pinned-chat]')).toHaveLength(6)
    expect(target.querySelector('[data-risu-home-recent-character="character-b"]')).toBeTruthy()
    expect(target.querySelector('[data-risu-home-pinned-chat] img')?.classList).toContain('rounded-full')
  })

  it('fails closed when the character collection owner is missing', async () => {
    charactersResourceState.listRevision = null

    component = mount(MainMenu, { target })
    await tick()

    expect(target.querySelector('[data-risu-home-pinned-chat]')).toBeNull()
    expect(target.querySelector('[data-risu-home-recent-character]')).toBeNull()
  })

  it('fails closed when the character collection owner errors', async () => {
    charactersResourceState.status = 'error'

    component = mount(MainMenu, { target })
    await tick()

    expect(target.querySelector('[data-risu-home-pinned-chat]')).toBeNull()
    expect(target.querySelector('[data-risu-home-recent-character]')).toBeNull()
  })

  it('renders resumable pinned chats and recent characters in priority order', async () => {
    component = mount(MainMenu, { target })
    await tick()

    const sections = Array.from(target.querySelectorAll<HTMLElement>('[data-risu-home-section]')).map(
      (section) => section.dataset.risuHomeSection,
    )
    expect(sections).toEqual(['pinned-chats', 'recent-characters', 'explore'])
    expect(target.querySelectorAll('[data-risu-home-pinned-chat]')).toHaveLength(6)
    expect(target.querySelectorAll('[data-risu-home-recent-character]')).toHaveLength(2)
    expect(target.querySelector('[data-risu-home-recent-character="character-trash"]')).toBeNull()
    expect(target.querySelector('[data-risu-home-recent-character="§playground"]')).toBeNull()

    expect(
      target.querySelector('[data-risu-home-pinned-chat="pinned-2"] [data-risu-generation-indicator="warning"]'),
    ).toBeTruthy()
    expect(
      target.querySelector('[data-risu-home-pinned-chat="pinned-3"] [data-risu-generation-indicator="generating"]'),
    ).toBeTruthy()
    expect(target.querySelector('[data-risu-home-pinned-chat="pinned-4"] [data-risu-unread-indicator]')).toBeTruthy()

    target.querySelector<HTMLButtonElement>('[data-risu-home-pinned-chat="pinned-1"]')!.click()
    expect(mainMenuMocks.markChatRead).toHaveBeenCalledWith('pinned-1')
    expect(mainMenuMocks.navigate).toHaveBeenCalledWith('/character/character-a/pinned-1')

    target.querySelector<HTMLButtonElement>('[data-risu-home-recent-character="character-b"]')!.click()
    expect(mainMenuMocks.navigate).toHaveBeenCalledWith('/character/character-b/b-active')
  })

  it('expands the bounded pinned section and opens the full character catalog', async () => {
    component = mount(MainMenu, { target })
    await tick()

    const expand = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(language.homeShowAllPinnedChats(7)),
    )
    expect(expand).toBeTruthy()
    expect(expand?.getAttribute('aria-expanded')).toBe('false')

    expand!.click()
    await tick()
    expect(target.querySelectorAll('[data-risu-home-pinned-chat]')).toHaveLength(7)
    expect(expand?.getAttribute('aria-expanded')).toBe('true')
    expect(expand?.textContent).toContain(language.homeShowFewerPinnedChats)

    const viewAll = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === language.homeViewAllCharacters,
    )
    viewAll!.click()
    expect(mainMenuMocks.openGridRoute).toHaveBeenCalledOnce()
    expect(get(OpenRealmStore)).toBe(false)
  })

  it('keeps the external-server warning when its settings owner errors', async () => {
    settingsResourceState.groupStatuses.advanced = 'error'

    component = mount(MainMenu, { target })
    await tick()

    const openRealm = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(language.openRisuRealm),
    )
    openRealm!.click()
    expect(mainMenuMocks.alertConfirm).toHaveBeenCalledOnce()
    await tick()
    expect(get(OpenRealmStore)).toBe(true)
  })

  it('uses compact guidance when there is nothing to resume', async () => {
    mainMenuMocks.characters = []
    mainMenuMocks.characterOrder = []
    charactersResourceState.characters = []
    charactersResourceState.characterOrder = []
    charactersResourceState.rowStatuses = {}
    component = mount(MainMenu, { target })
    await tick()

    expect(target.textContent).toContain(language.homePinnedChatsEmpty)
    expect(target.textContent).toContain(language.homeRecentCharactersEmpty)
    expect(target.textContent).toContain(language.openRisuRealm)
  })
})
