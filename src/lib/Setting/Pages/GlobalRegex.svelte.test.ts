import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const regexMocks = vi.hoisted(() => ({
  exportRegex: vi.fn(),
  importRegexRows: vi.fn(),
}))

vi.mock('src/lib/Others/Help.svelte', async () => ({
  default: (await import('./GlobalRegex.testStub.svelte')).default,
}))
vi.mock('src/lib/SideBars/Scripts/RegexList.svelte', async () => ({
  default: (await import('./GlobalRegex.testStub.svelte')).default,
}))
vi.mock('src/ts/process/scripts', () => ({
  exportRegex: regexMocks.exportRegex,
  importRegexRows: regexMocks.importRegexRows,
}))
vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  createServerBackedSettingDraft: (_key: string, fallback: unknown) => {
    const draft = {
      value: fallback,
      captureRecoveryDraft: () =>
        JSON.stringify(draft.value) === JSON.stringify(fallback)
          ? null
          : { value: JSON.parse(JSON.stringify(draft.value)), baseline: JSON.parse(JSON.stringify(fallback)) },
    }
    return draft
  },
}))
vi.mock('src/ts/server/scriptDefinitionOwner.svelte', () => ({
  ensureClientScriptDefinitionIds: (scripts: unknown) => scripts,
  watchGlobalScriptOwnerDraft: () => vi.fn(),
}))

import GlobalRegex from './GlobalRegex.svelte'
import { language } from 'src/lang'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

beforeEach(() => {
  replaceResourceDatabase({ globalscript: [] } as any)
  target = document.createElement('div')
  document.body.appendChild(target)
  regexMocks.exportRegex.mockReset()
  regexMocks.importRegexRows.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('GlobalRegex toolbar', () => {
  it('names each icon action for the global regex collection', () => {
    component = mount(GlobalRegex, { target })

    const labels = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).map((button) =>
      button.getAttribute('aria-label'),
    )
    expect(labels).toEqual([
      `${language.add}: ${language.globalRegexScript}`,
      `${language.export}: ${language.globalRegexScript}`,
      `${language.import}: ${language.globalRegexScript}`,
    ])
    expect(
      Array.from(target.querySelectorAll<HTMLButtonElement>('button')).every((button) => button.type === 'button'),
    ).toBe(true)
  })

  it('merges imported rows into edits made while the picker is open', async () => {
    let resolveImport!: (rows: unknown[]) => void
    regexMocks.importRegexRows.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )
    component = mount(GlobalRegex, { target })
    const importButton = target.querySelector<HTMLButtonElement>(
      `button[aria-label="${language.import}: ${language.globalRegexScript}"]`,
    )
    const addButton = target.querySelector<HTMLButtonElement>(
      `button[aria-label="${language.add}: ${language.globalRegexScript}"]`,
    )

    importButton?.click()
    await vi.waitFor(() => expect(regexMocks.importRegexRows).toHaveBeenCalledOnce())
    addButton?.click()
    await tick()
    expect(target.querySelector('[data-testid="global-regex-count"]')?.textContent).toBe('1')

    resolveImport([{ id: 'imported', comment: 'Imported', in: 'a', out: 'b', type: 'editinput' }])
    await vi.waitFor(() => expect(target.querySelector('[data-testid="global-regex-count"]')?.textContent).toBe('2'))

    target
      .querySelector<HTMLButtonElement>(`button[aria-label="${language.export}: ${language.globalRegexScript}"]`)
      ?.click()
    expect(regexMocks.exportRegex).toHaveBeenCalledWith([
      expect.objectContaining({ comment: '', type: 'editinput' }),
      expect.objectContaining({ id: 'imported', comment: 'Imported' }),
    ])
  })
})

it('captures a dirty global script collection before its settings owner unmounts', async () => {
  await beginWriterDraftCaptureTest()
  try {
    component = mount(GlobalRegex, { target })
    await tick()
    target
      .querySelector<HTMLButtonElement>(`button[aria-label="${language.add}: ${language.globalRegexScript}"]`)!
      .click()
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([
      expect.objectContaining({
        key: 'global-regex',
        data: { scripts: [expect.objectContaining({ type: 'editinput', out: '' })] },
        baseline: { scripts: [] },
      }),
    ])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
