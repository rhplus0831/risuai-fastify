import { mount, tick, unmount } from 'svelte'
import { fromStore } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/ts/gui/tooltip', () => ({
  tooltipRight: () => ({
    destroy: vi.fn(),
    update: vi.fn(),
  }),
}))

vi.mock('src/ts/characterImage', () => ({
  getCharImage: (source: string) => source,
}))

vi.mock('src/ts/router', async () => {
  const { writable } = await import('svelte/store')
  return {
    currentRoute: writable({ kind: 'home', path: '/' }),
  }
})

import PinnedChatsRail from './PinnedChatsRail.svelte'
import { currentRoute } from 'src/ts/router'
const routeView = fromStore(currentRoute)
import type { PinnedChatItem } from './sidebarMultitasking'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

const pinnedChats: readonly PinnedChatItem[] = [
  {
    characterId: 'char-a',
    characterIndex: 0,
    characterName: 'Alpha',
    characterImage: '',
    chatId: 'chat-a',
    chatName: 'Alpha Chat',
  },
  {
    characterId: 'char-b',
    characterIndex: 1,
    characterName: 'Beta',
    characterImage: '',
    chatId: 'chat-b',
    chatName: 'Beta Chat',
  },
]

let component: MountedComponent | undefined
let target: HTMLElement

function setCharacterRoute(characterId: string, chatId?: string): void {
  currentRoute.set({
    kind: 'character',
    path: chatId ? `/character/${characterId}/${chatId}` : `/character/${characterId}`,
    chaId: characterId,
    ...(chatId ? { chatId } : {}),
  })
}

function pinnedRow(chatId: string): HTMLElement {
  const row = target.querySelector<HTMLElement>(`[data-risu-pinned-chat="${chatId}"]`)
  expect(row).toBeTruthy()
  return row!
}

function pinnedAction(chatId: string): HTMLElement {
  const action = pinnedRow(chatId).querySelector<HTMLElement>('button')
  expect(action).toBeTruthy()
  return action!
}

function expectCurrentPinnedChat(chatId: string | null): void {
  const currentRows = target.querySelectorAll('[data-risu-pinned-chat-current="true"]')
  const currentActions = target.querySelectorAll('[aria-current="page"]')
  expect(currentRows).toHaveLength(chatId ? 1 : 0)
  expect(currentActions).toHaveLength(chatId ? 1 : 0)

  for (const item of pinnedChats) {
    const current = item.chatId === chatId
    expect(pinnedRow(item.chatId).dataset.risuPinnedChatCurrent).toBe(current ? 'true' : 'false')
    expect(pinnedRow(item.chatId).classList.contains('bg-selected')).toBe(current)
    expect(pinnedAction(item.chatId).getAttribute('aria-current')).toBe(current ? 'page' : null)
  }
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  currentRoute.set({ kind: 'home', path: '/' })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  currentRoute.set({ kind: 'home', path: '/' })
})

describe('PinnedChatsRail current route', () => {
  it('lays pinned chats out with the requested writer column count', async () => {
    component = mount(PinnedChatsRail, {
      target,
      props: {
        items: pinnedChats,
        selectedCharacterId: null,
        selectedChatId: null,
        resolveImage: (image: string) => image,
        onPrefetch: vi.fn(),
        generatingChatIds: new Set<string>(),
        rounded: false,
        onOpen: vi.fn(),
        columns: 4,
      },
    })
    await tick()

    const rail = target.querySelector<HTMLElement>('[data-risu-pinned-chats]')
    expect(rail?.dataset.risuPinnedChatColumns).toBe('4')
    expect(rail?.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
    expect(rail?.querySelectorAll('[data-risu-pinned-chat]')).toHaveLength(2)
  })

  it('tracks exactly one current pinned chat across chat, character-only, and non-chat routes', async () => {
    setCharacterRoute('char-a', 'chat-a')
    component = mount(PinnedChatsRail, {
      target,
      props: {
        items: pinnedChats,
        get selectedCharacterId() {
          return routeView.current.kind === 'character' ? routeView.current.chaId : null
        },
        get selectedChatId() {
          return routeView.current.kind === 'character' ? (routeView.current.chatId ?? null) : null
        },
        resolveImage: (image: string) => image,
        onPrefetch: vi.fn(),
        generatingChatIds: new Set<string>(),
        rounded: false,
        onOpen: vi.fn(),
      },
    })
    await tick()

    expectCurrentPinnedChat('chat-a')

    setCharacterRoute('char-b', 'chat-b')
    await tick()
    expectCurrentPinnedChat('chat-b')

    setCharacterRoute('char-a')
    await tick()
    expectCurrentPinnedChat(null)

    currentRoute.set({ kind: 'home', path: '/' })
    await tick()
    expectCurrentPinnedChat(null)
  })

  it('renders a warning treatment instead of a healthy spinner for an exhausted chat', async () => {
    const onOpen = vi.fn()
    component = mount(PinnedChatsRail, {
      target,
      props: {
        items: pinnedChats,
        get selectedCharacterId() {
          return routeView.current.kind === 'character' ? routeView.current.chaId : null
        },
        get selectedChatId() {
          return routeView.current.kind === 'character' ? (routeView.current.chatId ?? null) : null
        },
        resolveImage: (image: string) => image,
        onPrefetch: vi.fn(),
        generatingChatIds: new Set(['chat-a', 'chat-b']),
        warningChatIds: new Set(['chat-a']),
        rounded: false,
        onOpen,
      },
    })
    await tick()

    const warning = pinnedRow('chat-a').querySelector<HTMLElement>('[data-risu-generation-indicator="warning"]')
    const healthy = pinnedRow('chat-b').querySelector<HTMLElement>('[data-risu-generation-indicator="generating"]')
    expect(warning).toBeTruthy()
    expect(warning?.getAttribute('role')).toBe('status')
    expect(warning?.getAttribute('aria-label')).toContain('Alpha Chat')
    expect(warning?.querySelector('.animate-spin')).toBeNull()
    expect(healthy).toBeTruthy()
    expect(healthy?.querySelector('.animate-spin')).toBeTruthy()

    warning!.click()
    expect(onOpen).toHaveBeenCalledWith(pinnedChats[0])
  })

  it('prefetches the owning character on pointer and keyboard intent', async () => {
    const onPrefetch = vi.fn()
    component = mount(PinnedChatsRail, {
      target,
      props: {
        items: pinnedChats,
        get selectedCharacterId() {
          return routeView.current.kind === 'character' ? routeView.current.chaId : null
        },
        get selectedChatId() {
          return routeView.current.kind === 'character' ? (routeView.current.chatId ?? null) : null
        },
        resolveImage: (image: string) => image,
        generatingChatIds: new Set<string>(),
        rounded: false,
        onOpen: vi.fn(),
        onPrefetch,
      },
    })
    await tick()

    pinnedRow('chat-a').dispatchEvent(new Event('pointerenter'))
    pinnedAction('chat-b').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(onPrefetch).toHaveBeenNthCalledWith(1, pinnedChats[0])
    expect(onPrefetch).toHaveBeenNthCalledWith(2, pinnedChats[1])
  })

  it('renders an accessible unread indicator for the exact pinned chat', async () => {
    const onOpen = vi.fn()
    component = mount(PinnedChatsRail, {
      target,
      props: {
        items: pinnedChats,
        get selectedCharacterId() {
          return routeView.current.kind === 'character' ? routeView.current.chaId : null
        },
        get selectedChatId() {
          return routeView.current.kind === 'character' ? (routeView.current.chatId ?? null) : null
        },
        resolveImage: (image: string) => image,
        onPrefetch: vi.fn(),
        generatingChatIds: new Set<string>(),
        unreadChatIds: new Set(['chat-b']),
        rounded: false,
        onOpen,
      },
    })
    await tick()

    expect(pinnedRow('chat-a').querySelector('[data-risu-unread-indicator]')).toBeNull()
    const indicator = pinnedRow('chat-b').querySelector<HTMLElement>('[data-risu-unread-indicator]')
    expect(indicator?.getAttribute('role')).toBe('status')
    expect(indicator?.getAttribute('aria-label')).toBe(`${language.newMessage}: Beta Chat`)

    indicator!.click()
    expect(onOpen).toHaveBeenCalledWith(pinnedChats[1])
  })
})
