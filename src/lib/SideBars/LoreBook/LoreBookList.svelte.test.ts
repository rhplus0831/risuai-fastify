import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Database, loreBook } from 'src/ts/storage/database.svelte'
import { selectedCharID } from 'src/ts/stores.svelte'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { lorebookPageOwner } from 'src/ts/server/lorebookPageOwner.svelte'

import { charactersResourceState, collectionsResourceState } from 'src/ts/server/resourceState.svelte'

const lorebookListMocks = vi.hoisted(() => {
  type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
  }

  type QueuedConfirm = boolean | Deferred<boolean>

  class SortableMock {
    static create = vi.fn((element: Element, options: unknown) => new SortableMock(element, options))

    element: Element
    options: unknown
    destroy = vi.fn()

    constructor(element: Element, options: unknown) {
      this.element = element
      this.options = options
    }
  }

  const confirmQueue: QueuedConfirm[] = []
  const applyLorebookEntryDraftEdit = vi.fn(() => true)
  const flushPendingLorebookEntryDraftEdit = vi.fn()
  const replaceCharacterLorebookCollection = vi.fn()
  const replaceChatLorebookCollection = vi.fn()
  const replaceGlobalLorebookEntryCollection = vi.fn()

  function snapshot(value: unknown): string {
    return JSON.stringify(value)
  }

  function changedLorebookEntryDraftFields(previousEntry: loreBook, currentEntry: loreBook): string[] {
    const previous = previousEntry as unknown as Record<string, unknown>
    const current = currentEntry as unknown as Record<string, unknown>
    return [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(
      (key) => key !== 'id' && snapshot(previous[key]) !== snapshot(current[key]),
    )
  }

  function clearDirtyLorebookEntryFieldsMatchingProjection(
    dirtyFields: Set<string>,
    draft: loreBook,
    projection: loreBook,
  ): void {
    const draftRecord = draft as unknown as Record<string, unknown>
    const projectionRecord = projection as unknown as Record<string, unknown>
    for (const field of dirtyFields) {
      if (snapshot(draftRecord[field]) === snapshot(projectionRecord[field])) dirtyFields.delete(field)
    }
  }

  function mergeLorebookEntryProjectionDraft(
    draft: loreBook,
    projection: loreBook,
    dirtyFields: ReadonlySet<string>,
  ): loreBook {
    const merged = JSON.parse(JSON.stringify(projection)) as unknown as Record<string, unknown>
    const draftRecord = draft as unknown as Record<string, unknown>
    for (const field of dirtyFields) {
      if (Object.prototype.hasOwnProperty.call(draftRecord, field)) merged[field] = draftRecord[field]
      else delete merged[field]
    }
    return merged as unknown as loreBook
  }

  function createDeferred<T>(): Deferred<T> {
    let resolveDeferred!: (value: T) => void
    let rejectDeferred!: (reason?: unknown) => void
    return {
      promise: new Promise<T>((resolve, reject) => {
        resolveDeferred = resolve
        rejectDeferred = reject
      }),
      resolve: resolveDeferred,
      reject: rejectDeferred,
    }
  }

  function isDeferred(value: QueuedConfirm): value is Deferred<boolean> {
    return typeof value === 'object' && value !== null && 'promise' in value
  }

  function queueConfirm(value: QueuedConfirm): void {
    confirmQueue.push(value)
  }

  return {
    SortableMock,
    alertConfirm: vi.fn(() => {
      const next = confirmQueue.shift()
      if (next === undefined) return Promise.resolve(false)
      return isDeferred(next) ? next.promise : Promise.resolve(next)
    }),
    alertError: vi.fn(),
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    applyLorebookEntryDraftEdit,
    createDeferred,
    flushPendingLorebookEntryDraftEdit,
    queueConfirm,
    reset: () => {
      confirmQueue.splice(0)
      SortableMock.create.mockClear()
    },
    replaceCharacterLorebookCollection,
    replaceChatLorebookCollection,
    replaceGlobalLorebookEntryCollection,
    changedLorebookEntryDraftFields,
    clearDirtyLorebookEntryFieldsMatchingProjection,
    mergeLorebookEntryProjectionDraft,
    setActiveChatLorebookLocalActivation: vi.fn(),
    setChatLorebookLocalActivationWithOutcome: vi.fn(),
    languageMock: {
      language: {
        SecondaryKeys: 'Secondary keys',
        activationKeys: 'Activation keys',
        activationKeysInfo: 'Activation info',
        activationProbability: 'Activation probability',
        alwaysActive: 'Always active',
        alwaysActiveInChat: 'Always active in chat',
        childLoreDesc: 'Child lore',
        disable: 'Disable',
        enable: 'Enable',
        folderName: 'Folder name',
        folderRemoveConfirm: 'Remove folder children?',
        help: {
          experimental: 'Experimental',
          loreActivationKey: 'Lore activation key',
          loreName: 'Lore name',
          loreSelective: 'Lore selective',
          loreorder: 'Lore order',
          useRegexLorebook: 'Use regex lorebook',
        },
        hotkeyDesc: { popupEditor: 'Popup editor' },
        insertOrder: 'Insert order',
        name: 'Name',
        prompt: 'Prompt',
        removeConfirm: 'Remove ',
        selective: 'Selective',
        scopedLorebookMutation: {
          pending: 'Saving lorebook changes…',
          queued: 'Lorebook change queued.',
          failed: (detail: string) => `Lorebook change failed.${detail ? ` ${detail}` : ''}`,
          localActivationCleanupQueued: 'Local activation cleanup queued.',
          localActivationCleanupFailed: (detail: string) =>
            `Local activation cleanup failed and was restored.${detail ? ` ${detail}` : ''}`,
        },
        showHelp: 'Show help',
        tokens: 'tokens',
        useRegexLorebook: 'Use regex lorebook',
      },
    },
  }
})

vi.mock('sortablejs/modular/sortable.core.esm.js', () => ({
  default: lorebookListMocks.SortableMock,
}))

vi.mock('../../../lang', () => lorebookListMocks.languageMock)
vi.mock('src/lang', () => lorebookListMocks.languageMock)

vi.mock('../../../ts/alert', () => ({
  alertConfirm: lorebookListMocks.alertConfirm,
  alertError: lorebookListMocks.alertError,
  alertMd: lorebookListMocks.alertMd,
  alertNormal: lorebookListMocks.alertNormal,
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: lorebookListMocks.alertConfirm,
  alertError: lorebookListMocks.alertError,
  alertMd: lorebookListMocks.alertMd,
  alertNormal: lorebookListMocks.alertNormal,
}))

vi.mock('src/ts/server/lorebookOwner.svelte', () => ({
  applyLorebookEntryDraftEdit: lorebookListMocks.applyLorebookEntryDraftEdit,
  applyLorebookEntryDraftRollback: vi.fn((draft: loreBook) => ({ draft, restoredFields: [] })),
  applyServerCharacterLorebookResource: vi.fn(() => true),
  changedLorebookEntryDraftFields: lorebookListMocks.changedLorebookEntryDraftFields,
  clearDirtyLorebookEntryFieldsMatchingProjection: lorebookListMocks.clearDirtyLorebookEntryFieldsMatchingProjection,
  flushPendingLorebookEntryDraftEdit: lorebookListMocks.flushPendingLorebookEntryDraftEdit,
  markCharacterLorebookHydrated: vi.fn(),
  mergeLorebookEntryProjectionDraft: lorebookListMocks.mergeLorebookEntryProjectionDraft,
  recordCanonicalCharacterLorebookScopes: vi.fn(),
  recordCanonicalLorebookCollections: vi.fn(),
  recordHydratedCharacterLorebooks: vi.fn(),
  replaceCharacterLorebookCollection: lorebookListMocks.replaceCharacterLorebookCollection,
  replaceCharacterLorebookCollectionWithOutcome: lorebookListMocks.replaceCharacterLorebookCollection,
  replaceChatLorebookCollection: lorebookListMocks.replaceChatLorebookCollection,
  replaceChatLorebookCollectionWithOutcome: lorebookListMocks.replaceChatLorebookCollection,
  replaceGlobalLorebookEntryCollection: lorebookListMocks.replaceGlobalLorebookEntryCollection,
  replaceGlobalLorebookEntryCollectionWithOutcome: lorebookListMocks.replaceGlobalLorebookEntryCollection,
  resetLorebookHydration: vi.fn(),
  setActiveChatLorebookLocalActivation: lorebookListMocks.setActiveChatLorebookLocalActivation,
  setActiveChatLorebookLocalActivationWithOutcome: lorebookListMocks.setActiveChatLorebookLocalActivation,
  setChatLorebookLocalActivationWithOutcome: lorebookListMocks.setChatLorebookLocalActivationWithOutcome,
  subscribeLorebookEntryDraftRollbacks: vi.fn(() => () => {}),
}))

vi.mock('src/ts/tokenizer', () => ({
  tokenizeAccurate: vi.fn(async () => 0),
}))

import LoreBookListHarness from './LoreBookList.testHarness.svelte'
import LoreBookList from './LoreBookList.svelte'
import { resetScopedLorebookMutationUiStateForTests } from 'src/ts/server/scopedLorebookMutationUiState'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]
type LoreBookListHarnessComponent = MountedComponent & {
  getEntries: () => loreBook[]
  setEntries: (entries: loreBook[]) => void
}

let target: HTMLElement
let component: LoreBookListHarnessComponent | undefined
let resourceComponent: MountedComponent | undefined

function deferredOperation(scopeKey: string) {
  let resolve!: (result: { status: 'accepted' | 'queued' } | { status: 'failed'; error: string }) => void
  const settlement = new Promise<{ status: 'accepted' | 'queued' } | { status: 'failed'; error: string }>(
    (resolvePromise) => {
      resolve = resolvePromise
    },
  )
  return { operation: { scopeKey, settlement }, resolve }
}

function makeLoreBook(overrides: Partial<loreBook>): loreBook {
  return {
    key: '',
    secondkey: '',
    insertorder: 100,
    comment: '',
    content: '',
    mode: 'normal',
    alwaysActive: true,
    selective: false,
    ...overrides,
  }
}

function cloneEntries(entries: loreBook[]): loreBook[] {
  return JSON.parse(JSON.stringify(entries)) as loreBook[]
}

function mountHarness(entries: loreBook[]): LoreBookListHarnessComponent {
  return mount(LoreBookListHarness, {
    target,
    props: { initialEntries: entries },
  }) as unknown as LoreBookListHarnessComponent
}

function lorebookRows(): HTMLElement[] {
  return Array.from(target.querySelectorAll<HTMLElement>('[data-risu-lorebook-row="true"]'))
}

function rowByEntryId(entryId: string): HTMLElement {
  const row = lorebookRows().find((candidate) => candidate.dataset.risuLorebookId === entryId)
  expect(row, `lorebook row ${entryId}`).toBeTruthy()
  return row!
}

function rowByText(text: string): HTMLElement {
  const row = lorebookRows().find((candidate) => candidate.textContent?.includes(text))
  expect(row, `lorebook row text ${text}`).toBeTruthy()
  return row!
}

function deleteButtonForRow(row: HTMLElement): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>('[data-risu-lorebook-action="delete"]')
  expect(button, 'lorebook delete button').toBeTruthy()
  return button!
}

function toggleButtonForRow(row: HTMLElement): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>('button.endflex')
  expect(button, 'lorebook detail toggle').toBeTruthy()
  return button!
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await tick()
}

describe('LoreBookList', () => {
  beforeEach(() => {
    target = document.createElement('div')
    document.body.appendChild(target)
    lorebookListMocks.reset()
    vi.clearAllMocks()
    resetScopedLorebookMutationUiStateForTests()
    selectedCharID.set(-1)
    setDatabaseLite({
      characters: [],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    lorebookPageOwner.projectStructuralSelection(0)
  })

  afterEach(() => {
    if (component) {
      unmount(component)
      component = undefined
    }
    if (resourceComponent) {
      unmount(resourceComponent)
      resourceComponent = undefined
    }
    target.remove()
    document.body.innerHTML = ''
    selectedCharID.set(-1)
    lorebookPageOwner.reset()
    setDatabaseLite({} as Database)
    resetScopedLorebookMutationUiStateForTests()
  })

  it('deletes an id-backed row by latest id after siblings are inserted and reordered during confirm', async () => {
    const initialEntries = [
      makeLoreBook({ id: 'entry-a', comment: 'Entry A' }),
      makeLoreBook({ id: 'entry-b', comment: 'Entry B' }),
      makeLoreBook({ id: 'entry-c', comment: 'Entry C' }),
    ]
    const confirm = lorebookListMocks.createDeferred<boolean>()
    lorebookListMocks.queueConfirm(confirm)

    component = mountHarness(initialEntries)
    await tick()

    deleteButtonForRow(rowByEntryId('entry-b')).click()
    await tick()

    component.setEntries([
      makeLoreBook({ id: 'entry-x', comment: 'Inserted Entry' }),
      ...cloneEntries([initialEntries[2], initialEntries[1], initialEntries[0]]),
    ])
    await tick()

    confirm.resolve(true)
    await flushAsyncWork()

    expect(component.getEntries().map((entry) => entry.id)).toEqual(['entry-x', 'entry-c', 'entry-a'])
  })

  it('deletes a cloned folder by folder key and removes latest children after reorder during confirm', async () => {
    const initialEntries = [
      makeLoreBook({ key: 'castle', comment: 'Castle Folder', mode: 'folder' }),
      makeLoreBook({ id: 'castle-child-a', comment: 'Castle Child A', folder: 'castle' }),
      makeLoreBook({ id: 'loose-sibling', comment: 'Loose Sibling' }),
      makeLoreBook({ key: 'forest', comment: 'Forest Folder', mode: 'folder' }),
      makeLoreBook({ id: 'forest-child-a', comment: 'Forest Child A', folder: 'forest' }),
    ]
    const firstConfirm = lorebookListMocks.createDeferred<boolean>()
    lorebookListMocks.queueConfirm(firstConfirm)
    lorebookListMocks.queueConfirm(true)

    component = mountHarness(initialEntries)
    await tick()

    deleteButtonForRow(rowByText('Castle Folder')).click()
    await tick()

    component.setEntries(
      cloneEntries([initialEntries[2], initialEntries[4], initialEntries[3], initialEntries[1], initialEntries[0]]),
    )
    await tick()

    firstConfirm.resolve(true)
    await flushAsyncWork()

    expect(lorebookListMocks.alertConfirm).toHaveBeenCalledTimes(2)
    expect(component.getEntries()).toMatchObject([
      { id: 'loose-sibling', comment: 'Loose Sibling' },
      { id: 'forest-child-a', folder: 'forest' },
      { key: 'forest', mode: 'folder' },
    ])
    expect(component.getEntries().some((entry) => entry.key === 'castle' || entry.folder === 'castle')).toBe(false)
  })

  it('aborts id-less row deletion when the captured index no longer matches the captured snapshot', async () => {
    const initialEntries = [
      makeLoreBook({ comment: 'Legacy A' }),
      makeLoreBook({ comment: 'Legacy Target' }),
      makeLoreBook({ comment: 'Legacy C' }),
    ]
    const confirm = lorebookListMocks.createDeferred<boolean>()
    lorebookListMocks.queueConfirm(confirm)

    component = mountHarness(initialEntries)
    await tick()

    deleteButtonForRow(rowByText('Legacy Target')).click()
    await tick()

    const reorderedEntries = [
      makeLoreBook({ comment: 'Inserted Legacy' }),
      ...cloneEntries([initialEntries[2], initialEntries[1], initialEntries[0]]),
    ]
    component.setEntries(reorderedEntries)
    await tick()

    confirm.resolve(true)
    await flushAsyncWork()

    expect(component.getEntries()).toEqual(reorderedEntries)
  })

  it('still deletes an id-less row when the same captured row remains at the captured index', async () => {
    const initialEntries = [
      makeLoreBook({ comment: 'Legacy A' }),
      makeLoreBook({ comment: 'Legacy Target' }),
      makeLoreBook({ comment: 'Legacy C' }),
    ]
    const confirm = lorebookListMocks.createDeferred<boolean>()
    lorebookListMocks.queueConfirm(confirm)

    component = mountHarness(initialEntries)
    await tick()

    deleteButtonForRow(rowByText('Legacy Target')).click()
    await tick()

    confirm.resolve(true)
    await flushAsyncWork()

    expect(component.getEntries().map((entry) => entry.comment)).toEqual(['Legacy A', 'Legacy C'])
  })

  it('fails closed when a captured stable entry id is duplicated before deletion settles', async () => {
    const initialEntries = [
      makeLoreBook({ id: 'entry-a', comment: 'Entry A' }),
      makeLoreBook({ id: 'entry-b', comment: 'Entry B' }),
    ]
    const confirm = lorebookListMocks.createDeferred<boolean>()
    lorebookListMocks.queueConfirm(confirm)

    component = mountHarness(initialEntries)
    await tick()
    deleteButtonForRow(rowByEntryId('entry-b')).click()
    await tick()

    const duplicatedEntries = [
      makeLoreBook({ id: 'entry-b', comment: 'Inserted Duplicate' }),
      ...cloneEntries(initialEntries),
    ]
    component.setEntries(duplicatedEntries)
    await tick()
    confirm.resolve(true)
    await flushAsyncWork()

    expect(component.getEntries()).toEqual(duplicatedEntries)
  })

  it('does not poison detail tracking when a closed row is deleted', async () => {
    lorebookListMocks.queueConfirm(true)
    component = mountHarness([
      makeLoreBook({ id: 'entry-a', comment: 'Entry A' }),
      makeLoreBook({ id: 'entry-b', comment: 'Entry B' }),
    ])
    await tick()
    const initialSortableCount = lorebookListMocks.SortableMock.create.mock.calls.length

    deleteButtonForRow(rowByEntryId('entry-a')).click()
    await flushAsyncWork()

    toggleButtonForRow(rowByEntryId('entry-b')).click()
    await tick()
    toggleButtonForRow(rowByEntryId('entry-b')).click()
    await tick()

    expect(lorebookListMocks.SortableMock.create).toHaveBeenCalledTimes(initialSortableCount + 1)
  })

  it('keeps an id-backed detail open across a cloned collection projection', async () => {
    const entries = [
      makeLoreBook({ id: 'entry-a', comment: 'Entry A', content: 'Open content' }),
      makeLoreBook({ id: 'entry-b', comment: 'Entry B' }),
    ]
    component = mountHarness(entries)
    await tick()
    const initialSortableCount = lorebookListMocks.SortableMock.create.mock.calls.length

    toggleButtonForRow(rowByEntryId('entry-a')).click()
    await tick()
    expect(rowByEntryId('entry-a').textContent).toContain('Prompt')

    component.setEntries(cloneEntries(entries))
    await tick()

    expect(rowByEntryId('entry-a').textContent).toContain('Prompt')
    toggleButtonForRow(rowByEntryId('entry-a')).click()
    await tick()
    expect(lorebookListMocks.SortableMock.create).toHaveBeenCalledTimes(initialSortableCount + 1)
  })

  it('restores reordering when an expanded row disappears in a collection projection', async () => {
    component = mountHarness([
      makeLoreBook({ id: 'entry-a', comment: 'Entry A', content: 'Open content' }),
      makeLoreBook({ id: 'entry-b', comment: 'Entry B' }),
    ])
    await tick()
    const initialSortableCount = lorebookListMocks.SortableMock.create.mock.calls.length

    toggleButtonForRow(rowByEntryId('entry-a')).click()
    await tick()
    component.setEntries([makeLoreBook({ id: 'entry-b', comment: 'Entry B' })])
    await tick()

    expect(rowByEntryId('entry-b').textContent).not.toContain('Prompt')
    expect(lorebookListMocks.SortableMock.create).toHaveBeenCalledTimes(initialSortableCount + 1)

    toggleButtonForRow(rowByEntryId('entry-b')).click()
    await tick()
    toggleButtonForRow(rowByEntryId('entry-b')).click()
    await tick()
    expect(lorebookListMocks.SortableMock.create).toHaveBeenCalledTimes(initialSortableCount + 2)
  })

  it('reacts to resource-backed character lorebook replacement and dispatches deletion for the current character', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-resource',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'resource-entry-a', comment: 'Resource Entry A' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)

    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()
    expect(rowByEntryId('resource-entry-a')).toBeTruthy()

    setDatabaseLite({
      characters: [
        {
          chaId: 'character-resource',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'resource-entry-b', comment: 'Resource Entry B' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    await tick()
    expect(rowByEntryId('resource-entry-b')).toBeTruthy()
    expect(lorebookRows().some((row) => row.dataset.risuLorebookId === 'resource-entry-a')).toBe(false)

    lorebookListMocks.queueConfirm(true)
    deleteButtonForRow(rowByEntryId('resource-entry-b')).click()
    await flushAsyncWork()

    expect(lorebookListMocks.replaceCharacterLorebookCollection).toHaveBeenCalledWith('character-resource', [])
  })

  it('renders and mutates the authoritative selected character owner when the compatibility selection is stale', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'compatibility-character',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'compatibility-entry', comment: 'Compatibility Entry' })],
        },
        {
          chaId: 'owner-character',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'owner-entry', comment: 'Owner Entry' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    charactersResourceState.currentChar = 1
    charactersResourceState.selectionRevision = 7

    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    expect(lorebookRows().map((row) => row.dataset.risuLorebookId)).toEqual(['owner-entry'])
    lorebookListMocks.queueConfirm(true)
    deleteButtonForRow(rowByEntryId('owner-entry')).click()
    await flushAsyncWork()

    expect(lorebookListMocks.replaceCharacterLorebookCollection).toHaveBeenCalledWith('owner-character', [])
  })

  it('fails closed when the selected chat id has duplicate owners', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'selected-character',
          chatPage: 0,
          chats: [
            {
              id: 'duplicate-chat',
              localLore: [makeLoreBook({ id: 'unsafe-entry', comment: 'Unsafe Entry' })],
            },
          ],
          globalLore: [],
        },
        {
          chaId: 'other-character',
          chatPage: 0,
          chats: [{ id: 'duplicate-chat', localLore: [] }],
          globalLore: [],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    charactersResourceState.currentChar = 0
    charactersResourceState.selectionRevision = 8

    resourceComponent = mount(LoreBookList, { target, props: { submenu: 1 } })
    await tick()

    expect(lorebookRows()).toHaveLength(0)
    expect(target.textContent).toContain('No Lorebook')
    expect(lorebookListMocks.replaceChatLorebookCollection).not.toHaveBeenCalled()
  })

  it('does not transfer an open row to another character with the same entry id', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-a',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'shared-entry', comment: 'Character A Entry', content: 'A prompt' })],
        },
        {
          chaId: 'character-b',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'shared-entry', comment: 'Character B Entry', content: 'B prompt' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()
    const initialSortableCount = lorebookListMocks.SortableMock.create.mock.calls.length

    toggleButtonForRow(rowByEntryId('shared-entry')).click()
    await tick()
    expect(rowByEntryId('shared-entry').textContent).toContain('Prompt')

    selectedCharID.set(1)
    await tick()

    expect(rowByEntryId('shared-entry').textContent).toContain('Character B Entry')
    expect(rowByEntryId('shared-entry').textContent).not.toContain('Prompt')
    expect(lorebookListMocks.SortableMock.create).toHaveBeenCalledTimes(initialSortableCount + 1)
  })

  it('does not carry dirty entry fields to another character with the same entry id', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-a',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'shared-entry', comment: 'Character A Entry', content: 'A prompt' })],
        },
        {
          chaId: 'character-b',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'shared-entry', comment: 'Character B Entry', content: 'B prompt' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    toggleButtonForRow(rowByEntryId('shared-entry')).click()
    await tick()
    const characterATextarea = rowByEntryId('shared-entry').querySelector<HTMLTextAreaElement>('textarea')
    expect(characterATextarea).toBeTruthy()
    characterATextarea!.value = 'Character A dirty prompt'
    characterATextarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    lorebookListMocks.applyLorebookEntryDraftEdit.mockClear()

    selectedCharID.set(1)
    await tick()
    toggleButtonForRow(rowByEntryId('shared-entry')).click()
    await tick()

    const characterBRow = rowByEntryId('shared-entry')
    const characterBTextarea = characterBRow.querySelector<HTMLTextAreaElement>('textarea')
    const characterBName = characterBRow.querySelector<HTMLInputElement>('input')
    expect(characterBTextarea?.value).toBe('B prompt')
    expect(characterBName).toBeTruthy()

    characterBName!.value = 'Updated Character B Entry'
    characterBName!.dispatchEvent(new Event('input', { bubbles: true }))
    characterBName!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    await flushAsyncWork()

    expect(lorebookListMocks.applyLorebookEntryDraftEdit).toHaveBeenLastCalledWith(
      { kind: 'character', characterId: 'character-b' },
      0,
      expect.objectContaining({
        id: 'shared-entry',
        comment: 'Updated Character B Entry',
        content: 'B prompt',
      }),
    )
  })

  it('dispatches a resource-backed local lorebook deletion for the selected chat', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-resource',
          chatPage: 1,
          chats: [
            { id: 'chat-inactive', localLore: [] },
            {
              id: 'chat-resource',
              localLore: [makeLoreBook({ id: 'chat-entry', comment: 'Chat Entry' })],
            },
          ],
          globalLore: [],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)

    resourceComponent = mount(LoreBookList, { target, props: { submenu: 1 } })
    await tick()
    lorebookListMocks.queueConfirm(true)
    deleteButtonForRow(rowByEntryId('chat-entry')).click()
    await flushAsyncWork()

    expect(lorebookListMocks.replaceChatLorebookCollection).toHaveBeenCalledWith('chat-resource', [])
  })

  it('keeps a scoped delete pending until its exact collection operation fails', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-delete-outcome',
          chatPage: 0,
          chats: [],
          globalLore: [makeLoreBook({ id: 'delete-outcome-entry', comment: 'Delete Outcome Entry' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    const deferred = deferredOperation('character:character-delete-outcome')
    lorebookListMocks.replaceCharacterLorebookCollection.mockReturnValueOnce(deferred.operation)
    lorebookListMocks.queueConfirm(true)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    deleteButtonForRow(rowByEntryId('delete-outcome-entry')).click()
    await flushAsyncWork()
    expect(target.querySelector('p[data-risu-lorebook-persistence="pending"]')).toBeNull()
    expect(deleteButtonForRow(rowByEntryId('delete-outcome-entry')).disabled).toBe(true)

    deferred.resolve({ status: 'failed', error: 'delete rejected' })
    await flushAsyncWork()
    expect(lorebookListMocks.alertError).toHaveBeenCalledWith('Lorebook change failed. delete rejected')
    expect(target.querySelector('[data-risu-lorebook-persistence="failed"]')?.textContent).toContain(
      'Lorebook change failed',
    )
  })

  it('tracks a queued local-activation cleanup from character deletion against the captured chat and entry', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-delete-local',
          chatPage: 0,
          chats: [
            {
              id: 'chat-delete-local-a',
              localLore: [makeLoreBook({ id: 'delete-local-entry', mode: 'child' })],
              message: [],
            },
            { id: 'chat-delete-local-b', localLore: [], message: [] },
          ],
          globalLore: [makeLoreBook({ id: 'delete-local-entry', comment: 'Delete Local Entry' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    const confirmation = lorebookListMocks.createDeferred<boolean>()
    const cleanup = deferredOperation('chat:chat-delete-local-a')
    const parentDelete = deferredOperation('character:character-delete-local')
    lorebookListMocks.queueConfirm(confirmation)
    lorebookListMocks.setChatLorebookLocalActivationWithOutcome.mockReturnValueOnce(cleanup.operation)
    lorebookListMocks.replaceCharacterLorebookCollection.mockReturnValueOnce(parentDelete.operation)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    deleteButtonForRow(rowByEntryId('delete-local-entry')).click()
    await tick()
    getDatabase().characters[0].chatPage = 1
    confirmation.resolve(true)
    await flushAsyncWork()

    expect(lorebookListMocks.setChatLorebookLocalActivationWithOutcome).toHaveBeenCalledWith(
      'chat-delete-local-a',
      expect.objectContaining({ id: 'delete-local-entry' }),
      false,
    )
    expect(lorebookListMocks.setActiveChatLorebookLocalActivation).not.toHaveBeenCalled()

    parentDelete.resolve({ status: 'accepted' })
    cleanup.resolve({ status: 'queued' })
    await flushAsyncWork()
    expect(lorebookListMocks.alertNormal).toHaveBeenCalledWith('Local activation cleanup queued.')
    const cleanupStatus = target.querySelector(
      '[data-risu-lorebook-mutation-context="local-activation-cleanup"][data-risu-lorebook-persistence="queued"]',
    )
    expect(cleanupStatus).toBeNull()
  })

  it('explains a failed local-activation cleanup after character deletion restores it', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-delete-local-failed',
          chatPage: 0,
          chats: [
            {
              id: 'chat-delete-local-failed',
              localLore: [makeLoreBook({ id: 'delete-local-failed-entry', mode: 'child' })],
              message: [],
            },
          ],
          globalLore: [makeLoreBook({ id: 'delete-local-failed-entry', comment: 'Delete Local Failed Entry' })],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    const cleanup = deferredOperation('chat:chat-delete-local-failed')
    const parentDelete = deferredOperation('character:character-delete-local-failed')
    lorebookListMocks.queueConfirm(true)
    lorebookListMocks.setChatLorebookLocalActivationWithOutcome.mockReturnValueOnce(cleanup.operation)
    lorebookListMocks.replaceCharacterLorebookCollection.mockReturnValueOnce(parentDelete.operation)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    deleteButtonForRow(rowByEntryId('delete-local-failed-entry')).click()
    await flushAsyncWork()
    parentDelete.resolve({ status: 'accepted' })
    cleanup.resolve({ status: 'failed', error: 'cleanup rejected' })
    await flushAsyncWork()

    expect(lorebookListMocks.alertError).toHaveBeenCalledWith(
      'Local activation cleanup failed and was restored. cleanup rejected',
    )
    expect(
      target.querySelector(
        '[data-risu-lorebook-mutation-context="local-activation-cleanup"][data-risu-lorebook-persistence="failed"]',
      )?.textContent,
    ).toContain('Local activation cleanup failed and was restored. cleanup rejected')
  })

  it('tracks a drag reorder as one scoped queued collection operation', async () => {
    setDatabaseLite({
      characters: [
        {
          chaId: 'character-reorder-outcome',
          chatPage: 0,
          chats: [],
          globalLore: [
            makeLoreBook({ id: 'reorder-a', comment: 'Reorder A' }),
            makeLoreBook({ id: 'reorder-b', comment: 'Reorder B' }),
          ],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    const deferred = deferredOperation('character:character-reorder-outcome')
    lorebookListMocks.replaceCharacterLorebookCollection.mockReturnValueOnce(deferred.operation)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    const sortable = lorebookListMocks.SortableMock.create.mock.results.at(-1)?.value as {
      element: HTMLElement
      options: { onEnd: (event: Record<string, unknown>) => Promise<void> }
    }
    const item = sortable.element.children[0] as HTMLElement
    await sortable.options.onEnd({
      from: sortable.element,
      to: sortable.element,
      item,
      oldIndex: 0,
      newIndex: 1,
    })
    await tick()

    expect(lorebookListMocks.replaceCharacterLorebookCollection).toHaveBeenCalledWith('character-reorder-outcome', [
      expect.objectContaining({ id: 'reorder-b' }),
      expect.objectContaining({ id: 'reorder-a' }),
    ])
    expect(target.querySelector('p[data-risu-lorebook-persistence="pending"]')).toBeNull()

    deferred.resolve({ status: 'queued' })
    await flushAsyncWork()
    expect(lorebookListMocks.alertNormal).toHaveBeenCalledWith('Lorebook change queued.')
    expect(target.querySelector('p[data-risu-lorebook-persistence="queued"]')).toBeNull()
  })

  it('disables local chat activation until its owner-scoped operation settles', async () => {
    setDatabaseLite({
      localActivationInGlobalLorebook: true,
      characters: [
        {
          chaId: 'character-local-activation',
          chatPage: 0,
          chats: [{ id: 'chat-local-activation', localLore: [], message: [] }],
          globalLore: [
            makeLoreBook({ id: 'local-activation-entry', comment: 'Local Activation Entry', alwaysActive: false }),
          ],
        },
      ],
      loreBook: [],
      loreBookPage: 0,
    } as Database)
    selectedCharID.set(0)
    const deferred = deferredOperation('chat:chat-local-activation')
    lorebookListMocks.setActiveChatLorebookLocalActivation.mockReturnValueOnce(deferred.operation)
    resourceComponent = mount(LoreBookList, { target, props: { submenu: 0 } })
    await tick()

    toggleButtonForRow(rowByEntryId('local-activation-entry')).click()
    await tick()
    const activation = rowByEntryId('local-activation-entry').querySelector<HTMLInputElement>(
      'input[aria-label="Always active in chat"]',
    )!
    activation.click()
    await tick()
    expect(activation.disabled).toBe(true)
    expect(target.querySelector('[data-risu-lorebook-local-activation="pending"]')).not.toBeNull()

    deferred.resolve({ status: 'failed', error: 'activation rejected' })
    await flushAsyncWork()
    expect(activation.disabled).toBe(false)
    expect(lorebookListMocks.alertError).toHaveBeenCalledWith('Lorebook change failed. activation rejected')
    expect(target.querySelector('[data-risu-lorebook-local-activation="failed"]')).not.toBeNull()
  })

  it('does not settle a clean draft after its confirmed deletion supersedes the row', async () => {
    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'global-book',
          name: 'Global Book',
          data: [makeLoreBook({ id: 'global-entry', comment: 'Global Entry' })],
        },
      ],
      loreBookPage: 0,
    } as unknown as Database)

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()
    lorebookListMocks.queueConfirm(true)
    lorebookListMocks.flushPendingLorebookEntryDraftEdit.mockClear()

    deleteButtonForRow(rowByEntryId('global-entry')).click()
    await flushAsyncWork()

    expect(lorebookListMocks.replaceGlobalLorebookEntryCollection).toHaveBeenCalledWith('global-book', [])
    expect(lorebookListMocks.flushPendingLorebookEntryDraftEdit).not.toHaveBeenCalled()
  })

  it('renders selected global lorebook entries with stable id-backed row identity', async () => {
    const initialEntries = [
      makeLoreBook({ id: 'global-entry-a', comment: 'Global Entry A', content: 'Open content' }),
      makeLoreBook({ id: 'global-entry-b', comment: 'Global Entry B' }),
    ]
    setDatabaseLite({
      characters: [],
      loreBook: [{ id: 'global-book', name: 'Global Book', data: initialEntries }],
      loreBookPage: 0,
    } as unknown as Database)

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()

    expect(lorebookRows().map((row) => row.dataset.risuLorebookId)).toEqual(['global-entry-a', 'global-entry-b'])
    const entryARow = rowByEntryId('global-entry-a')
    toggleButtonForRow(entryARow).click()
    await tick()
    expect(entryARow.textContent).toContain('Prompt')

    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'global-book',
          name: 'Global Book',
          data: cloneEntries([initialEntries[1], initialEntries[0]]),
        },
      ],
      loreBookPage: 0,
    } as unknown as Database)
    await tick()

    expect(rowByEntryId('global-entry-a')).toBe(entryARow)
    expect(entryARow.textContent).toContain('Prompt')
  })

  it('renders the owner-selected global collection when the compatibility pointer is stale', async () => {
    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'compatibility-book',
          name: 'Compatibility Book',
          data: [makeLoreBook({ id: 'compatibility-entry', comment: 'Compatibility Entry' })],
        },
        {
          id: 'owner-book',
          name: 'Owner Book',
          data: [makeLoreBook({ id: 'owner-entry', comment: 'Owner Entry' })],
        },
      ],
      loreBookPage: 0,
    } as unknown as Database)
    lorebookPageOwner.reset()
    lorebookPageOwner.hydrate({
      revision: 2,
      setting: 'loreBookPage',
      state: { present: true, value: 1 },
    })
    withTestDatabaseWrite(() => {
      getDatabase().loreBookPage = 0
    })

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()

    expect(lorebookRows().map((row) => row.dataset.risuLorebookId)).toEqual(['owner-entry'])
  })

  it('fails closed when the owner-selected global lorebook id is duplicated', async () => {
    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'duplicate-book',
          name: 'Duplicate A',
          data: [makeLoreBook({ id: 'unsafe-entry', comment: 'Unsafe Entry' })],
        },
        {
          id: 'duplicate-book',
          name: 'Duplicate B',
          data: [makeLoreBook({ id: 'other-entry', comment: 'Other Entry' })],
        },
      ],
      loreBookPage: 0,
    } as unknown as Database)
    lorebookPageOwner.hydrate({
      revision: 3,
      setting: 'loreBookPage',
      state: { present: true, value: 0 },
    })

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()

    expect(lorebookRows()).toHaveLength(0)
    expect(target.textContent).toContain('No Lorebook')
    expect(lorebookListMocks.replaceGlobalLorebookEntryCollection).not.toHaveBeenCalled()
  })

  it('fails closed when the global lorebook collection owner is in error', async () => {
    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'unsafe-book',
          name: 'Unsafe Book',
          data: [makeLoreBook({ id: 'unsafe-entry', comment: 'Unsafe Entry' })],
        },
      ],
      loreBookPage: 0,
    } as unknown as Database)
    collectionsResourceState.statuses.loreBook = 'error'

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()

    expect(lorebookRows()).toHaveLength(0)
    expect(target.textContent).toContain('No Lorebook')
    expect(lorebookListMocks.replaceGlobalLorebookEntryCollection).not.toHaveBeenCalled()
  })

  it('dispatches global entry edits and deletion to the captured lorebook id', async () => {
    const initialEntries = [
      makeLoreBook({ id: 'global-entry-a', comment: 'Global Entry A' }),
      makeLoreBook({ id: 'global-entry-b', comment: 'Global Entry B' }),
    ]
    setDatabaseLite({
      characters: [],
      loreBook: [
        { id: 'other-book', name: 'Other Book', data: [] },
        { id: 'global-book', name: 'Global Book', data: initialEntries },
      ],
      loreBookPage: 1,
    } as unknown as Database)
    lorebookPageOwner.reset()
    lorebookPageOwner.hydrate({
      revision: 1,
      setting: 'loreBookPage',
      state: { present: true, value: 1 },
    })

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()

    toggleButtonForRow(rowByEntryId('global-entry-a')).click()
    await tick()
    const nameInput = rowByEntryId('global-entry-a').querySelector<HTMLInputElement>('input')
    expect(nameInput).toBeTruthy()
    nameInput!.value = 'Updated Global Entry'
    nameInput!.dispatchEvent(new Event('input', { bubbles: true }))
    nameInput!.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    await flushAsyncWork()

    expect(lorebookListMocks.applyLorebookEntryDraftEdit).toHaveBeenCalledWith(
      { kind: 'global', lorebookId: 'global-book' },
      0,
      expect.objectContaining({ id: 'global-entry-a', comment: 'Updated Global Entry' }),
    )
    expect(lorebookListMocks.flushPendingLorebookEntryDraftEdit).toHaveBeenCalledWith({
      kind: 'global',
      lorebookId: 'global-book',
    })

    const confirm = lorebookListMocks.createDeferred<boolean>()
    lorebookListMocks.queueConfirm(confirm)
    deleteButtonForRow(rowByEntryId('global-entry-b')).click()
    await tick()

    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'global-book',
          name: 'Global Book',
          data: [
            makeLoreBook({ id: 'global-entry-x', comment: 'Inserted Global Entry' }),
            ...cloneEntries([initialEntries[1], initialEntries[0]]),
          ],
        },
        { id: 'other-book', name: 'Other Book', data: [] },
      ],
      loreBookPage: 0,
    } as unknown as Database)
    lorebookPageOwner.projectStructuralSelection(0)
    await tick()

    confirm.resolve(true)
    await flushAsyncWork()

    expect(lorebookListMocks.replaceGlobalLorebookEntryCollection).toHaveBeenCalledWith('global-book', [
      expect.objectContaining({ id: 'global-entry-x' }),
      expect.objectContaining({ id: 'global-entry-a' }),
    ])
  })

  it('settles a global entry edit when the row always-active button is toggled', async () => {
    setDatabaseLite({
      characters: [],
      loreBook: [
        {
          id: 'global-book',
          name: 'Global Book',
          data: [makeLoreBook({ id: 'global-entry', comment: 'Global Entry', alwaysActive: false })],
        },
      ],
      loreBookPage: 0,
    } as unknown as Database)

    resourceComponent = mount(LoreBookList, { target, props: { globalMode: true } })
    await tick()

    const row = rowByEntryId('global-entry')
    const toggle = row.querySelector<HTMLButtonElement>('button[aria-label^="Enable: Always active"]')
    expect(toggle).toBeTruthy()
    toggle!.click()
    await flushAsyncWork()

    expect(lorebookListMocks.applyLorebookEntryDraftEdit).toHaveBeenCalledWith(
      { kind: 'global', lorebookId: 'global-book' },
      0,
      expect.objectContaining({ id: 'global-entry', alwaysActive: true }),
    )
    expect(lorebookListMocks.flushPendingLorebookEntryDraftEdit).toHaveBeenCalledWith({
      kind: 'global',
      lorebookId: 'global-book',
    })
  })

  it('captures an edited lorebook row after it is collapsed and before demotion unmounts it', async () => {
    await beginWriterDraftCaptureTest()
    try {
      component = mountHarness([makeLoreBook({ id: 'entry-capture', comment: 'Capture me', content: 'original lore' })])
      await flushAsyncWork()
      const row = rowByEntryId('entry-capture')
      toggleButtonForRow(row).click()
      await flushAsyncWork()
      const editor = row.querySelector<HTMLTextAreaElement | HTMLDivElement>('textarea, [contenteditable="true"]')!
      expect(editor).toBeTruthy()
      if (editor instanceof HTMLTextAreaElement) editor.value = 'newest lore draft'
      else editor.textContent = 'newest lore draft'
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
      await flushAsyncWork()
      toggleButtonForRow(row).click()
      await flushAsyncWork()
      demoteClientSession()
      expect(capturedWriterDrafts()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({ id: 'entry-capture', content: 'newest lore draft' }),
            baseline: expect.objectContaining({ content: 'original lore' }),
          }),
        ]),
      )
    } finally {
      if (component) {
        await unmount(component)
        component = undefined
      }
      await endWriterDraftCaptureTest()
    }
  })
})
