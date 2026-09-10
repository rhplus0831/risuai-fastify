import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectedCharID } from 'src/ts/stores.svelte'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { charactersResourceState } from 'src/ts/server/resourceState.svelte'

const hydration = vi.hoisted(() => ({
  failed: false,
  pending: false,
  retry: vi.fn(async () => undefined),
}))

const editorActions = vi.hoisted(() => ({
  addLorebook: vi.fn(),
  addLorebookFolder: vi.fn(),
  exportLoreBook: vi.fn(),
  importLoreBook: vi.fn(),
}))

const lorebookOwnerActions = vi.hoisted(() => ({
  replaceCharacterLorebookCollectionWithOutcome: vi.fn(),
  replaceChatLorebookCollectionWithOutcome: vi.fn(),
}))

const alertSpies = vi.hoisted(() => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
}))

vi.mock('src/lang', () => ({
  language: {
    Chat: 'Chat',
    add: 'Add',
    alwaysActive: 'Always Active',
    character: 'Character',
    disable: 'Disable',
    enable: 'Enable',
    export: 'Export',
    folderName: 'Folder',
    globalLoreInfo: 'Character lorebook',
    import: 'Import',
    loadingLorebookData: 'Loading Lorebook Data',
    localLoreInfo: 'Chat lorebook',
    loreBook: 'Lorebook',
    lorebookDataLoadFailed: 'Lorebook data could not be loaded.',
    retry: 'Retry',
    scopedLorebookMutation: {
      pending: 'Saving lorebook changes…',
      queued: 'Lorebook change queued.',
      failed: (detail: string) => `Lorebook change failed.${detail ? ` ${detail}` : ''}`,
      localActivationCleanupQueued: 'Local activation cleanup queued.',
      localActivationCleanupFailed: (detail: string) =>
        `Local activation cleanup failed and was restored.${detail ? ` ${detail}` : ''}`,
    },
    settings: 'Settings',
  },
}))

vi.mock('../../../lang', () => ({
  language: {
    Chat: 'Chat',
    add: 'Add',
    alwaysActive: 'Always Active',
    character: 'Character',
    disable: 'Disable',
    enable: 'Enable',
    export: 'Export',
    folderName: 'Folder',
    globalLoreInfo: 'Character lorebook',
    import: 'Import',
    loadingLorebookData: 'Loading Lorebook Data',
    localLoreInfo: 'Chat lorebook',
    loreBook: 'Lorebook',
    lorebookDataLoadFailed: 'Lorebook data could not be loaded.',
    retry: 'Retry',
    scopedLorebookMutation: {
      pending: 'Saving lorebook changes…',
      queued: 'Lorebook change queued.',
      failed: (detail: string) => `Lorebook change failed.${detail ? ` ${detail}` : ''}`,
      localActivationCleanupQueued: 'Local activation cleanup queued.',
      localActivationCleanupFailed: (detail: string) =>
        `Local activation cleanup failed and was restored.${detail ? ` ${detail}` : ''}`,
    },
    settings: 'Settings',
  },
}))

vi.mock('../../../ts/process/lorebook.svelte', () => editorActions)

vi.mock('src/ts/alert', () => alertSpies)

vi.mock('src/ts/server/chatMessageHydration.svelte', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/server/chatMessageHydration.svelte')>()),
  hasCharacterLorebookHydrationFailed: () => hydration.failed,
  hydrateActiveCharacterLorebook: hydration.retry,
  isCharacterLorebookHydrationPending: () => hydration.pending,
}))

vi.mock('src/ts/server/lorebookOwner.svelte', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/server/lorebookOwner.svelte')>()),
  replaceCharacterLorebookCollectionWithOutcome: lorebookOwnerActions.replaceCharacterLorebookCollectionWithOutcome,
  replaceChatLorebookCollectionWithOutcome: lorebookOwnerActions.replaceChatLorebookCollectionWithOutcome,
}))

vi.mock('src/ts/server/characterDraft.svelte', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/server/characterDraft.svelte')>()),
  createCharacterOwnerDraft: () => ({
    value: { lorePlus: false, loreSettings: undefined },
  }),
}))

vi.mock('./LoreBookList.svelte', async () => ({
  default: (await import('./LoreBookSetting.test.LoreBookListStub.svelte')).default,
}))

import LoreBookSetting from './LoreBookSetting.svelte'
import { resetScopedLorebookMutationUiStateForTests } from 'src/ts/server/scopedLorebookMutationUiState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function deferredOperation(scopeKey: string) {
  let resolve!: (result: { status: 'accepted' | 'queued' } | { status: 'failed'; error: string }) => void
  const settlement = new Promise<{ status: 'accepted' | 'queued' } | { status: 'failed'; error: string }>(
    (resolvePromise) => {
      resolve = resolvePromise
    },
  )
  return { operation: { scopeKey, settlement }, resolve }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

beforeEach(() => {
  hydration.failed = false
  hydration.pending = false
  hydration.retry.mockClear()
  for (const action of Object.values(editorActions)) action.mockClear()
  for (const action of Object.values(lorebookOwnerActions)) action.mockReset()
  for (const alert of Object.values(alertSpies)) alert.mockClear()
  resetScopedLorebookMutationUiStateForTests()
  setDatabaseLite({
    bulkEnabling: false,
    characters: [
      {
        chaId: 'character-a',
        chatPage: 0,
        chats: [{ id: 'chat-a', localLore: [], message: [] }],
        globalLore: [],
        lorePlus: false,
      },
    ],
  } as any)
  selectedCharID.set(0)
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  selectedCharID.set(-1)
  resetScopedLorebookMutationUiStateForTests()
})

describe('character lorebook hydration UI', () => {
  it('shows loading and hides the list and mutation toolbar while hydration is pending', async () => {
    hydration.pending = true
    component = mount(LoreBookSetting, { target })
    await tick()

    expect(target.querySelector('[data-testid="character-lorebook-hydration-loading"]')).not.toBeNull()
    expect(target.textContent).toContain('Loading Lorebook Data')
    expect(target.querySelector('[data-testid="character-lorebook-list-ready"]')).toBeNull()
    // Only the Character / Chat / Settings tabs remain; add, export, folder,
    // import, and bulk mutation controls are withheld.
    expect(target.querySelectorAll('button')).toHaveLength(3)
  })

  it('shows a failed state with retry and keeps mutation controls unavailable', async () => {
    hydration.failed = true
    component = mount(LoreBookSetting, { target })
    await tick()

    expect(target.querySelector('[data-testid="character-lorebook-hydration-error"]')).not.toBeNull()
    expect(target.textContent).toContain('Lorebook data could not be loaded.')
    expect(target.querySelector('[data-testid="character-lorebook-list-ready"]')).toBeNull()

    const retry = [...target.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry'))
    expect(retry).toBeDefined()
    retry?.click()
    await tick()
    expect(hydration.retry).toHaveBeenCalledWith({ force: true })
    expect(target.querySelectorAll('button')).toHaveLength(4)
  })
})

describe('lorebook editor action accessibility', () => {
  it('names the mutation toolbar and exposes the selected submenu', async () => {
    component = mount(LoreBookSetting, { target })
    await tick()

    const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('button'))
    const characterTab = buttons.find((button) => button.textContent?.trim() === 'Character')
    const chatTab = buttons.find((button) => button.textContent?.trim() === 'Chat')
    const settingsTab = buttons.find((button) => button.textContent?.trim() === 'Settings')
    expect(characterTab?.getAttribute('aria-pressed')).toBe('true')
    expect(chatTab?.getAttribute('aria-pressed')).toBe('false')
    expect(settingsTab?.getAttribute('aria-pressed')).toBe('false')

    expect(target.querySelector('[aria-label="Add: Lorebook"]')).toBeTruthy()
    expect(target.querySelector('[aria-label="Export: Lorebook"]')).toBeTruthy()
    expect(target.querySelector('[aria-label="Add: Folder"]')).toBeTruthy()
    expect(target.querySelector('[aria-label="Import: Lorebook"]')).toBeTruthy()

    chatTab?.click()
    await tick()
    expect(characterTab?.getAttribute('aria-pressed')).toBe('false')
    expect(chatTab?.getAttribute('aria-pressed')).toBe('true')
  })

  it('exposes bulk always-active state for character and chat lorebooks', async () => {
    setDatabaseLite({
      bulkEnabling: true,
      characters: [
        {
          chaId: 'character-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', localLore: [{ alwaysActive: false }], message: [] }],
          globalLore: [{ alwaysActive: true }],
          lorePlus: false,
        },
      ],
    } as any)
    component = mount(LoreBookSetting, { target })
    await tick()

    const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('button'))
    const characterToggle = buttons.find((button) => button.textContent?.trim() === 'CHAR')
    const chatToggle = buttons.find((button) => button.textContent?.trim() === 'CHAT')
    expect(characterToggle?.getAttribute('aria-label')).toBe('Disable: Always Active (Character)')
    expect(characterToggle?.getAttribute('aria-pressed')).toBe('true')
    expect(chatToggle?.getAttribute('aria-label')).toBe('Enable: Always Active (Chat)')
    expect(chatToggle?.getAttribute('aria-pressed')).toBe('false')
  })

  it('targets the authoritative selected character owner when the compatibility selection is stale', async () => {
    setDatabaseLite({
      bulkEnabling: true,
      characters: [
        {
          chaId: 'compatibility-character',
          chatPage: 0,
          chats: [{ id: 'compatibility-chat', localLore: [], message: [] }],
          globalLore: [{ alwaysActive: true }],
          lorePlus: false,
        },
        {
          chaId: 'owner-character',
          chatPage: 0,
          chats: [{ id: 'owner-chat', localLore: [], message: [] }],
          globalLore: [{ alwaysActive: false }],
          lorePlus: true,
        },
      ],
    } as any)
    selectedCharID.set(0)
    charactersResourceState.currentChar = 1
    charactersResourceState.selectionRevision = 9
    component = mount(LoreBookSetting, { target })
    await tick()

    const characterToggle = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'CHAR',
    )!
    expect(characterToggle.getAttribute('aria-label')).toBe('Enable: Always Active (Character)')
    characterToggle.click()
    await tick()

    expect(lorebookOwnerActions.replaceCharacterLorebookCollectionWithOutcome).toHaveBeenCalledWith('owner-character', [
      { alwaysActive: true },
    ])
  })

  it('disables chat mutations when the selected chat id has duplicate owners', async () => {
    setDatabaseLite({
      bulkEnabling: true,
      characters: [
        {
          chaId: 'selected-character',
          chatPage: 0,
          chats: [{ id: 'duplicate-chat', localLore: [{ alwaysActive: false }], message: [] }],
          globalLore: [],
          lorePlus: false,
        },
        {
          chaId: 'other-character',
          chatPage: 0,
          chats: [{ id: 'duplicate-chat', localLore: [], message: [] }],
          globalLore: [],
          lorePlus: false,
        },
      ],
    } as any)
    selectedCharID.set(0)
    charactersResourceState.currentChar = 0
    charactersResourceState.selectionRevision = 10
    component = mount(LoreBookSetting, { target })
    await tick()

    const chatTab = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Chat',
    )!
    chatTab.click()
    await tick()

    expect(target.querySelector<HTMLButtonElement>('[aria-label="Add: Lorebook"]')?.disabled).toBe(true)
    expect(target.querySelector<HTMLButtonElement>('[aria-label="Import: Lorebook"]')?.disabled).toBe(true)
    const chatToggle = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'CHAT',
    )!
    expect(chatToggle.disabled).toBe(true)
    chatToggle.click()
    expect(lorebookOwnerActions.replaceChatLorebookCollectionWithOutcome).not.toHaveBeenCalled()
  })
})

describe('scoped lorebook persistence outcomes', () => {
  it('keeps a pending add owned by its character scope and reports a queued settlement', async () => {
    const deferred = deferredOperation('character:character-a')
    const chatDeferred = deferredOperation('chat:chat-a')
    editorActions.addLorebook.mockReturnValueOnce(deferred.operation)
    component = mount(LoreBookSetting, { target })
    await tick()

    const add = target.querySelector<HTMLButtonElement>('[aria-label="Add: Lorebook"]')!
    add.click()
    await tick()

    expect(add.disabled).toBe(true)
    expect(target.querySelector('[data-risu-lorebook-persistence="pending"]')).toBeNull()

    const chatTab = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Chat',
    )!
    chatTab.click()
    await tick()
    const chatAdd = target.querySelector<HTMLButtonElement>('[aria-label="Add: Lorebook"]')!
    expect(chatAdd.disabled).toBe(false)
    expect(target.querySelector('[data-risu-lorebook-scope="character:character-a"]')).toBeNull()

    editorActions.addLorebook.mockReturnValueOnce(chatDeferred.operation)
    chatAdd.click()
    await tick()
    expect(editorActions.addLorebook).toHaveBeenLastCalledWith(1)
    expect(chatAdd.disabled).toBe(true)
    expect(target.querySelector('[data-risu-lorebook-scope="chat:chat-a"]')).toBeNull()

    chatDeferred.resolve({ status: 'accepted' })
    await flushAsyncWork()
    expect(chatAdd.disabled).toBe(false)

    deferred.resolve({ status: 'queued' })
    await flushAsyncWork()
    expect(alertSpies.alertNormal).toHaveBeenCalledWith('Lorebook change queued.')
    expect(target.querySelector('[data-risu-lorebook-scope="character:character-a"]')).toBeNull()
  })

  it('locks same-scope mutations while an imported collection is pending, then unlocks on acceptance', async () => {
    setDatabaseLite({
      bulkEnabling: true,
      characters: [
        {
          chaId: 'character-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', localLore: [], message: [] }],
          globalLore: [],
          lorePlus: false,
        },
      ],
    } as any)
    const deferred = deferredOperation('character:character-a')
    editorActions.importLoreBook.mockResolvedValueOnce(deferred.operation).mockResolvedValueOnce(null)
    component = mount(LoreBookSetting, { target })
    await tick()

    const add = target.querySelector<HTMLButtonElement>('[aria-label="Add: Lorebook"]')!
    const addFolder = target.querySelector<HTMLButtonElement>('[aria-label="Add: Folder"]')!
    const importButton = target.querySelector<HTMLButtonElement>('[aria-label="Import: Lorebook"]')!
    const characterBulk = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'CHAR',
    )!
    const chatBulk = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'CHAT',
    )!

    importButton.click()
    await flushAsyncWork()
    expect(editorActions.importLoreBook).toHaveBeenCalledWith('global')
    expect(add.disabled).toBe(true)
    expect(addFolder.disabled).toBe(true)
    expect(importButton.disabled).toBe(true)
    expect(characterBulk.disabled).toBe(true)
    expect(chatBulk.disabled).toBe(false)
    expect(target.textContent).not.toContain('Saving lorebook changes')

    importButton.click()
    add.click()
    addFolder.click()
    characterBulk.click()
    expect(editorActions.importLoreBook).toHaveBeenCalledTimes(1)
    expect(editorActions.addLorebook).not.toHaveBeenCalled()
    expect(editorActions.addLorebookFolder).not.toHaveBeenCalled()
    expect(lorebookOwnerActions.replaceCharacterLorebookCollectionWithOutcome).not.toHaveBeenCalled()

    deferred.resolve({ status: 'accepted' })
    await flushAsyncWork()
    expect(add.disabled).toBe(false)
    expect(addFolder.disabled).toBe(false)
    expect(importButton.disabled).toBe(false)
    expect(characterBulk.disabled).toBe(false)

    importButton.click()
    await flushAsyncWork()
    expect(editorActions.importLoreBook).toHaveBeenCalledTimes(2)
  })

  it('does not replay transient queued feedback or keep controls locked after remount', async () => {
    const deferred = deferredOperation('character:character-a')
    editorActions.addLorebook.mockReturnValueOnce(deferred.operation)
    component = mount(LoreBookSetting, { target })
    await tick()

    target.querySelector<HTMLButtonElement>('[aria-label="Add: Lorebook"]')!.click()
    deferred.resolve({ status: 'queued' })
    await flushAsyncWork()
    expect(target.querySelector('[data-risu-lorebook-scope="character:character-a"]')).toBeNull()

    unmount(component)
    component = undefined
    target.replaceChildren()
    alertSpies.alertNormal.mockClear()
    component = mount(LoreBookSetting, { target })
    await tick()

    expect(target.querySelector('[data-risu-lorebook-scope="character:character-a"]')).toBeNull()
    expect(alertSpies.alertNormal).not.toHaveBeenCalled()
    const remountedAdd = target.querySelector<HTMLButtonElement>('[aria-label="Add: Lorebook"]')!
    expect(remountedAdd.disabled).toBe(false)
    expect(target.querySelector<HTMLButtonElement>('[aria-label="Add: Folder"]')?.disabled).toBe(false)
    expect(target.querySelector<HTMLButtonElement>('[aria-label="Import: Lorebook"]')?.disabled).toBe(false)

    remountedAdd.click()
    await tick()
    expect(editorActions.addLorebook).toHaveBeenCalledTimes(2)
  })

  it('disables an exact bulk scope while pending and reports terminal failure', async () => {
    setDatabaseLite({
      bulkEnabling: true,
      characters: [
        {
          chaId: 'character-a',
          chatPage: 0,
          chats: [{ id: 'chat-a', localLore: [{ alwaysActive: false }], message: [] }],
          globalLore: [{ alwaysActive: false }],
          lorePlus: false,
        },
      ],
    } as any)
    const deferred = deferredOperation('character:character-a')
    lorebookOwnerActions.replaceCharacterLorebookCollectionWithOutcome.mockReturnValueOnce(deferred.operation)
    component = mount(LoreBookSetting, { target })
    await tick()

    const characterBulk = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'CHAR',
    )!
    const chatBulk = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'CHAT',
    )!
    characterBulk.click()
    await tick()
    expect(characterBulk.disabled).toBe(true)
    expect(chatBulk.disabled).toBe(false)

    deferred.resolve({ status: 'failed', error: 'invalid bulk update' })
    await flushAsyncWork()
    expect(characterBulk.disabled).toBe(false)
    expect(alertSpies.alertError).toHaveBeenCalledWith('Lorebook change failed. invalid bulk update')
    expect(target.querySelector('[data-risu-lorebook-scope="character:character-a"]')?.textContent).toContain(
      'Lorebook change failed',
    )
  })
})
