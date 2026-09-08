import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import {
  beginClientSession,
  demoteClientSession,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from './clientSession'

const hotkeyNavigationMocks = vi.hoisted(() => ({
  closeSettingsRoute: vi.fn(),
  navigate: vi.fn(),
  openSettingsRoute: vi.fn(),
}))

vi.mock('./router', () => ({
  closeSettingsRoute: hotkeyNavigationMocks.closeSettingsRoute,
  navigate: hotkeyNavigationMocks.navigate,
  openSettingsRoute: hotkeyNavigationMocks.openSettingsRoute,
}))

vi.mock('./process/modules', async (importActual) => {
  const actual = await importActual<typeof import('./process/modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

import { initHotkey } from './hotkey'
import { enterClientWriter, repromoteClientWriter } from './__tests__/clientSession'
import {
  alertCardExport,
  alertConfirm,
  alertPluginConfirm,
  cardExportCancelMessage,
  resolveAlertSelection,
} from './alert'
import { RISU_PRESET_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from './dragTypes'
import {
  alertStore,
  PlaygroundStore,
  QuickSettings,
  selectedCharID,
  settingsOpen,
  openPresetList,
} from './stores.svelte'
import { testDatabaseState } from './__tests__/resourceDatabaseState'
import { registerModuleEditorLeaveGuard } from './moduleEditorLeaveGuard'

async function press(key: string, options: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key,
    ...options,
  })
  document.dispatchEvent(event)
  await Promise.resolve()
  return event
}

beforeAll(() => {
  initHotkey()
})

beforeEach(() => {
  resetClientSessionForTests()
  hotkeyNavigationMocks.closeSettingsRoute.mockReset()
  hotkeyNavigationMocks.navigate.mockReset()
  hotkeyNavigationMocks.openSettingsRoute.mockReset()
  settingsOpen.set(false)
  alertStore.set({ type: 'none', msg: '' })
  selectedCharID.set(-1)
  PlaygroundStore.set(0)
  QuickSettings.open = false
  QuickSettings.index = 0
  testDatabaseState.db = {
    hotkeys: [
      { action: 'settings', ctrl: true, key: 's' },
      { action: 'home', ctrl: true, key: 'h' },
      { action: 'send', ctrl: true, alt: true, key: 'Enter' },
    ],
  }
})

describe('global hotkey route ownership', () => {
  it('blocks mutation and Settings shortcuts while preserving reader Home navigation', async () => {
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'lineage-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    setClientProjectionReady(true)
    setClientConnectionState('live')
    const send = document.createElement('button')
    send.className = 'button-icon-send'
    const submit = vi.fn()
    send.addEventListener('click', submit)
    document.body.append(send)
    try {
      const event = await press('Enter', { ctrlKey: true, altKey: true })
      expect(event.defaultPrevented).toBe(true)
      expect(submit).not.toHaveBeenCalled()
      await press('h', { ctrlKey: true })
      expect(hotkeyNavigationMocks.navigate).toHaveBeenCalledWith('/')
      await press('s', { ctrlKey: true })
      expect(hotkeyNavigationMocks.openSettingsRoute).not.toHaveBeenCalled()
    } finally {
      send.remove()
      resetClientSessionForTests()
    }
  })
  it('does not open a picker after a quick-menu answer crosses writer loss and promotion', async () => {
    enterClientWriter()
    testDatabaseState.db = { hotkeys: [{ action: 'quickMenu', ctrl: true, key: 'q' }] }
    openPresetList.set(false)
    await press('q', { ctrlKey: true })
    const selection = get(alertStore)
    expect(selection.type).toBe('select')
    demoteClientSession()
    repromoteClientWriter()
    resolveAlertSelection(selection.dialogOwner, 0)
    await Promise.resolve()
    expect(get(openPresetList)).toBe(false)
  })

  it('runs character auto-scroll only for sidebar drags', () => {
    const scrollToActiveCharacter = vi.fn()
    window.addEventListener('scrollToActiveCharacter', scrollToActiveCharacter)

    try {
      for (const dragType of [RISU_PRESET_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE]) {
        const event = new Event('dragover', { bubbles: true, cancelable: true })
        Object.defineProperties(event, {
          altKey: { value: false },
          ctrlKey: { value: true },
          dataTransfer: { value: { types: [dragType] } },
          shiftKey: { value: false },
        })
        document.dispatchEvent(event)
      }

      expect(scrollToActiveCharacter).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('scrollToActiveCharacter', scrollToActiveCharacter)
    }
  })

  it('routes the Settings shortcut through the router in both directions', async () => {
    await press('s', { ctrlKey: true })
    expect(hotkeyNavigationMocks.openSettingsRoute).toHaveBeenCalledOnce()

    settingsOpen.set(true)
    await press('s', { ctrlKey: true })
    expect(hotkeyNavigationMocks.closeSettingsRoute).toHaveBeenCalledOnce()
  })

  it('routes Home out of settings and playground state', async () => {
    settingsOpen.set(true)
    await press('h', { ctrlKey: true })
    expect(hotkeyNavigationMocks.navigate).toHaveBeenLastCalledWith('/')

    hotkeyNavigationMocks.navigate.mockClear()
    settingsOpen.set(false)
    PlaygroundStore.set(4)
    await press('h', { ctrlKey: true })
    expect(hotkeyNavigationMocks.navigate).toHaveBeenLastCalledWith('/')
  })

  it('routes the global Settings Escape fallback home', async () => {
    settingsOpen.set(true)

    const event = await press('Escape')

    expect(event.defaultPrevented).toBe(true)
    expect(hotkeyNavigationMocks.closeSettingsRoute).toHaveBeenCalledOnce()
  })

  it('keeps Quick Settings open when the module editor cancels closing it', async () => {
    testDatabaseState.db.hotkeys = [{ action: 'quickSettings', ctrl: true, key: 'q' }]
    QuickSettings.open = true
    QuickSettings.index = 2
    const guard = vi.fn(() => false)
    const unregister = registerModuleEditorLeaveGuard(guard)

    try {
      const event = await press('q', { ctrlKey: true })

      expect(event.defaultPrevented).toBe(true)
      expect(guard).toHaveBeenCalledOnce()
      expect(QuickSettings.open).toBe(true)
      expect(QuickSettings.index).toBe(2)
    } finally {
      unregister()
    }
  })

  it('confirms an owned ask dialog with Enter', async () => {
    const confirmation = alertConfirm('Continue?')

    const event = await press('Enter')

    expect(event.defaultPrevented).toBe(true)
    await expect(confirmation).resolves.toBe(true)
    expect(get(alertStore)).toMatchObject({ type: 'none', msg: 'yes' })
  })

  it('confirms an owned plugin dialog with Enter', async () => {
    const confirmation = alertPluginConfirm('Allow plugin?')

    await press('Enter')

    await expect(confirmation).resolves.toBe(true)
  })

  it('cancels only the active confirmation on Escape and leaves Settings open', async () => {
    settingsOpen.set(true)
    const confirmation = alertConfirm('Discard draft?')

    const event = await press('Escape')

    expect(event.defaultPrevented).toBe(true)
    await expect(confirmation).resolves.toBe(false)
    expect(hotkeyNavigationMocks.closeSettingsRoute).not.toHaveBeenCalled()
    expect(get(settingsOpen)).toBe(true)
  })

  it('cancels card export on Escape without closing the route behind it', async () => {
    settingsOpen.set(true)
    const exportResult = alertCardExport()

    await press('Escape')

    expect(get(alertStore)).toMatchObject({ type: 'none', msg: cardExportCancelMessage() })
    await expect(exportResult).resolves.toEqual({ type: 'cancel', type2: '' })
    expect(hotkeyNavigationMocks.closeSettingsRoute).not.toHaveBeenCalled()
  })

  it('suppresses configured route and send shortcuts while a modal is active', async () => {
    const sendButton = document.createElement('button')
    sendButton.className = 'button-icon-send'
    const sendSpy = vi.fn()
    sendButton.addEventListener('click', sendSpy)
    document.body.appendChild(sendButton)
    alertStore.set({ type: 'input', msg: 'Name' })

    const settingsEvent = await press('s', { ctrlKey: true })
    const homeEvent = await press('h', { ctrlKey: true })
    const sendEvent = await press('Enter', { ctrlKey: true, altKey: true })

    expect(settingsEvent.defaultPrevented).toBe(true)
    expect(homeEvent.defaultPrevented).toBe(true)
    expect(sendEvent.defaultPrevented).toBe(true)
    expect(hotkeyNavigationMocks.openSettingsRoute).not.toHaveBeenCalled()
    expect(hotkeyNavigationMocks.navigate).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()

    alertStore.set({ type: 'none', msg: '' })
    sendButton.remove()
  })

  it('leaves native modal editing and focus-navigation keys untouched', async () => {
    alertStore.set({ type: 'input', msg: 'Name' })
    const modalRoot = document.createElement('div')
    modalRoot.dataset.modalRoot = ''
    const input = document.createElement('input')
    const button = document.createElement('button')
    modalRoot.append(input, button)
    document.body.appendChild(modalRoot)

    input.focus()
    const shiftedCharacter = new KeyboardEvent('keydown', {
      key: 'A',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(shiftedCharacter)

    const paste = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(paste)

    button.focus()
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    button.dispatchEvent(tab)
    const activate = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    button.dispatchEvent(activate)

    expect(shiftedCharacter.defaultPrevented).toBe(false)
    expect(paste.defaultPrevented).toBe(false)
    expect(tab.defaultPrevented).toBe(false)
    expect(activate.defaultPrevented).toBe(false)
    expect(hotkeyNavigationMocks.openSettingsRoute).not.toHaveBeenCalled()
    expect(hotkeyNavigationMocks.navigate).not.toHaveBeenCalled()

    alertStore.set({ type: 'none', msg: '' })
    modalRoot.remove()
  })

  it('leaves Escape from an editable select to its owning control', async () => {
    settingsOpen.set(true)
    const select = document.createElement('select')
    document.body.appendChild(select)
    select.focus()

    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    })
    select.dispatchEvent(event)

    expect(hotkeyNavigationMocks.closeSettingsRoute).not.toHaveBeenCalled()
    select.remove()
  })

  it('ignores keyboard events already owned by a component', async () => {
    settingsOpen.set(true)
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    })
    event.preventDefault()

    document.dispatchEvent(event)
    await Promise.resolve()

    expect(hotkeyNavigationMocks.closeSettingsRoute).not.toHaveBeenCalled()
  })
})
