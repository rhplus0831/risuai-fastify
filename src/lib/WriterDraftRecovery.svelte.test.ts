import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../lang'
import {
  authorizeClientWriterRecovery,
  beginClientSession,
  canUseClientWriteAccess,
  completeClientWriterRecovery,
  demoteClientSession,
  requireClientAuthentication,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from '../ts/clientSession'
import { initializeDraftRecoveryScope } from '../ts/server/draftRecoveryScope'
import { repromoteClientWriter } from '../ts/__tests__/clientSession'
import { beginWriterDraftCaptureTest, endWriterDraftCaptureTest } from '../ts/__tests__/writerDraftCapture'

const panelMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  nextLoad: null as Promise<void> | null,
}))

vi.mock('../ts/router', () => ({ navigate: panelMocks.navigate }))
vi.mock('../ts/server/writerDraftRecovery', async (importActual) => {
  const actual = await importActual<typeof import('../ts/server/writerDraftRecovery')>()
  return {
    ...actual,
    loadWriterDrafts: async () => {
      const pending = panelMocks.nextLoad
      panelMocks.nextLoad = null
      if (pending) await pending
      await actual.loadWriterDrafts()
    },
  }
})

import WriterDraftRecovery from './WriterDraftRecovery.svelte'
import {
  flushWriterDraftRecoveryForTests,
  readWriterDraft,
  registerWriterDraftCapture,
  writerDraftRecoveryStore,
  type WriterDraftCapture,
} from '../ts/server/writerDraftRecovery'

type MountedComponent = Parameters<typeof unmount>[0]
let component: MountedComponent | undefined
let target: HTMLElement
let capture: WriterDraftCapture
let clipboard: ReturnType<typeof vi.fn>
let exported: Blob[]
let downloads: Array<{ href: string; name: string }>
let revoke: (url: string) => void

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await tick()
  await flushWriterDraftRecoveryForTests()
  await tick()
}

function button(text: string, index = 0): HTMLButtonElement {
  const matches = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).filter(
    (candidate) => candidate.textContent?.trim() === text,
  )
  if (!matches[index]) throw new Error(`Missing recovery action: ${text}`)
  return matches[index]
}

function trigger(): HTMLButtonElement {
  const result = target.querySelector<HTMLButtonElement>('button[aria-expanded]')
  if (!result) throw new Error('Missing recovery trigger')
  return result
}

async function captureAndMount(): Promise<void> {
  registerWriterDraftCapture(() => capture)
  demoteClientSession()
  await flushWriterDraftRecoveryForTests()
  component = mount(WriterDraftRecovery, { target })
  await settle()
}

async function openPanel(): Promise<void> {
  trigger().click()
  await settle()
  const summary = target.querySelector<HTMLElement>('details summary')
  summary?.click()
  await tick()
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  await beginWriterDraftCaptureTest()
  panelMocks.navigate.mockReset()
  panelMocks.nextLoad = null
  clipboard = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Recovery UI must not call a server')
    }),
  )
  exported = []
  downloads = []
  revoke = vi.fn<(url: string) => void>()
  const OriginalURL = URL
  vi.stubGlobal(
    'URL',
    class extends OriginalURL {
      static createObjectURL(blob: Blob): string {
        exported.push(blob)
        return `blob:recovery-${exported.length}`
      }
      static revokeObjectURL(url: string): void {
        revoke(url)
      }
    },
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    downloads.push({ href: this.href, name: this.download })
  })
  capture = {
    key: 'editor:one',
    label: 'Unsubmitted editor',
    route: '/character/char-a?chat=chat-a',
    fields: [
      { label: 'Prompt', value: 'Local prompt' },
      { label: 'API key', value: 'secret-local-key', secret: true },
    ],
    data: { prompt: 'Local prompt', apiKey: 'secret-local-key' },
    baseline: { prompt: 'Original prompt' },
  }
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(async () => {
  if (component) await unmount(component)
  component = undefined
  target.remove()
  await endWriterDraftCaptureTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saved local edits panel', () => {
  it('copies, reveals, exports and opens a local page from an actual reader capture without server writes', async () => {
    await captureAndMount()
    expect(canUseClientWriteAccess()).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await openPanel()
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.tagName).toBe('DIV')
    expect(dialog.tabIndex).toBe(-1)
    const secret = dialog.querySelector<HTMLInputElement>('input')!
    expect(secret.type).toBe('password')
    expect(secret.value).toBe('secret-local-key')
    expect(dialog.querySelector<HTMLTextAreaElement>('textarea')?.readOnly).toBe(true)

    button(language.copy).click()
    await tick()
    expect(clipboard).toHaveBeenCalledWith('Local prompt')
    expect(dialog.querySelector('[role="status"]')?.textContent).toBe(language.connectedReaders.localCopyCopied)
    button(language.connectedReaders.showSecret).click()
    await tick()
    expect(secret.type).toBe('text')
    button(language.connectedReaders.hideSecret).click()
    await tick()
    expect(secret.type).toBe('password')

    button(language.connectedReaders.exportLocalDraft).click()
    expect(downloads).toEqual([{ href: 'blob:recovery-1', name: 'local-edits.json' }])
    expect(JSON.parse(await blobText(exported[0]))).toEqual({
      fields: capture.fields,
      data: capture.data,
      baseline: capture.baseline,
    })
    button(language.connectedReaders.openDraftLocation).click()
    await tick()
    expect(panelMocks.navigate).toHaveBeenCalledWith('/character/char-a?chat=chat-a')
    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(readWriterDraft('editor:one')?.fields).toEqual(capture.fields)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('closes with Escape and resets revealed fields before reopening', async () => {
    await captureAndMount()
    trigger().click()
    await settle()
    expect(document.activeElement).toBe(button(language.close))
    target.querySelector<HTMLElement>('details summary')!.click()
    button(language.connectedReaders.showSecret).click()
    await tick()
    target
      .querySelector<HTMLElement>('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
    expect(document.activeElement).toBe(trigger())
    await openPanel()
    expect(target.querySelector<HTMLInputElement>('input')!.type).toBe('password')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not let a retained old discard button remove a newer capture for the same owner', async () => {
    await captureAndMount()
    await openPanel()
    const oldDiscard = button(language.connectedReaders.discardLocalDraft)
    const originalGeneration = readWriterDraft('editor:one')!.generation
    repromoteClientWriter()
    capture = {
      ...capture,
      fields: [{ label: 'Prompt', value: 'Newer local prompt' }],
      data: { prompt: 'Newer local prompt' },
    }
    demoteClientSession()
    const newerGeneration = readWriterDraft('editor:one')!.generation
    expect(newerGeneration).not.toBe(originalGeneration)
    oldDiscard.click()
    await settle()
    expect(readWriterDraft('editor:one')?.generation).toBe(newerGeneration)
    await openPanel()
    button(language.connectedReaders.discardLocalDraft).click()
    await settle()
    expect(readWriterDraft('editor:one')).toBeNull()
    expect(target.querySelector('[data-writer-draft-recovery]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides on auth loss and rejects retained copy, export and navigation handlers before DOM teardown', async () => {
    await captureAndMount()
    await openPanel()
    button(language.connectedReaders.showSecret).click()
    await tick()
    const staleCopy = button(language.copy, 1)
    const staleExport = button(language.connectedReaders.exportLocalDraft)
    const staleNavigation = button(language.connectedReaders.openDraftLocation)
    requireClientAuthentication()
    staleCopy.click()
    staleExport.click()
    staleNavigation.click()
    await tick()
    expect(target.querySelector('[data-writer-draft-recovery]')).toBeNull()
    expect(target.textContent).not.toContain('secret-local-key')
    expect(clipboard).not.toHaveBeenCalled()
    expect(exported).toEqual([])
    expect(panelMocks.navigate).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not reopen or focus from a show request that crosses authentication loss and a new generation', async () => {
    await captureAndMount()
    const delayed = deferred()
    panelMocks.nextLoad = delayed.promise
    trigger().click()
    requireClientAuthentication()
    await tick()
    expect(target.querySelector('[data-writer-draft-recovery]')).toBeNull()
    const operation = beginClientSession('draft-test-session')
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'draft-test-lineage',
      writer: { sessionId: 'draft-test-session', epoch: 1 },
    })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    expect(completeClientWriterRecovery(operation)).toBe(true)
    await settle()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    delayed.resolve()
    await settle()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides a previous lineage when a managed session transition installs a different scope', async () => {
    await captureAndMount()
    await openPanel()
    initializeDraftRecoveryScope({ databaseLineage: 'other-lineage', writerSessionId: 'other-session' })
    const operation = beginClientSession('other-session')
    settleClientReader(operation, {
      databaseLineage: 'other-lineage',
      writer: { sessionId: 'foreign-writer', epoch: 1 },
    })
    setClientConnectionState('live')
    setClientProjectionReady(true)
    await settle()
    expect(target.querySelector('[data-writer-draft-recovery]')).toBeNull()
    expect(readWriterDraft('editor:one')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a failed-persistence capture readable with an accessible explanation', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await captureAndMount()
    expect(get(writerDraftRecoveryStore).storageFailed).toBe(true)
    await openPanel()
    expect(target.querySelector('[role="alert"]')?.textContent).toBe(language.connectedReaders.localCopyStorageFailed)
    expect(target.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Local prompt')
    button(language.copy).click()
    await tick()
    expect(clipboard).toHaveBeenCalledWith('Local prompt')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('offers manual copying when the clipboard call fails', async () => {
    clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    await captureAndMount()
    await openPanel()
    button(language.copy).click()
    await tick()
    expect(target.querySelector('[role="status"]')?.textContent).toBe(language.connectedReaders.localCopyCopyFailed)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://example.com', '//example.com', '/\\example.com', '/\n/example.com'])(
    'does not offer external navigation for %j',
    async (route) => {
      capture = { ...capture, route }
      await captureAndMount()
      await openPanel()
      expect(target.textContent).not.toContain(language.connectedReaders.openDraftLocation)
      expect(panelMocks.navigate).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
