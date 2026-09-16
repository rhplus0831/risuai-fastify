import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the parent selection, request effects, and lazy modal real; unrelated chat rendering is out of scope.
vi.mock('./DefaultChatScreen.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./ChatScreenLayout.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./ResizeBox.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./TransitionImage.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./BackgroundDom.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('../UI/GUI/SideBarArrow.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./CharacterShellHydrationGate.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./BardWikiWorkspace.svelte', () => import('./ChatScreen.testWorkspace.svelte'))

import ChatScreen from './ChatScreen.svelte'
import { bardWikiWorkspaceOpenRequest, selectedCharID } from 'src/ts/stores.svelte'
import {
  charactersResourceState,
  settingsResourceState,
  resetServerResourceState,
} from 'src/ts/server/resourceState.svelte'
import type { character } from 'src/ts/storage/database.svelte'

let component: ReturnType<typeof mount> | undefined
let target: HTMLDivElement
const workspace = () => target.querySelector('[aria-label="Test BardWiki workspace"]')

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await tick()
    assertion()
  })
}

beforeEach(() => {
  resetServerResourceState()
  charactersResourceState.status = 'ready'
  charactersResourceState.currentChar = 0
  charactersResourceState.characters = [
    { chaId: 'character-a', chatPage: 0, viewScreen: 'none', chats: [{ id: 'chat-a' }, { id: 'chat-b' }] } as character,
  ]
  settingsResourceState.groupStatuses.advanced = 'ready'
  settingsResourceState.value.useBardWiki = true
  selectedCharID.set(0)
  bardWikiWorkspaceOpenRequest.set(null)
  target = document.createElement('div')
  document.body.append(target)
  component = mount(ChatScreen, { target })
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  target.remove()
  bardWikiWorkspaceOpenRequest.set(null)
  selectedCharID.set(-1)
  resetServerResourceState()
})

async function openWorkspace(): Promise<void> {
  bardWikiWorkspaceOpenRequest.set({ characterId: 'character-a', chatId: 'chat-a' })
  await waitFor(() => expect(workspace()?.getAttribute('data-chat-id')).toBe('chat-a'))
}

describe('ChatScreen BardWiki integration', () => {
  it('opens the requested chat lazily, consumes the request, and stays closed after dismissal', async () => {
    await tick()
    expect(target.querySelector('[data-risu-lazy-surface="bardwiki-workspace"]')).toBeNull()
    await openWorkspace()
    expect(get(bardWikiWorkspaceOpenRequest)).toBeNull()
    workspace()!.querySelector<HTMLButtonElement>('button')!.click()
    await waitFor(() => expect(workspace()).toBeNull())
    expect(get(bardWikiWorkspaceOpenRequest)).toBeNull()
  })

  it.each([
    { characterId: 'other-character', chatId: 'chat-a' },
    { characterId: 'character-a', chatId: 'chat-b' },
  ])('retains an unmatched request $characterId / $chatId without opening', async (request) => {
    bardWikiWorkspaceOpenRequest.set(request)
    await tick()
    expect(workspace()).toBeNull()
    expect(target.querySelector('[data-risu-lazy-surface="bardwiki-workspace"]')).toBeNull()
    expect(get(bardWikiWorkspaceOpenRequest)).toEqual(request)
  })

  it('closes chat A on selection change and can subsequently open chat B', async () => {
    await openWorkspace()
    charactersResourceState.characters[0]!.chatPage = 1
    await waitFor(() => expect(workspace()).toBeNull())
    bardWikiWorkspaceOpenRequest.set({ characterId: 'character-a', chatId: 'chat-b' })
    await waitFor(() => expect(workspace()?.getAttribute('data-chat-id')).toBe('chat-b'))
  })

  it.each(['disabled', 'unready', 'invalid chat'] as const)('closes an open workspace when %s', async (reason) => {
    await openWorkspace()
    if (reason === 'disabled') settingsResourceState.value.useBardWiki = false
    else if (reason === 'unready') settingsResourceState.groupStatuses.advanced = 'loading'
    else charactersResourceState.characters[0]!.chatPage = 9
    await waitFor(() => expect(workspace()).toBeNull())
    bardWikiWorkspaceOpenRequest.set({ characterId: 'character-a', chatId: 'chat-a' })
    await tick()
    expect(target.querySelector('[data-risu-lazy-surface="bardwiki-workspace"]')).toBeNull()
  })
})
