import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS, BARDWIKI_PROTOCOL_VERSION } from '@risuai/protocol'

const reads = vi.hoisted(() => ({
  chat: vi.fn(),
  document: vi.fn(),
  versions: vi.fn(),
}))

const mutations = vi.hoisted(() => ({
  settings: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  rebuildPreview: vi.fn(),
  rebuildQueue: vi.fn(),
  vaultExport: vi.fn(),
  vaultPreview: vi.fn(),
  vaultImport: vi.fn(),
}))

const jobActions = vi.hoisted(() => ({
  retry: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('src/ts/server/resourceReads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/ts/server/resourceReads')>()),
  fetchServerBardWikiChat: reads.chat,
  fetchServerBardWikiDocument: reads.document,
  fetchServerBardWikiVersions: reads.versions,
}))

vi.mock('src/ts/server/bardWikiCommands', () => ({
  saveBardWikiChatSettings: mutations.settings,
  createBardWikiDocument: mutations.create,
  updateBardWikiDocument: mutations.update,
  deleteBardWikiDocument: mutations.remove,
  confirmBardWikiAssistant: mutations.confirm,
  previewBardWikiRebuild: mutations.rebuildPreview,
  queueBardWikiRebuild: mutations.rebuildQueue,
  exportBardWikiVault: mutations.vaultExport,
  previewBardWikiVaultImport: mutations.vaultPreview,
  importBardWikiVault: mutations.vaultImport,
}))

vi.mock('src/ts/process/request/serverBardWikiJobs', () => ({
  retryServerBardWikiJob: jobActions.retry,
  cancelServerBardWikiJob: jobActions.cancel,
}))

import BardWikiWorkspace from './BardWikiWorkspace.svelte'
import { applyBardWikiChatResource, resetBardWikiResource } from 'src/ts/server/bardWikiResource'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

const index = {
  id: 'document-a',
  chatId: 'chat-a',
  kind: 'location' as const,
  title: 'Old Tavern',
  logicalPath: 'Places/Old Tavern',
  normalizedPath: 'places/old tavern',
  aliases: ['Tavern'],
  contextPolicy: 'relevant' as const,
  reviewState: 'active' as const,
  contentHash: 'a'.repeat(64),
  version: 1,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
}

const chatResource = {
  status: 'ok' as const,
  protocolVersion: BARDWIKI_PROTOCOL_VERSION,
  revision: 4,
  chatId: 'chat-a',
  globalSettings: DEFAULT_BARDWIKI_GLOBAL_SETTINGS,
  chatSettings: null,
  effectiveSettings: { ...DEFAULT_BARDWIKI_GLOBAL_SETTINGS, enabledByDefault: true },
  confirmationCandidate: {
    userMessageId: 'user-a',
    userContentHash: 'a'.repeat(64),
    assistantMessageId: 'assistant-a',
    assistantContentHash: 'b'.repeat(64),
  },
  documents: [index],
  receipts: [],
  jobs: [],
}

const documentResource = {
  status: 'ok' as const,
  protocolVersion: BARDWIKI_PROTOCOL_VERSION,
  revision: 4,
  chatId: 'chat-a',
  document: { ...index, markdown: '# Old Tavern', deletedAt: null },
  links: [],
}

let component: MountedComponent | undefined
let target: HTMLElement

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await tick()
    await Promise.resolve()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true),
  )
  resetBardWikiResource()
  reads.chat.mockReset().mockResolvedValue(chatResource)
  reads.document.mockReset().mockResolvedValue(documentResource)
  reads.versions.mockReset().mockResolvedValue({
    status: 'ok',
    protocolVersion: BARDWIKI_PROTOCOL_VERSION,
    revision: 4,
    chatId: 'chat-a',
    documentId: 'document-a',
    versions: [
      {
        documentId: 'document-a',
        version: 1,
        kind: 'location',
        title: 'Old Tavern',
        logicalPath: 'Places/Old Tavern',
        normalizedPath: 'places/old tavern',
        aliases: ['Tavern'],
        contextPolicy: 'relevant',
        reviewState: 'active',
        markdown: '# Old Tavern',
        contentHash: 'a'.repeat(64),
        deleted: false,
        actor: 'user',
        reason: 'create',
        receiptId: null,
        jobId: null,
        commandRevision: 4,
        createdAt: '2026-08-29T00:00:00.000Z',
      },
    ],
    nextBeforeVersion: null,
  })
  const accepted = {
    status: 'ok',
    revision: 5,
    event: { type: 'bardwiki.updated', revision: 5, resource: 'bardWikiDocument' },
    document: documentResource.document,
  }
  mutations.settings.mockReset().mockResolvedValue({ status: 'accepted', result: { ...accepted, settings: {} } })
  mutations.create.mockReset().mockResolvedValue({ status: 'accepted', result: accepted })
  mutations.update.mockReset().mockResolvedValue({ status: 'accepted', result: accepted })
  mutations.remove.mockReset().mockResolvedValue({ status: 'accepted', result: accepted })
  mutations.confirm.mockReset().mockResolvedValue({
    status: 'accepted',
    result: { status: 'ok', revision: 5, created: true },
  })
  mutations.rebuildPreview.mockReset().mockResolvedValue({
    status: 'ok',
    revision: 4,
    preview: {
      chatId: 'chat-a',
      policy: 'full',
      sourceCount: 3,
      replaceDerivedDocumentCount: 1,
      preserveUserDocumentCount: 2,
      activeJobId: null,
    },
  })
  mutations.rebuildQueue.mockReset().mockResolvedValue({
    status: 'accepted',
    result: { status: 'ok', revision: 5, job: { id: 'rebuild-a' } },
  })
  mutations.vaultExport.mockReset().mockResolvedValue({ status: 'ok', archive: new Blob(['zip']) })
  mutations.vaultPreview.mockReset()
  mutations.vaultImport.mockReset()
  jobActions.retry.mockReset()
  jobActions.cancel.mockReset()
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) unmount(component)
  component = undefined
  target.remove()
  vi.unstubAllGlobals()
})

describe('BardWiki workspace', () => {
  it('offers one guided zero-document workflow and routes each CTA into the existing safe stage', async () => {
    reads.chat.mockResolvedValue({ ...chatResource, documents: [] })
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const empty = target.querySelector<HTMLElement>('[data-risu-bardwiki-guided-empty]')!
    expect(empty.textContent).toContain(language.bardWiki.emptyWorkspaceTitle)
    expect(target.querySelector('aside')).toBeNull()

    const build = Array.from(empty.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === language.bardWiki.buildFromChat,
    )!
    build.click()
    await settle()
    expect(target.querySelector<HTMLDetailsElement>('[data-testid="bardwiki-lifecycle"]')?.open).toBe(true)
    expect(document.activeElement?.textContent).toBe(language.bardWiki.previewRebuild)

    const importVault = Array.from(empty.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === language.bardWiki.importVault,
    )!
    importVault.click()
    await settle()
    expect(document.activeElement).toBe(target.querySelector('input[type="file"]'))

    const create = Array.from(empty.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === language.bardWiki.createFirstDocument,
    )!
    create.click()
    await settle()
    expect(target.querySelector('[data-testid="bardwiki-document-detail"]')).not.toBeNull()
    expect(target.querySelector('[data-risu-bardwiki-guided-empty]')).toBeNull()
  })

  it('loads only the chat index until a document and its history are requested', async () => {
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    expect(reads.chat).toHaveBeenCalledWith('chat-a', undefined)
    expect(reads.document).not.toHaveBeenCalled()
    expect(reads.versions).not.toHaveBeenCalled()
    const dialog = target.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.getAttribute('aria-labelledby')).toBe('bardwiki-workspace-title')

    target.querySelector<HTMLButtonElement>('[aria-label="Open Old Tavern"]')?.click()
    await settle()

    expect(reads.document).toHaveBeenCalledWith('chat-a', 'document-a', undefined)
    expect(reads.versions).not.toHaveBeenCalled()
    expect(target.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# Old Tavern')

    target.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click()
    await settle()

    expect(reads.versions).toHaveBeenCalledWith('chat-a', 'document-a', {
      signal: undefined,
    })
    expect(target.textContent).toContain('Version 1')
  })

  it('uses list-then-detail mobile navigation without discarding the active document draft', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    )
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const list = target.querySelector<HTMLElement>('[data-risu-bardwiki-pane="documents"]')!
    const detail = target.querySelector<HTMLElement>('[data-risu-bardwiki-pane="detail"]')!
    expect(list.classList.contains('hidden')).toBe(false)
    expect(detail.classList.contains('hidden')).toBe(true)

    const documentButton = target.querySelector<HTMLButtonElement>('[data-risu-bardwiki-document-id="document-a"]')!
    documentButton.click()
    await settle()
    expect(list.classList.contains('hidden')).toBe(true)
    expect(detail.classList.contains('hidden')).toBe(false)
    const back = target.querySelector<HTMLButtonElement>('[data-risu-bardwiki-back-to-documents]')!
    expect(document.activeElement).toBe(back)

    const markdown = detail.querySelector<HTMLTextAreaElement>('textarea')!
    markdown.value = '# Unsaved mobile draft'
    markdown.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    back.click()
    await settle()
    expect(list.classList.contains('hidden')).toBe(false)
    expect(detail.classList.contains('hidden')).toBe(true)
    expect(document.activeElement).toBe(documentButton)

    documentButton.click()
    await settle()
    expect(markdown.value).toBe('# Unsaved mobile draft')
    expect(reads.document).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(back)
  })

  it('explicitly confirms the authoritative latest source candidate', async () => {
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const confirm = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === language.bardWiki.confirmLatestTurn,
    )
    expect(confirm?.disabled).toBe(false)
    confirm?.click()
    await settle()

    expect(mutations.confirm).toHaveBeenCalledWith('chat-a', chatResource.confirmationCandidate)
    expect(target.textContent).toContain(language.bardWiki.confirmationQueued)
    expect(reads.chat).toHaveBeenCalledTimes(2)
  })

  it('shows distinct unavailable and retry states', async () => {
    reads.chat.mockResolvedValueOnce({ status: 'unavailable' })
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    expect(target.querySelector('[role="alert"]')?.textContent).toContain('offline')
    reads.chat.mockResolvedValueOnce(chatResource)
    target.querySelector<HTMLButtonElement>('[aria-label="Retry loading BardWiki"]')?.click()
    await settle()

    expect(reads.chat).toHaveBeenCalledTimes(2)
    expect(target.querySelector('[aria-label="Open Old Tavern"]')).toBeTruthy()
  })

  it('closes a clean workspace with Escape from the trapped dialog', async () => {
    const close = vi.fn()
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a', close } })
    await settle()

    target
      .querySelector<HTMLElement>('[role="dialog"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(close).toHaveBeenCalledOnce()
  })

  it('offers discard/reload and preserves a retrying draft behind the refreshed fence', async () => {
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()
    target.querySelector<HTMLButtonElement>('[aria-label="Open Old Tavern"]')?.click()
    await settle()

    const markdown = target.querySelector<HTMLTextAreaElement>('textarea')!
    markdown.value = '# My draft'
    markdown.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    mutations.update.mockResolvedValueOnce({
      status: 'conflict',
      result: { status: 'error', error: 'bardwiki_document_conflict' },
    })
    target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await settle()

    expect(target.querySelector('[role="alert"]')?.textContent).toContain('newer server version')
    expect(target.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# My draft')

    const latest = {
      ...documentResource,
      revision: 5,
      document: {
        ...documentResource.document,
        version: 2,
        contentHash: 'b'.repeat(64),
        markdown: '# Server version',
      },
    }
    reads.document.mockResolvedValueOnce(latest).mockResolvedValue(latest)
    const discard = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Discard draft and reload'),
    )
    discard?.click()
    await settle()
    expect(target.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('# Server version')

    const secondDraft = target.querySelector<HTMLTextAreaElement>('textarea')!
    secondDraft.value = '# My second draft'
    secondDraft.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    mutations.update.mockResolvedValueOnce({
      status: 'conflict',
      result: { status: 'error', error: 'bardwiki_document_conflict' },
    })
    target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await settle()
    const newest = {
      ...latest,
      revision: 6,
      document: { ...latest.document, version: 3, contentHash: 'c'.repeat(64), markdown: '# Newest server version' },
    }
    reads.document.mockResolvedValueOnce(newest).mockResolvedValue(newest)
    const retry = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Keep draft and retry'),
    )
    retry?.click()
    await settle()

    expect(mutations.update).toHaveBeenLastCalledWith(
      'chat-a',
      'document-a',
      { expectedVersion: 3, expectedContentHash: 'c'.repeat(64) },
      expect.objectContaining({ markdown: '# My second draft' }),
    )
  })

  it('guards close while a document draft is unsaved', async () => {
    const close = vi.fn()
    const confirm = vi.mocked(globalThis.confirm)
    confirm.mockReturnValue(false)
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a', close } })
    await settle()
    target.querySelector<HTMLButtonElement>('[aria-label="Open Old Tavern"]')?.click()
    await settle()
    const title = target.querySelector<HTMLInputElement>('input[required]')!
    title.value = 'Changed title'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()

    target.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()

    expect(confirm).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
  })

  it('creates, renames, and deletes through explicit document actions', async () => {
    vi.mocked(globalThis.confirm).mockReturnValue(true)
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const newDocument = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('New document'),
    )
    newDocument?.click()
    await settle()
    const required = target.querySelectorAll<HTMLInputElement>('input[required]')
    required[0]!.value = 'Arrival'
    required[0]!.dispatchEvent(new Event('input', { bubbles: true }))
    required[1]!.value = 'Events/Arrival'
    required[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    const markdown = target.querySelector<HTMLTextAreaElement>('textarea')!
    markdown.value = '# Arrival'
    markdown.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await settle()

    expect(mutations.create).toHaveBeenCalledWith(
      'chat-a',
      expect.objectContaining({ title: 'Arrival', logicalPath: 'Events/Arrival', markdown: '# Arrival' }),
    )

    const title = target.querySelector<HTMLInputElement>('input[required]')!
    title.value = 'Renamed Tavern'
    title.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await settle()
    expect(mutations.update).toHaveBeenCalledWith(
      'chat-a',
      'document-a',
      expect.any(Object),
      expect.objectContaining({ title: 'Renamed Tavern' }),
    )

    const remove = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Remove',
    )
    remove?.click()
    await settle()
    expect(mutations.remove).toHaveBeenCalledWith('chat-a', 'document-a', expect.any(Object))
  })

  it('keeps a durable queued edit visibly pending until settlement', async () => {
    const settlement = deferred<{ status: 'accepted' }>()
    const close = vi.fn()
    vi.mocked(globalThis.confirm).mockReturnValue(false)
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a', close } })
    await settle()
    target.querySelector<HTMLButtonElement>('[aria-label="Open Old Tavern"]')?.click()
    await settle()
    const markdown = target.querySelector<HTMLTextAreaElement>('textarea')!
    markdown.value = '# Queued draft'
    markdown.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    mutations.update.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'mutation-a',
      settlement: settlement.promise,
    })
    target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click()
    await settle()

    expect(target.textContent).toContain('queued for retry')
    expect(target.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    target.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click()
    expect(close).not.toHaveBeenCalled()

    settlement.resolve({ status: 'accepted' })
    await settle()
    expect(target.textContent).toContain('Saved on the server')
  })

  it('persists explicit per-chat policy and budget overrides', async () => {
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()
    const selects = target.querySelectorAll<HTMLSelectElement>('details select')
    selects[0]!.value = 'disabled'
    selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    selects[1]!.value = 'hybrid'
    selects[1]!.dispatchEvent(new Event('change', { bubbles: true }))
    selects[2]!.value = 'automatic'
    selects[2]!.dispatchEvent(new Event('change', { bubbles: true }))
    selects[3]!.value = 'enabled'
    selects[3]!.dispatchEvent(new Event('change', { bubbles: true }))
    const budget = target.querySelector<HTMLInputElement>('details input[type="number"]')!
    budget.value = '4096'
    budget.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    const save = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Save chat overrides'),
    )
    save?.click()
    await settle()

    expect(mutations.settings).toHaveBeenCalledWith('chat-a', {
      enabledOverride: false,
      memoryModeOverride: 'hybrid',
      confirmationPolicyOverride: 'automatic',
      canonicalUpdatesOverride: true,
      totalTokenBudgetOverride: 4096,
    })
    expect(target.textContent).toContain(language.bardWiki.automaticConfirmation)
    expect(target.textContent).toContain(language.bardWiki.canonicalUpdates)
  })

  it('shows refreshed effective inherited values without materializing them in an unrelated override', async () => {
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const enabled = target.querySelector<HTMLSelectElement>('[data-risu-bardwiki-override="enabled"] select')!
    const memory = target.querySelector<HTMLSelectElement>('[data-risu-bardwiki-override="memory-mode"] select')!
    const confirmation = target.querySelector<HTMLSelectElement>('[data-risu-bardwiki-override="confirmation"] select')!
    const canonical = target.querySelector<HTMLSelectElement>(
      '[data-risu-bardwiki-override="canonical-updates"] select',
    )!
    const budget = target.querySelector<HTMLInputElement>('[data-risu-bardwiki-override="total-token-budget"] input')!
    expect(enabled.options[0]?.textContent).toContain(language.bardWiki.enabled)
    expect(memory.options[0]?.textContent).toContain(language.bardWiki.modeHypa)
    expect(confirmation.options[0]?.textContent).toContain(language.bardWiki.confirmationManual)
    expect(canonical.options[0]?.textContent).toContain(language.bardWiki.disabled)
    expect(budget.placeholder).toContain('2,048')

    enabled.value = 'disabled'
    enabled.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    applyBardWikiChatResource({
      ...chatResource,
      revision: chatResource.revision + 1,
      effectiveSettings: {
        ...chatResource.effectiveSettings,
        memoryMode: 'hybrid',
        confirmationPolicy: 'automatic',
        canonicalUpdates: true,
        totalTokenBudget: 4096,
      },
    })
    await settle()

    expect(enabled.value).toBe('disabled')
    expect(memory.value).toBe('inherit')
    expect(memory.options[0]?.textContent).toContain(language.bardWiki.modeHybrid)
    expect(confirmation.options[0]?.textContent).toContain(language.bardWiki.confirmationAutomatic)
    expect(canonical.options[0]?.textContent).toContain(language.bardWiki.enabled)
    expect(budget.value).toBe('')
    expect(budget.placeholder).toContain('4,096')

    const save = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes(language.bardWiki.saveOverrides),
    )
    save?.click()
    await settle()
    expect(mutations.settings).toHaveBeenCalledWith('chat-a', {
      enabledOverride: false,
      memoryModeOverride: null,
      confirmationPolicyOverride: null,
      canonicalUpdatesOverride: null,
      totalTokenBudgetOverride: null,
    })
  })

  it('marks documents that require review in the chat index', async () => {
    reads.chat.mockResolvedValueOnce({
      ...chatResource,
      documents: [{ ...index, reviewState: 'needs_review' as const }],
    })
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    expect(target.querySelector('[aria-label="Open Old Tavern"]')?.textContent).toContain(
      language.bardWiki.reviewStates.needs_review,
    )
  })

  it('shows receipt and failed-job errors and retries against the authoritative chat resource', async () => {
    const failedJob = {
      id: 'job-a',
      instanceId: 'instance-a',
      chatId: 'chat-a',
      receiptId: 'receipt-a',
      kind: 'apply_turn' as const,
      status: 'failed' as const,
      errorCode: 'provider_error',
      errorSummary: 'The analysis provider failed',
      attemptCount: 3,
      maxAttempts: 3,
      nextRunAt: '2026-08-29T00:00:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
    }
    const receipt = {
      id: 'receipt-a',
      chatId: 'chat-a',
      userMessageId: 'user-a',
      userContentHash: 'a'.repeat(64),
      assistantMessageId: 'assistant-a',
      assistantContentHash: 'b'.repeat(64),
      confirmationMode: 'explicit' as const,
      state: 'failed' as const,
      eventDocumentId: null,
      jobId: 'job-a',
      errorCode: 'provider_error',
      errorSummary: 'Receipt failed too',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
      appliedAt: null,
    }
    const failedResource = { ...chatResource, receipts: [receipt], jobs: [failedJob] }
    const pendingJob = {
      ...failedJob,
      instanceId: 'instance-b',
      status: 'pending' as const,
      errorCode: null,
      errorSummary: null,
      attemptCount: 0,
    }
    const pendingResource = {
      ...chatResource,
      revision: 5,
      receipts: [{ ...receipt, state: 'queued' as const }],
      jobs: [pendingJob],
    }
    reads.chat.mockResolvedValueOnce(failedResource).mockResolvedValue(pendingResource)
    jobActions.retry.mockResolvedValue({ status: 'ok', job: pendingJob })

    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    expect(target.querySelector('[data-testid="bardwiki-activity"]')?.hasAttribute('open')).toBe(true)
    expect(target.textContent).toContain('The analysis provider failed')
    expect(target.textContent).toContain('Receipt failed too')
    const retry = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry job',
    )
    retry?.click()
    await settle()

    expect(jobActions.retry).toHaveBeenCalledWith('job-a')
    expect(reads.chat).toHaveBeenCalledTimes(2)
    expect(target.textContent).toContain('Pending')
  })

  it('cancels active jobs and reports operational API failures without hiding status', async () => {
    const pendingJob = {
      id: 'job-a',
      instanceId: 'instance-a',
      chatId: 'chat-a',
      receiptId: null,
      kind: 'rebuild_chat' as const,
      status: 'running' as const,
      errorCode: null,
      errorSummary: null,
      attemptCount: 1,
      maxAttempts: 3,
      progressCurrent: 2,
      progressTotal: 5,
      nextRunAt: '2026-08-29T00:00:00.000Z',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:01:00.000Z',
    }
    reads.chat.mockResolvedValue({ ...chatResource, jobs: [pendingJob] })
    jobActions.cancel.mockResolvedValue({ status: 'error', error: 'bardwiki_job_not_cancellable' })
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const cancel = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Cancel job',
    )
    cancel?.click()
    await settle()

    expect(jobActions.cancel).toHaveBeenCalledWith('job-a')
    expect(target.textContent).toContain('bardwiki_job_not_cancellable')
    expect(target.textContent).toContain('Running')
    expect(target.querySelector('progress')?.value).toBe(2)
    expect(target.textContent).toContain('2/5 turns')
  })

  it('previews and explicitly queues a historical rebuild from lifecycle tools', async () => {
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const preview = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Preview rebuild',
    )
    preview?.click()
    await settle()

    expect(mutations.rebuildPreview).toHaveBeenCalledWith('chat-a', 'full')
    expect(target.querySelector('[data-testid="bardwiki-rebuild-preview"]')?.textContent).toContain(
      '3 eligible transcript turns',
    )
    const start = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Start rebuild',
    )
    start?.click()
    await settle()

    expect(globalThis.confirm).toHaveBeenCalledWith('Rebuild BardWiki from 3 transcript turns?')
    expect(mutations.rebuildQueue).toHaveBeenCalledWith('chat-a', 'full', 3)
    expect(target.textContent).toContain('The rebuild was queued')
  })

  it('retains the preview and allows retry after a rebuild staging failure', async () => {
    mutations.rebuildQueue.mockResolvedValueOnce({
      status: 'failed',
      result: { status: 'error', error: 'Pending mutation command path is not allowlisted' },
    })
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const preview = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Preview rebuild',
    )!
    preview.click()
    await settle()
    const start = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Start rebuild',
    )!
    start.click()
    await settle()

    expect(target.textContent).toContain('Pending mutation command path is not allowlisted')
    expect(target.querySelector('[data-testid="bardwiki-rebuild-preview"]')).not.toBeNull()
    expect(start.disabled).toBe(false)
    start.click()
    await settle()

    expect(mutations.rebuildQueue).toHaveBeenCalledTimes(2)
    expect(target.textContent).toContain('The rebuild was queued')
    expect(target.textContent).not.toContain('Pending mutation command path is not allowlisted')
  })

  it('dry-runs a selected vault before enabling one revisioned import', async () => {
    const plan = {
      format: 'risu-bardwiki-vault' as const,
      version: 1 as const,
      strategy: 'skip' as const,
      creates: 2,
      replacements: 0,
      noops: 1,
      skips: 1,
      renames: 0,
      applicable: true,
      actions: [],
    }
    mutations.vaultPreview.mockResolvedValue({ status: 'ok', revision: 4, dryRun: true, plan })
    mutations.vaultImport.mockResolvedValue({ status: 'ok', revision: 5, dryRun: false, plan })
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()

    const input = target.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = {
      name: 'vault.zip',
      size: 4,
      arrayBuffer: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
    } as File
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    expect(mutations.vaultPreview).toHaveBeenCalledWith('chat-a', 'UEsDBA==', 'skip')
    expect(target.querySelector('[data-testid="bardwiki-import-preview"]')?.textContent).toContain('2 create')
    const apply = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Apply import',
    )
    apply?.click()
    await settle()

    expect(globalThis.confirm).toHaveBeenCalledWith('Apply this validated BardWiki vault as one revision?')
    expect(mutations.vaultImport).toHaveBeenCalledWith('chat-a', 'UEsDBA==', 'skip', [])
    expect(target.textContent).toContain('The BardWiki vault was imported')
  })
})

it('retains newer document typing while an older Save is pending', async () => {
  await beginWriterDraftCaptureTest()
  try {
    const saving = deferred<any>()
    mutations.update.mockReturnValueOnce(saving.promise)
    component = mount(BardWikiWorkspace, { target, props: { chatId: 'chat-a' } })
    await settle()
    target.querySelector<HTMLButtonElement>('[aria-label="Open Old Tavern"]')!.click()
    await settle()
    const input = target.querySelector<HTMLTextAreaElement>('textarea')!
    input.value = '# Submitted version'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    target
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await tick()
    input.value = '# Newer unsaved version'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts()).toMatchObject([
      { key: 'bardwiki:chat-a:document-a', data: { document: { markdown: '# Newer unsaved version' } } },
    ])
    saving.resolve({ status: 'failed', result: { status: 'unavailable' } })
    await settle()
    expect(capturedWriterDrafts().find((draft) => draft.key === 'bardwiki:chat-a:document-a')?.data).toMatchObject({
      document: { markdown: '# Newer unsaved version' },
    })
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
