import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the selection boundary, layout, and hydration gate real; chat internals are outside this contract.
vi.mock('./DefaultChatScreen.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./ResizeBox.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./TransitionImage.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('./BackgroundDom.svelte', () => import('../UI/LazyComponent.testStub.svelte'))
vi.mock('../UI/GUI/SideBarArrow.svelte', () => import('../UI/LazyComponent.testStub.svelte'))

import ChatScreen from './ChatScreen.svelte'
import { language } from 'src/lang'
import { selectedCharID } from 'src/ts/stores.svelte'
import {
  charactersResourceState,
  settingsResourceState,
  resetServerResourceState,
} from 'src/ts/server/resourceState.svelte'
import {
  characterShellHydrationState,
  clearCharacterShellHydrationState,
} from 'src/ts/server/characterShellHydration.svelte'
import { SERVER_CHARACTER_SHELL_MARKER, type character } from 'src/ts/storage/database.svelte'

let component: ReturnType<typeof mount> | undefined
let target: HTMLDivElement

beforeEach(() => {
  resetServerResourceState()
  clearCharacterShellHydrationState()
  charactersResourceState.status = 'ready'
  charactersResourceState.currentChar = 0
  charactersResourceState.characters = [
    {
      [SERVER_CHARACTER_SHELL_MARKER]: true,
      chaId: 'char-a',
      chatPage: 0,
      viewScreen: 'none',
      chats: [{ id: 'chat-a' }],
    } as unknown as character,
  ]
  characterShellHydrationState.rows['char-a'] = { status: 'loading', error: null }
  selectedCharID.set(0)
  target = document.createElement('div')
  document.body.append(target)
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  target.remove()
  selectedCharID.set(-1)
  clearCharacterShellHydrationState()
  resetServerResourceState()
})

describe('ChatScreen character hydration', () => {
  it('replaces the loading gate with the chat layout when character detail arrives', async () => {
    component = mount(ChatScreen, { target })
    await tick()

    expect(target.querySelector('[role="status"]')?.textContent).toContain(language.loadingCharacter)
    expect(target.querySelector('[data-chat-screen-layout]')).toBeNull()

    // Model the service applying a full row, not just changing its request status.
    charactersResourceState.characters[0] = {
      chaId: 'char-a',
      chatPage: 0,
      viewScreen: 'none',
      chats: [{ id: 'chat-a', message: [] }],
    } as unknown as character
    characterShellHydrationState.rows['char-a'] = { status: 'ready', error: null }
    await tick()

    expect(target.querySelector('[role="status"]')).toBeNull()
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(target.querySelector('[data-chat-screen-layout]')).not.toBeNull()
  })

  it.each(['idle', 'loading'] as const)(
    'keeps the retained shell visible while %s, then drops it when readiness has no selected owner',
    async (status) => {
      charactersResourceState.status = status
      charactersResourceState.currentChar = -1
      component = mount(ChatScreen, { target })
      await tick()
      expect(target.querySelector('[role="status"]')?.textContent).toContain(language.loadingCharacter)
      expect(target.querySelector('[data-chat-screen-layout]')).toBeNull()

      // The view index still points at a retained row, but the ready resource has no selected owner.
      charactersResourceState.status = 'ready'
      await tick()
      expect(target.querySelector('[role="status"]')).toBeNull()
      expect(target.querySelector('[data-chat-screen-layout]')).not.toBeNull()
    },
  )

  it.each(['resource error', 'row error', 'cleared selection'] as const)(
    'removes the retained shell gate after %s and restores it on recovery',
    async (reason) => {
      component = mount(ChatScreen, { target })
      await tick()
      expect(target.querySelector('[role="status"]')?.textContent).toContain(language.loadingCharacter)

      if (reason === 'resource error') charactersResourceState.status = 'error'
      else if (reason === 'row error') charactersResourceState.rowStatuses['char-a'] = 'error'
      else selectedCharID.set(-1)
      await tick()
      expect(target.querySelector('[role="status"]')).toBeNull()
      expect(target.querySelector('[data-chat-screen-layout]')).not.toBeNull()

      charactersResourceState.status = 'ready'
      charactersResourceState.rowStatuses['char-a'] = 'ready'
      selectedCharID.set(0)
      await tick()
      expect(target.querySelector('[role="status"]')?.textContent).toContain(language.loadingCharacter)
      expect(target.querySelector('[data-chat-screen-layout]')).toBeNull()
    },
  )

  it('updates the rendered layout when authoritative display settings change', async () => {
    selectedCharID.set(-1)
    settingsResourceState.groupStatuses.display = 'ready'
    settingsResourceState.value.theme = 'waifu'
    component = mount(ChatScreen, { target })
    await tick()
    expect(target.querySelector('[data-chat-screen-layout]')?.getAttribute('data-chat-screen-layout')).toBe('waifu')

    settingsResourceState.value.theme = 'waifuMobile'
    await tick()
    expect(target.querySelector('[data-chat-screen-layout]')?.getAttribute('data-chat-screen-layout')).toBe(
      'waifuMobile',
    )
  })
})
