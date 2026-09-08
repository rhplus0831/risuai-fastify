import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sidebarKeyboardMocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertInput: vi.fn(),
  alertSelect: vi.fn(),
  navigate: vi.fn(),
  selectSingleFile: vi.fn(),
  updateCharacterOrderFolderWithOutcome: vi.fn((): any => ({
    applied: true,
    settlement: Promise.resolve({ status: 'accepted', result: { status: 'ok' } }),
  })),
}))

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

vi.mock('src/ts/gui/tooltip', () => ({
  tooltipRight: () => ({
    destroy: vi.fn(),
    update: vi.fn(),
  }),
}))

vi.mock('src/ts/router', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/router')>()
  return {
    ...actual,
    navigate: sidebarKeyboardMocks.navigate,
  }
})

vi.mock('src/ts/alert', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/alert')>()
  return {
    ...actual,
    alertConfirm: sidebarKeyboardMocks.alertConfirm,
    alertInput: sidebarKeyboardMocks.alertInput,
    alertSelect: sidebarKeyboardMocks.alertSelect,
  }
})

vi.mock('src/ts/characterCommands', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/characterCommands')>()
  return {
    ...actual,
    updateCharacterOrderFolderWithOutcome: sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome,
  }
})

vi.mock('src/ts/util', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/util')>()
  return {
    ...actual,
  }
})

vi.mock('src/ts/filePicker', () => ({
  selectSingleFile: sidebarKeyboardMocks.selectSingleFile,
}))

import Sidebar from './Sidebar.svelte'
import { language } from 'src/lang'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { botMakerMode, DynamicGUI, PlaygroundStore, selectedCharID, settingsOpen } from 'src/ts/stores.svelte'
import { charactersResourceState, settingsResourceState } from 'src/ts/server/resourceState.svelte'
import {
  beginChatGenerationActivity,
  resetChatGenerationActivitiesForTests,
} from 'src/ts/process/generationActivity.svelte'
import { markChatUnread, resetChatUnreadForTests } from 'src/ts/process/chatUnread.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function seedSidebarDatabase(options: { enableDevTools?: boolean } = {}) {
  setDatabaseLite({
    characterOrder: ['char-a'],
    characters: [
      {
        chaId: 'char-a',
        name: 'Alpha',
        image: '',
        chatPage: 0,
        chats: [],
      },
    ],
    hamburgerButtonBottom: false,
    menuSideBar: false,
    roundIcons: false,
    enableDevTools: options.enableDevTools ?? false,
  } as never)
}

function seedPinnedSidebarDatabase() {
  setDatabaseLite({
    characterOrder: ['char-a'],
    characters: [
      {
        chaId: 'char-a',
        name: 'Alpha',
        image: '',
        chatPage: 0,
        chats: [{ id: 'chat-a', name: 'Pinned Alpha', pinned: true, message: [] }],
      },
    ],
    hamburgerButtonBottom: false,
    menuSideBar: false,
    roundIcons: false,
  } as never)
}

function seedGeneratingSidebarDatabase() {
  seedPinnedSidebarDatabase()
  beginChatGenerationActivity({
    target: {
      selectedCharID: 0,
      chatPage: 0,
      characterId: 'char-a',
      chatId: 'chat-a',
    },
    kind: 'message',
  })
}

function seedFolderSidebarDatabase(
  order: readonly ('folder-a' | 'folder-b')[] = ['folder-a', 'folder-b'],
  askBeforeOpening = false,
) {
  const folders = {
    'folder-a': {
      id: 'folder-a',
      name: 'Folder A',
      color: 'blue',
      data: ['char-a'],
      askBeforeOpening,
    },
    'folder-b': {
      id: 'folder-b',
      name: 'Folder B',
      color: 'green',
      data: ['char-b'],
    },
  }

  setDatabaseLite({
    characterOrder: order.map((folderId) => folders[folderId]),
    characters: [
      {
        chaId: 'char-a',
        name: 'Alpha',
        image: '',
        chatPage: 0,
        chats: [],
      },
      {
        chaId: 'char-b',
        name: 'Beta',
        image: '',
        chatPage: 0,
        chats: [],
      },
    ],
    hamburgerButtonBottom: false,
    menuSideBar: false,
    roundIcons: false,
    showFolderName: true,
  } as never)
}

function openFolderContextMenu(folderName: string) {
  const folder = target.querySelector<HTMLElement>(`button[aria-label="${folderName}"]`)
  expect(folder).toBeTruthy()
  folder!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  vi.clearAllMocks()
  selectedCharID.set(-1)
  settingsOpen.set(false)
  PlaygroundStore.set(0)
  DynamicGUI.set(false)
  botMakerMode.set(false)
  resetChatGenerationActivitiesForTests()
  resetChatUnreadForTests()
  seedSidebarDatabase()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  document.body.innerHTML = ''
  selectedCharID.set(-1)
  setDatabaseLite({} as never)
  resetChatGenerationActivitiesForTests()
  resetChatUnreadForTests()
})

describe('Sidebar character keyboard activation', () => {
  it('prefetches a desktop character on pointer or keyboard intent', async () => {
    const prefetchCharacter = vi.fn()
    component = mount(Sidebar, { target, props: { prefetchCharacter } })
    await tick()

    const character = target.querySelector<HTMLElement>('[data-char-id="char-a"]')
    const row = character?.closest<HTMLElement>('[role="listitem"]')
    expect(character).toBeTruthy()
    expect(row).toBeTruthy()

    row?.dispatchEvent(new Event('pointerenter'))
    character?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(prefetchCharacter).toHaveBeenNthCalledWith(1, 'char-a')
    expect(prefetchCharacter).toHaveBeenNthCalledWith(2, 'char-a')
  })

  it('shows every character even when retired Mood Light metadata is still present', async () => {
    setDatabaseLite({
      characterOrder: ['char-private', 'char-normal'],
      characters: [
        { chaId: 'char-private', name: 'Private', image: '', chatPage: 0, chats: [] },
        { chaId: 'char-normal', name: 'Normal', image: '', chatPage: 0, chats: [] },
      ],
      moodLightMembership: { characterIds: ['char-private'], folders: [] },
      hamburgerButtonBottom: false,
      menuSideBar: false,
      roundIcons: false,
    } as never)
    component = mount(Sidebar, { target })
    await tick()

    expect(target.querySelector('[data-char-id="char-private"]')).toBeTruthy()
    expect(target.querySelector('[data-char-id="char-normal"]')).toBeTruthy()
  })

  it('keeps resident owner settings and characters while loading, then fails closed on resource errors', async () => {
    seedPinnedSidebarDatabase()
    settingsResourceState.value.enableDevTools = true
    settingsResourceState.status = 'loading'
    charactersResourceState.status = 'loading'
    selectedCharID.set(0)

    component = mount(Sidebar, { target })
    await tick()

    expect(target.querySelector('[data-char-id="char-a"]')).toBeTruthy()
    expect(target.querySelector('[data-risu-pinned-chat="chat-a"]')).toBeTruthy()
    expect(target.querySelector(`[aria-label="${language.enableDevTools}"]`)).toBeTruthy()

    settingsResourceState.status = 'error'
    charactersResourceState.status = 'error'
    await tick()

    expect(target.querySelector('[data-char-id]')).toBeNull()
    expect(target.querySelector('[data-risu-pinned-chat]')).toBeNull()
    expect(target.querySelector(`[aria-label="${language.enableDevTools}"]`)).toBeNull()
  })

  it('fails closed when the ready character order repeats a stable character ID', async () => {
    seedPinnedSidebarDatabase()
    charactersResourceState.characterOrder = ['char-a', 'char-a']

    component = mount(Sidebar, { target })
    await tick()

    expect(target.querySelector('[data-char-id]')).toBeNull()
    expect(target.querySelector('[data-risu-pinned-chat]')).toBeNull()
  })

  it('names and exposes the state of the developer tools tab', async () => {
    seedSidebarDatabase({ enableDevTools: true })
    selectedCharID.set(0)
    component = mount(Sidebar, { target })
    await tick()

    const developerTools = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.enableDevTools}"]`)
    expect(developerTools).toBeTruthy()
    expect(developerTools!.getAttribute('aria-pressed')).toBe('false')

    developerTools!.click()
    await tick()

    expect(developerTools!.getAttribute('aria-pressed')).toBe('true')
  })

  it('does not expose an empty ghost button above the sidebar content', async () => {
    component = mount(Sidebar, { target })
    await tick()

    const sidebarPanel = target.querySelector<HTMLElement>('.setting-area')
    expect(sidebarPanel).toBeTruthy()
    expect(sidebarPanel!.querySelector(':scope > button')).toBeNull()
  })

  it('exposes one avatar tab stop and activates it with Space', async () => {
    component = mount(Sidebar, { target })
    await tick()

    const avatar = target.querySelector<HTMLElement>('[data-char-id="char-a"]')
    expect(avatar).toBeTruthy()
    const row = avatar!.closest<HTMLElement>('[draggable="true"]')
    expect(row).toBeTruthy()
    expect(row!.querySelectorAll('button[tabindex="0"]')).toHaveLength(1)

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    avatar!.dispatchEvent(space)
    await tick()

    expect(space.defaultPrevented).toBe(true)
    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledWith('/character/char-a')
  })

  it('makes obscured character controls inert while preserving hamburger menu focus targets', async () => {
    component = mount(Sidebar, { target })
    await tick()

    const menuButton = target.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')
    const characterControls = target.querySelector<HTMLElement>('[data-risu-sidebar-character-controls]')
    const avatar = target.querySelector<HTMLElement>('[data-char-id="char-a"]')
    expect(menuButton).toBeTruthy()
    expect(characterControls).toBeTruthy()
    expect(avatar).toBeTruthy()
    expect(characterControls!.hasAttribute('inert')).toBe(false)

    menuButton!.click()
    await tick()

    const settingsButton = target.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')
    expect(menuButton!.getAttribute('aria-expanded')).toBe('true')
    expect(characterControls!.hasAttribute('inert')).toBe(true)
    expect(avatar!.closest('[inert]')).toBe(characterControls)
    expect(settingsButton).toBeTruthy()
    expect(settingsButton!.closest('[inert]')).toBeNull()
    expect(settingsButton!.tabIndex).toBe(0)

    menuButton!.click()
    await tick()

    expect(menuButton!.getAttribute('aria-expanded')).toBe('false')
    expect(characterControls!.hasAttribute('inert')).toBe(false)
  })

  it('makes pinned chats inert with the narrow menu and restores focus and activation afterward', async () => {
    seedPinnedSidebarDatabase()
    component = mount(Sidebar, { target })
    await tick()

    const menuButton = target.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')
    const pinnedRail = target.querySelector<HTMLElement>('[data-risu-pinned-chats]')
    const pinnedChat = target.querySelector<HTMLElement>('[data-risu-pinned-chat="chat-a"]')
    const pinnedAvatar = pinnedChat?.querySelector<HTMLElement>('button')
    expect(menuButton).toBeTruthy()
    expect(pinnedRail).toBeTruthy()
    expect(pinnedAvatar).toBeTruthy()

    pinnedAvatar!.focus()
    expect(document.activeElement).toBe(pinnedAvatar)
    pinnedAvatar!.click()
    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledTimes(1)
    expect(sidebarKeyboardMocks.navigate).toHaveBeenLastCalledWith('/character/char-a/chat-a')

    sidebarKeyboardMocks.navigate.mockClear()
    menuButton!.focus()
    menuButton!.click()
    await tick()

    expect(menuButton!.getAttribute('aria-expanded')).toBe('true')
    expect(pinnedRail!.hasAttribute('inert')).toBe(true)
    expect(pinnedAvatar!.closest('[inert]')).toBe(pinnedRail)
    expect(document.activeElement).toBe(menuButton)
    pinnedAvatar!.click()
    expect(sidebarKeyboardMocks.navigate).not.toHaveBeenCalled()

    menuButton!.click()
    await tick()

    expect(menuButton!.getAttribute('aria-expanded')).toBe('false')
    expect(pinnedRail!.hasAttribute('inert')).toBe(false)
    expect(pinnedAvatar!.closest('[inert]')).toBeNull()
    pinnedAvatar!.focus()
    expect(document.activeElement).toBe(pinnedAvatar)
    pinnedAvatar!.click()
    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledTimes(1)
    expect(sidebarKeyboardMocks.navigate).toHaveBeenLastCalledWith('/character/char-a/chat-a')
  })
})

describe('Sidebar generation indicator pointer activation', () => {
  it('activates the character exactly once when its generation indicator is clicked', async () => {
    seedGeneratingSidebarDatabase()
    component = mount(Sidebar, { target })
    await tick()

    const avatar = target.querySelector<HTMLElement>('[data-char-id="char-a"]')
    const row = avatar?.closest<HTMLElement>('[draggable="true"]')
    const indicator = row?.querySelector<HTMLElement>('[data-risu-generation-indicator]')
    expect(indicator).toBeTruthy()
    expect(indicator!.getAttribute('role')).toBe('status')
    expect(indicator!.getAttribute('title')).toBe(`${language.generatingMessage}: Alpha`)

    indicator!.click()
    await tick()

    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledTimes(1)
    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledWith('/character/char-a')
  })

  it('activates the pinned chat exactly once when its generation indicator is clicked', async () => {
    seedGeneratingSidebarDatabase()
    component = mount(Sidebar, { target })
    await tick()

    const pinnedChat = target.querySelector<HTMLElement>('[data-risu-pinned-chat="chat-a"]')
    const indicator = pinnedChat?.querySelector<HTMLElement>('[data-risu-generation-indicator]')
    expect(indicator).toBeTruthy()
    expect(indicator!.getAttribute('role')).toBe('status')
    expect(indicator!.getAttribute('title')).toBe(`${language.generatingMessage}: Pinned Alpha`)

    indicator!.click()
    await tick()

    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledTimes(1)
    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledWith('/character/char-a/chat-a')
  })
})

describe('Sidebar unread indicator pointer activation', () => {
  it('uses ready owner chat rows when the aggregate character row is stale', async () => {
    seedPinnedSidebarDatabase()
    const staleAggregate = getResourceDatabase().characters
    charactersResourceState.characters = [
      {
        ...staleAggregate[0],
        name: 'Owner Alpha',
        chats: [{ id: 'chat-a', name: 'Owner pinned', pinned: true, message: [] }],
      },
    ] as any
    staleAggregate[0].chats = []
    markChatUnread('chat-a')

    component = mount(Sidebar, { target })
    await tick()

    expect(target.querySelector('[data-risu-pinned-chat="chat-a"]')).toBeTruthy()
    const avatar = target.querySelector<HTMLElement>('[data-char-id="char-a"]')
    const characterRow = avatar?.closest<HTMLElement>('[draggable="true"]')
    expect(characterRow?.querySelector('[data-risu-unread-indicator]')?.getAttribute('title')).toBe(
      `${language.newMessage}: Owner Alpha`,
    )
  })

  it('fails closed for duplicate ready owner IDs instead of using ambiguous chat rows', async () => {
    seedPinnedSidebarDatabase()
    charactersResourceState.characters = [
      { ...getResourceDatabase().characters[0], chats: [{ id: 'chat-a', pinned: true, message: [] }] },
      { ...getResourceDatabase().characters[0], chats: [{ id: 'chat-b', pinned: true, message: [] }] },
    ] as any

    component = mount(Sidebar, { target })
    await tick()

    expect(target.querySelector('[data-risu-pinned-chat]')).toBeNull()
    expect(target.querySelector('[data-char-id]')).toBeNull()
  })

  it('fails closed for duplicate ready chat IDs instead of rendering ambiguous pinned routes', async () => {
    seedPinnedSidebarDatabase()
    charactersResourceState.characters[0].chats = [
      { id: 'chat-a', name: 'First pinned', pinned: true, message: [] },
      { id: 'chat-a', name: 'Second pinned', pinned: true, message: [] },
    ] as any

    component = mount(Sidebar, { target })
    await tick()

    expect(target.querySelector('[data-risu-pinned-chat]')).toBeNull()
  })

  it('aggregates unread state onto the character and the exact pinned chat', async () => {
    seedPinnedSidebarDatabase()
    markChatUnread('chat-a')
    component = mount(Sidebar, { target })
    await tick()

    const avatar = target.querySelector<HTMLElement>('[data-char-id="char-a"]')
    const characterRow = avatar?.closest<HTMLElement>('[draggable="true"]')
    const characterIndicator = characterRow?.querySelector<HTMLElement>('[data-risu-unread-indicator]')
    const pinnedIndicator = target.querySelector<HTMLElement>(
      '[data-risu-pinned-chat="chat-a"] [data-risu-unread-indicator]',
    )
    expect(characterIndicator?.getAttribute('title')).toBe(`${language.newMessage}: Alpha`)
    expect(pinnedIndicator?.getAttribute('title')).toBe(`${language.newMessage}: Pinned Alpha`)

    pinnedIndicator!.click()
    await tick()

    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledOnce()
    expect(sidebarKeyboardMocks.navigate).toHaveBeenCalledWith('/character/char-a/chat-a')
    expect(target.querySelector('[data-risu-unread-indicator]')).toBeNull()
  })
})

describe('Sidebar character folder context menu', () => {
  beforeEach(async () => {
    seedFolderSidebarDatabase()
    component = mount(Sidebar, { target })
    await tick()
  })

  it('cancels color selection without submitting an undefined color', async () => {
    sidebarKeyboardMocks.alertSelect.mockResolvedValueOnce('1').mockResolvedValueOnce(null)

    openFolderContextMenu('Folder A')

    await vi.waitFor(() => expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledTimes(2))
    await tick()

    expect(sidebarKeyboardMocks.alertSelect.mock.calls[1][0]).toHaveLength(8)
    expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).not.toHaveBeenCalled()
  })

  it('persists the Ask before opening option for the selected folder', async () => {
    sidebarKeyboardMocks.alertSelect.mockResolvedValueOnce('3')

    openFolderContextMenu('Folder A')

    await vi.waitFor(() =>
      expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).toHaveBeenCalledWith('folder-a', {
        askBeforeOpening: true,
      }),
    )
    expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledWith(
      expect.arrayContaining([language.askBeforeOpening(false)]),
      language.folderActionsFor('Folder A'),
    )
  })

  it('asks once after confirmation and asks again after cancellation', async () => {
    unmount(component!)
    component = undefined
    seedFolderSidebarDatabase(['folder-a', 'folder-b'], true)
    component = mount(Sidebar, { target })
    await tick()

    const folder = target.querySelector<HTMLElement>('button[aria-label="Folder A"]')
    expect(folder).toBeTruthy()
    expect(target.querySelector('[data-char-id="char-a"]')).toBeNull()

    sidebarKeyboardMocks.alertConfirm.mockResolvedValueOnce(false)
    folder!.click()
    await vi.waitFor(() => expect(sidebarKeyboardMocks.alertConfirm).toHaveBeenCalledTimes(1))
    expect(target.querySelector('[data-char-id="char-a"]')).toBeNull()

    sidebarKeyboardMocks.alertConfirm.mockResolvedValueOnce(true)
    folder!.click()
    await vi.waitFor(() => expect(target.querySelector('[data-char-id="char-a"]')).toBeTruthy())
    expect(sidebarKeyboardMocks.alertConfirm).toHaveBeenCalledTimes(2)
    expect(sidebarKeyboardMocks.alertConfirm).toHaveBeenLastCalledWith(language.confirmFolderOpening('Folder A'))

    folder!.click()
    await vi.waitFor(() => expect(target.querySelector('[data-char-id="char-a"]')).toBeNull())
    folder!.click()
    await vi.waitFor(() => expect(target.querySelector('[data-char-id="char-a"]')).toBeTruthy())
    expect(sidebarKeyboardMocks.alertConfirm).toHaveBeenCalledTimes(2)
  })

  it('ignores an invalid nested color selection', async () => {
    sidebarKeyboardMocks.alertSelect.mockResolvedValueOnce('1').mockResolvedValueOnce('not-an-index')

    openFolderContextMenu('Folder A')

    await vi.waitFor(() => expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledTimes(2))
    await tick()

    expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).not.toHaveBeenCalled()
  })

  it('cancels image selection without resetting or opening the file picker', async () => {
    sidebarKeyboardMocks.alertSelect.mockResolvedValueOnce('2').mockResolvedValueOnce(null)

    openFolderContextMenu('Folder A')

    await vi.waitFor(() => expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledTimes(2))
    await tick()

    expect(sidebarKeyboardMocks.alertSelect.mock.calls[1][0]).toHaveLength(2)
    expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).not.toHaveBeenCalled()
    expect(sidebarKeyboardMocks.selectSingleFile).not.toHaveBeenCalled()
  })

  it('keeps a delayed color change bound to the originally opened folder after reorder', async () => {
    const outerSelection = deferred<string>()
    sidebarKeyboardMocks.alertSelect.mockReturnValueOnce(outerSelection.promise).mockResolvedValueOnce('0')

    openFolderContextMenu('Folder A')
    await vi.waitFor(() => expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledTimes(1))

    seedFolderSidebarDatabase(['folder-b', 'folder-a'])
    await tick()
    expect(target.querySelector('button[aria-label="Folder B"]')).toBeTruthy()

    outerSelection.resolve('1')

    await vi.waitFor(() => expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).toHaveBeenCalledTimes(1))
    expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).toHaveBeenCalledWith('folder-a', {
      color: 'red',
    })
  })

  it('keeps a folder change pending through classification, serializes that folder, and labels a queued result', async () => {
    const settlement = deferred<any>()
    sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome.mockReturnValueOnce({
      applied: true,
      settlement: settlement.promise,
    })
    sidebarKeyboardMocks.alertSelect.mockResolvedValueOnce('1').mockResolvedValueOnce('0')

    openFolderContextMenu('Folder A')
    await vi.waitFor(() => expect(sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome).toHaveBeenCalledTimes(1))
    await tick()

    const folderAvatar = target.querySelector<HTMLElement>('button[aria-label="Folder A"]')
    const folderRow = folderAvatar?.closest<HTMLElement>('[role="listitem"]')
    expect(folderRow?.getAttribute('aria-busy')).toBe('true')
    expect(folderRow?.getAttribute('draggable')).toBe('false')
    expect(
      target.querySelector('[data-risu-character-organization-key][data-risu-character-organization-status="pending"]'),
    ).toBeNull()

    openFolderContextMenu('Folder A')
    await tick()
    expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledTimes(2)

    openFolderContextMenu('Folder B')
    await vi.waitFor(() => expect(sidebarKeyboardMocks.alertSelect).toHaveBeenCalledTimes(3))

    settlement.resolve({ status: 'queued', result: { status: 'unavailable' } })
    await tick()
    await tick()

    expect(
      target.querySelector('[data-risu-character-organization-key][data-risu-character-organization-status="queued"]'),
    ).toBeNull()
    expect(folderRow?.getAttribute('draggable')).toBe('true')
  })

  it('labels a terminal folder-organization failure after settlement', async () => {
    sidebarKeyboardMocks.updateCharacterOrderFolderWithOutcome.mockReturnValueOnce({
      applied: true,
      settlement: Promise.resolve({ status: 'failed', result: { status: 'error', error: 'rejected' } }),
    })
    sidebarKeyboardMocks.alertSelect.mockResolvedValueOnce('0')
    sidebarKeyboardMocks.alertInput.mockResolvedValueOnce('Renamed A')

    openFolderContextMenu('Folder A')

    await vi.waitFor(() => {
      expect(target.querySelector('[data-risu-character-organization-status="failed"]')?.textContent).toContain(
        language.mutationStatusFailed,
      )
    })
  })
})
