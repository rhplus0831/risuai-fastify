import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { flushSync, mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serverMocks = vi.hoisted(() => ({
  listServerMemorySummaries: vi.fn(),
  patchServerMemorySummary: vi.fn(),
  deleteServerMemorySummary: vi.fn(),
  listServerMemoryJobs: vi.fn(),
  cancelServerMemoryJob: vi.fn(),
  hydrateChatMessages: vi.fn<(...args: unknown[]) => Promise<void>>(),
  summarize: vi.fn<(...args: unknown[]) => Promise<string>>(),
  memoryJobListeners: new Set<(event: any) => void>(),
  alertConfirm: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('src/ts/alert', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/alert')>()
  return { ...actual, alertConfirm: serverMocks.alertConfirm }
})

vi.mock('src/ts/process/memory/hypav3', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/process/memory/hypav3')>()
  return { ...actual, summarize: serverMocks.summarize }
})

vi.mock('src/ts/process/modules', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/process/modules')>()
  return {
    ...actual,
    getModuleTriggers: () => [],
    moduleUpdate: () => undefined,
  }
})

vi.mock('src/ts/process/request/serverMemory', () => ({
  canUseServerMemoryApi: () => true,
  cancelServerMemoryJob: serverMocks.cancelServerMemoryJob,
  deleteServerMemorySummary: serverMocks.deleteServerMemorySummary,
  listServerMemoryJobs: serverMocks.listServerMemoryJobs,
  listServerMemorySummaries: serverMocks.listServerMemorySummaries,
  patchServerMemorySummary: serverMocks.patchServerMemorySummary,
}))

vi.mock('src/ts/server/chatMessageHydration.svelte', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/server/chatMessageHydration.svelte')>()
  return {
    ...actual,
    hydrateChatMessages: serverMocks.hydrateChatMessages,
  }
})

vi.mock('src/ts/server/memoryJobEvents', () => ({
  subscribeServerMemoryJobEvents: (listener: (event: any) => void) => {
    serverMocks.memoryJobListeners.add(listener)
    return () => serverMocks.memoryJobListeners.delete(listener)
  },
}))

import HypaV3Modal from './HypaV3Modal.svelte'
import { language } from 'src/lang'
import { hypaV3ModalOpen, selectedCharID } from 'src/ts/stores.svelte'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = ReturnType<typeof mount>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function seedDatabase(categories = [{ id: '', name: 'Unclassified' }], summarizationModel = 'test-model'): void {
  selectedCharID.set(0)
  setDatabaseLite({
    hypaV3PresetId: 0,
    selectedHypaV3PresetId: 'memory-default',
    hypaV3Presets: [
      { id: 'memory-default', name: 'Default', settings: { processRegexScript: false, summarizationModel } },
    ],
    characters: [
      {
        chaId: 'character-a',
        name: 'Character',
        image: '',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            name: 'Chat A',
            message: [
              { chatId: 'message-a', role: 'user', data: 'Message A' },
              { chatId: 'message-b', role: 'char', data: 'Message B' },
              { chatId: 'message-c', role: 'user', data: 'Message C' },
            ],
            note: '',
            localLore: [],
            hypaV3Data: {
              summaries: [],
              categories,
              lastSelectedSummaries: [],
            },
          },
        ],
        type: 'character',
      },
    ],
  } as never)
}

async function settle(): Promise<void> {
  flushSync()
  for (let index = 0; index < 6; index += 1) {
    await tick()
    await Promise.resolve()
  }
}

function serverSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'summary-a',
    chatId: 'chat-a',
    chunkId: 'chunk-a',
    model: 'test-model',
    text: 'Persisted summary',
    metadata: { chatMemos: ['message-a'], isImportant: false },
    tokens: 4,
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  }
}

function editSummary(target: HTMLElement, value: string): HTMLTextAreaElement {
  const textarea = Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
    (candidate) => candidate.value === 'Persisted summary',
  )
  if (!textarea) throw new Error('Missing server summary textarea')
  textarea.focus()
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  return textarea
}

function closeModal(target: HTMLElement): void {
  const closeButton = target.querySelector<HTMLButtonElement>(
    `button[aria-label="${language.hypaV3Modal.closeAction}"]`,
  )
  if (!closeButton) throw new Error('Missing Hypa V3 close button')
  closeButton.click()
}

describe('Hypa V3 server summary close reliability', () => {
  let target: HTMLElement
  let component: MountedComponent | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    seedDatabase()
    hypaV3ModalOpen.set(true)
    serverMocks.listServerMemorySummaries.mockResolvedValue({ status: 'ok', summaries: [serverSummary()] })
    serverMocks.patchServerMemorySummary.mockResolvedValue({ status: 'ok', summaryId: 'summary-a' })
    serverMocks.deleteServerMemorySummary.mockResolvedValue({ status: 'ok', summaryId: 'summary-a' })
    serverMocks.listServerMemoryJobs.mockResolvedValue({ status: 'ok', jobs: [], etag: 'jobs-a' })
    serverMocks.hydrateChatMessages.mockResolvedValue(undefined)
    serverMocks.summarize.mockResolvedValue('Rerolled summary')
    serverMocks.memoryJobListeners.clear()
    serverMocks.alertConfirm.mockResolvedValue(true)
    target = document.createElement('div')
    document.body.appendChild(target)
  })

  afterEach(() => {
    if (component) {
      unmount(component)
      component = undefined
    }
    hypaV3ModalOpen.set(false)
    target.remove()
  })

  it('waits for the focused dirty summary PATCH before Escape closes the modal', async () => {
    const patch = deferred<{ status: 'ok'; summaryId: string }>()
    serverMocks.patchServerMemorySummary.mockReturnValueOnce(patch.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const textarea = editSummary(target, 'Edited before Escape')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledWith('summary-a', {
        text: 'Edited before Escape',
      }),
    )
    expect(get(hypaV3ModalOpen)).toBe(true)

    patch.resolve({ status: 'ok', summaryId: 'summary-a' })
    await vi.waitFor(() => expect(get(hypaV3ModalOpen)).toBe(false))
    expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1)
  })

  it('marks summaries excluded by the active model and scopes the footer to generation-compatible rows', async () => {
    seedDatabase([{ id: '', name: 'Unclassified' }], 'model-b')
    serverMocks.listServerMemorySummaries.mockResolvedValue({
      status: 'ok',
      summaries: [
        serverSummary({ id: 'active-shadowed', chunkId: 'shared-chunk', model: 'model-b' }),
        serverSummary({
          id: 'legacy-preferred',
          chunkId: 'shared-chunk',
          model: 'legacy-hypav3',
          metadata: { chatMemos: ['message-b'], isImportant: false },
        }),
        serverSummary({
          id: 'inactive-model',
          chunkId: 'inactive-chunk',
          model: 'model-a',
          metadata: { chatMemos: ['message-c'], isImportant: false },
        }),
      ],
    })

    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    expect(
      Array.from(target.querySelectorAll('[data-inactive-summary-model]'), (badge) => badge.textContent?.trim()),
    ).toEqual([
      language.hypaV3Modal.inactiveSummaryModelLabel.replace('{0}', 'model-b'),
      language.hypaV3Modal.inactiveSummaryModelLabel.replace('{0}', 'model-a'),
    ])
    await vi.waitFor(() =>
      expect(target.querySelector<HTMLTextAreaElement>('textarea[readonly]')?.value).toBe('Message C'),
    )
  })

  it('keeps active row work and view state mounted across an identical background refresh', async () => {
    const reroll = deferred<string>()
    const refresh = deferred<{ status: 'ok'; summaries: ReturnType<typeof serverSummary>[] }>()
    const persistedSummary = serverSummary()
    serverMocks.summarize.mockReturnValueOnce(reroll.promise)
    serverMocks.listServerMemorySummaries.mockResolvedValueOnce({ status: 'ok', summaries: [persistedSummary] })
    serverMocks.listServerMemorySummaries.mockReturnValueOnce(refresh.promise)

    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const summaryTextarea = Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
      (textarea) => textarea.value === 'Persisted summary',
    )
    if (!summaryTextarea) throw new Error('Missing persisted summary')

    target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hypaV3Modal.searchAction}"]`)?.click()
    await settle()
    const searchInput = target.querySelector<HTMLInputElement>(
      `input[aria-label="${language.hypaV3Modal.searchAction}"]`,
    )
    if (!searchInput) throw new Error('Missing summary search input')
    searchInput.value = 'persisted'
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))

    const connectedMessagesToggle = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(language.hypaV3Modal.connectedMessageCountLabel.replace('{0}', '1')),
    )
    connectedMessagesToggle?.click()
    await settle()
    target.querySelector<HTMLButtonElement>('[data-chat-memo="message-a"]')?.click()
    await vi.waitFor(() =>
      expect(
        Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).some(
          (textarea) => textarea.value === 'Message A',
        ),
      ).toBe(true),
    )
    target.querySelector<HTMLButtonElement>('[data-summary-action="reroll"]')?.click()
    await vi.waitFor(() => expect(serverMocks.summarize).toHaveBeenCalledOnce())

    for (const listener of serverMocks.memoryJobListeners) {
      listener({ chatId: 'chat-a', job: { kind: 'summarize', status: 'completed' } })
    }
    await vi.waitFor(() => expect(serverMocks.listServerMemorySummaries).toHaveBeenCalledTimes(2))

    expect(
      Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
        (textarea) => textarea.value === 'Persisted summary',
      ),
    ).toBe(summaryTextarea)
    expect(searchInput.value).toBe('persisted')

    refresh.resolve({ status: 'ok', summaries: [persistedSummary] })
    await settle()
    reroll.resolve('Reroll preserved after refresh')

    await vi.waitFor(() =>
      expect(
        Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).some(
          (textarea) => textarea.value === 'Reroll preserved after refresh',
        ),
      ).toBe(true),
    )
    expect(searchInput.value).toBe('persisted')
    expect(
      Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).some(
        (textarea) => textarea.value === 'Message A',
      ),
    ).toBe(true)
  })

  it('preserves a manual important-filter choice across same-chat summary refreshes', async () => {
    const summaries = [
      serverSummary({
        id: 'important-summary',
        chunkId: 'important-chunk',
        text: 'Important summary',
        metadata: { chatMemos: ['message-a'], isImportant: true },
      }),
      serverSummary({
        id: 'ordinary-summary',
        chunkId: 'ordinary-chunk',
        text: 'Ordinary summary',
        metadata: { chatMemos: ['message-b'], isImportant: false },
      }),
    ]
    serverMocks.listServerMemorySummaries.mockResolvedValue({ status: 'ok', summaries })

    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const visibleSummaryValues = () =>
      Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea:not([readonly])'), (textarea) => textarea.value)
    expect(visibleSummaryValues()).toEqual(['Important summary'])

    target
      .querySelector<HTMLButtonElement>(`button[aria-label="${language.hypaV3Modal.importantFilterAction}"]`)
      ?.click()
    await settle()
    expect(visibleSummaryValues()).toEqual(['Important summary', 'Ordinary summary'])

    for (const listener of serverMocks.memoryJobListeners) {
      listener({ chatId: 'chat-a', job: { kind: 'summarize', status: 'completed' } })
    }
    await vi.waitFor(() => expect(serverMocks.listServerMemorySummaries).toHaveBeenCalledTimes(2))
    await settle()

    expect(visibleSummaryValues()).toEqual(['Important summary', 'Ordinary summary'])
  })

  it('keeps a failed summary-delete error visible after a successful reconcile', async () => {
    serverMocks.deleteServerMemorySummary.mockResolvedValueOnce({ status: 'error', error: 'DELETE rejected' })

    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hypaV3Modal.deleteSummaryAction}"]`)?.click()

    await vi.waitFor(() => expect(serverMocks.deleteServerMemorySummary).toHaveBeenCalledWith('summary-a'))
    await vi.waitFor(() => expect(serverMocks.listServerMemorySummaries).toHaveBeenCalledTimes(2))

    expect(target.textContent).toContain('DELETE rejected')
    expect(
      Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).some(
        (textarea) => textarea.value === 'Persisted summary',
      ),
    ).toBe(true)
  })

  it('keeps the modal open when a close-button flush fails', async () => {
    const patch = deferred<{ status: 'error'; error: string }>()
    serverMocks.patchServerMemorySummary.mockReturnValueOnce(patch.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    editSummary(target, 'Edit that cannot persist')
    closeModal(target)
    closeModal(target)

    await vi.waitFor(() => expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1))
    expect(get(hypaV3ModalOpen)).toBe(true)

    patch.resolve({ status: 'error', error: 'PATCH rejected' })
    await settle()
    expect(get(hypaV3ModalOpen)).toBe(true)
    expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1)
    expect(serverMocks.alertConfirm).not.toHaveBeenCalled()
  })

  it('offers to discard dirty summary text after a second failed close attempt', async () => {
    serverMocks.patchServerMemorySummary.mockResolvedValue({ status: 'error', error: 'PATCH rejected' })
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const textarea = editSummary(target, 'Edit to discard')
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1))
    await settle()
    expect(get(hypaV3ModalOpen)).toBe(true)
    expect(serverMocks.alertConfirm).not.toHaveBeenCalled()

    closeModal(target)

    await vi.waitFor(() =>
      expect(serverMocks.alertConfirm).toHaveBeenCalledWith(language.hypaV3Modal.discardFailedSummaryChangesConfirm),
    )
    await vi.waitFor(() => expect(get(hypaV3ModalOpen)).toBe(false))
    expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(2)
  })

  it('keeps declined text edits and closes without another prompt when persistence recovers', async () => {
    serverMocks.patchServerMemorySummary
      .mockResolvedValueOnce({ status: 'error', error: 'First PATCH rejected' })
      .mockResolvedValueOnce({ status: 'error', error: 'Second PATCH rejected' })
    serverMocks.alertConfirm.mockResolvedValue(false)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    editSummary(target, 'Edit to retry')
    closeModal(target)
    await vi.waitFor(() => expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1))
    await settle()

    closeModal(target)
    await vi.waitFor(() => expect(serverMocks.alertConfirm).toHaveBeenCalledTimes(1))
    await settle()

    expect(get(hypaV3ModalOpen)).toBe(true)
    expect(
      Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).some(
        (textarea) => textarea.value === 'Edit to retry',
      ),
    ).toBe(true)

    closeModal(target)
    await vi.waitFor(() => expect(get(hypaV3ModalOpen)).toBe(false))
    expect(serverMocks.patchServerMemorySummary).toHaveBeenLastCalledWith('summary-a', {
      text: 'Edit to retry',
    })
    expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(3)
    expect(serverMocks.alertConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not let an old discard confirmation close or count against a newly selected chat', async () => {
    const discardConfirmation = deferred<boolean>()
    const character = getDatabase().characters[0]
    character.chats.push({
      id: 'chat-b',
      name: 'Chat B',
      message: [{ chatId: 'message-d', role: 'user', data: 'Message D' }],
      note: '',
      localLore: [],
      hypaV3Data: {
        summaries: [],
        categories: [{ id: '', name: 'Unclassified' }],
        lastSelectedSummaries: [],
      },
    })
    serverMocks.listServerMemorySummaries.mockImplementation(async (chatId: string) => ({
      status: 'ok',
      summaries: [
        serverSummary(
          chatId === 'chat-b'
            ? {
                id: 'summary-b',
                chatId: 'chat-b',
                chunkId: 'chunk-b',
                text: 'Second persisted summary',
                metadata: { chatMemos: ['message-d'], isImportant: false },
              }
            : {},
        ),
      ],
    }))
    serverMocks.patchServerMemorySummary.mockResolvedValue({ status: 'error', error: 'PATCH rejected' })
    serverMocks.alertConfirm.mockReturnValue(discardConfirmation.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    editSummary(target, 'Old chat edit')
    closeModal(target)
    await vi.waitFor(() => expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1))
    await settle()
    closeModal(target)
    await vi.waitFor(() => expect(serverMocks.alertConfirm).toHaveBeenCalledTimes(1))

    character.chatPage = 1
    await vi.waitFor(() =>
      expect(
        Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).some(
          (textarea) => textarea.value === 'Second persisted summary',
        ),
      ).toBe(true),
    )
    const newChatTextarea = Array.from(target.querySelectorAll<HTMLTextAreaElement>('textarea')).find(
      (textarea) => textarea.value === 'Second persisted summary',
    )
    if (!newChatTextarea) throw new Error('Missing new chat summary textarea')
    newChatTextarea.value = 'New chat edit'
    newChatTextarea.dispatchEvent(new Event('input', { bubbles: true }))

    discardConfirmation.resolve(true)
    await settle()

    expect(get(hypaV3ModalOpen)).toBe(true)
    expect(newChatTextarea.value).toBe('New chat edit')

    closeModal(target)
    await vi.waitFor(() => expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(3))
    await settle()
    expect(get(hypaV3ModalOpen)).toBe(true)
    expect(serverMocks.alertConfirm).toHaveBeenCalledTimes(1)
  })

  it('waits for an Important metadata PATCH before closing', async () => {
    const patch = deferred<{ status: 'ok'; summaryId: string }>()
    serverMocks.patchServerMemorySummary.mockReturnValueOnce(patch.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    target.querySelector<HTMLButtonElement>('button[data-summary-action="important"]')?.click()
    await vi.waitFor(() =>
      expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledWith('summary-a', { isImportant: true }),
    )
    closeModal(target)
    expect(get(hypaV3ModalOpen)).toBe(true)

    patch.resolve({ status: 'ok', summaryId: 'summary-a' })
    await vi.waitFor(() => expect(get(hypaV3ModalOpen)).toBe(false))
  })

  it('waits for a category metadata PATCH before closing', async () => {
    seedDatabase([
      { id: '', name: 'Unclassified' },
      { id: 'story', name: 'Story' },
    ])
    const patch = deferred<{ status: 'ok'; summaryId: string }>()
    serverMocks.patchServerMemorySummary.mockReturnValueOnce(patch.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const category = target.querySelector<HTMLSelectElement>(
      `select[aria-label="${language.hypaV3Modal.summaryCategoryLabel.replace('{0}', '1')}"]`,
    )
    if (!category) throw new Error('Missing summary category control')
    category.value = 'story'
    category.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() =>
      expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledWith('summary-a', { categoryId: 'story' }),
    )
    closeModal(target)
    expect(get(hypaV3ModalOpen)).toBe(true)

    patch.resolve({ status: 'ok', summaryId: 'summary-a' })
    await vi.waitFor(() => expect(get(hypaV3ModalOpen)).toBe(false))
  })

  it('waits for a tag metadata PATCH before closing', async () => {
    const patch = deferred<{ status: 'ok'; summaryId: string }>()
    serverMocks.patchServerMemorySummary.mockReturnValueOnce(patch.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const openTags = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(`+ ${language.hypaV3Modal.tag}`),
    )
    if (!openTags) throw new Error('Missing summary tag manager control')
    openTags.click()
    await settle()
    const tagInput = target.querySelector<HTMLInputElement>(`input[aria-label="${language.hypaV3Modal.newTagName}"]`)
    if (!tagInput) throw new Error('Missing new tag input')
    tagInput.value = 'new-tag'
    tagInput.dispatchEvent(new Event('input', { bubbles: true }))
    tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() =>
      expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledWith('summary-a', { tags: ['new-tag'] }),
    )
    target.querySelector<HTMLButtonElement>(`button[aria-label="${language.close}"]`)?.click()
    await settle()
    closeModal(target)
    expect(get(hypaV3ModalOpen)).toBe(true)

    patch.resolve({ status: 'ok', summaryId: 'summary-a' })
    await vi.waitFor(() => expect(get(hypaV3ModalOpen)).toBe(false))
  })

  it('keeps the modal open when a metadata save fails during close', async () => {
    const patch = deferred<{ status: 'error'; error: string }>()
    serverMocks.patchServerMemorySummary.mockReturnValueOnce(patch.promise)
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    target.querySelector<HTMLButtonElement>('button[data-summary-action="important"]')?.click()
    await vi.waitFor(() => expect(serverMocks.patchServerMemorySummary).toHaveBeenCalledTimes(1))
    closeModal(target)
    patch.resolve({ status: 'error', error: 'metadata PATCH rejected' })
    await settle()

    expect(get(hypaV3ModalOpen)).toBe(true)
    await vi.waitFor(() => expect(target.textContent).toContain('metadata PATCH rejected'))
  })

  it('reconciles categories that hydrate after summaries without refetching or patching', async () => {
    serverMocks.listServerMemorySummaries.mockResolvedValue({
      status: 'ok',
      summaries: [
        {
          ...serverSummary(),
          metadata: { chatMemos: ['message-a'], isImportant: true, categoryId: 'story' },
        },
      ],
    })
    component = mount(HypaV3Modal, { target }) as MountedComponent
    await settle()

    const initialSelect = target.querySelector<HTMLSelectElement>(
      `select[aria-label="${language.hypaV3Modal.summaryCategoryLabel.replace('{0}', '1')}"]`,
    )
    expect(initialSelect?.value).toBe('story')
    expect(Array.from(initialSelect?.options ?? []).find((option) => option.value === 'story')?.text).toBe('story')

    seedDatabase([
      { id: '', name: 'Unclassified' },
      { id: 'story', name: 'Story' },
    ])
    await settle()

    const hydratedSelect = target.querySelector<HTMLSelectElement>(
      `select[aria-label="${language.hypaV3Modal.summaryCategoryLabel.replace('{0}', '1')}"]`,
    )
    expect(hydratedSelect?.value).toBe('story')
    expect(Array.from(hydratedSelect?.options ?? []).find((option) => option.value === 'story')?.text).toBe('Story')
    expect(serverMocks.listServerMemorySummaries).toHaveBeenCalledTimes(1)
    expect(serverMocks.patchServerMemorySummary).not.toHaveBeenCalled()
  })

  it('retains summary text before blur and before modal teardown', async () => {
    await beginWriterDraftCaptureTest()
    try {
      component = mount(HypaV3Modal, { target }) as MountedComponent
      await settle()
      editSummary(target, 'Unsubmitted memory summary')
      demoteClientSession()
      const draft = capturedWriterDrafts().find((draft) => draft.key === 'memory-summaries:chat-a')!
      expect(draft.data).toMatchObject({ summaries: [{ serverId: 'summary-a', text: 'Unsubmitted memory summary' }] })
      expect(serverMocks.patchServerMemorySummary).not.toHaveBeenCalled()
      await unmount(component)
      component = undefined
      expect(capturedWriterDrafts().find((draft) => draft.key === 'memory-summaries:chat-a')).toBeDefined()
    } finally {
      if (component) {
        await unmount(component)
        component = undefined
      }
      await endWriterDraftCaptureTest()
    }
  })
})
