import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inlayMocks = vi.hoisted(() => ({
  getInlayAssetBlob: vi.fn(),
  listInlayAssets: vi.fn(),
  removeInlayAsset: vi.fn(),
}))

const alertMocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
}))

const catalogMocks = vi.hoisted(() => ({
  listener: null as (() => void) | null,
  unsubscribe: vi.fn(),
}))

vi.mock('src/ts/process/files/inlays', () => ({
  getInlayAssetBlob: inlayMocks.getInlayAssetBlob,
  listInlayAssets: inlayMocks.listInlayAssets,
  removeInlayAsset: inlayMocks.removeInlayAsset,
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: alertMocks.alertConfirm,
  alertError: alertMocks.alertError,
}))

vi.mock('src/ts/server/inlayCatalog', () => ({
  subscribeServerInlayCatalog: vi.fn((listener: () => void) => {
    catalogMocks.listener = listener
    return catalogMocks.unsubscribe
  }),
}))

import PlaygroundInlayExplorer from './PlaygroundInlayExplorer.svelte'
import { language } from 'src/lang'

type MountedComponent = Parameters<typeof unmount>[0]

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

let component: MountedComponent | undefined
let target: HTMLElement

beforeEach(() => {
  target = document.createElement('div')
  document.body.append(target)
  inlayMocks.getInlayAssetBlob.mockReset()
  inlayMocks.listInlayAssets.mockReset()
  inlayMocks.removeInlayAsset.mockReset()
  alertMocks.alertConfirm.mockReset()
  alertMocks.alertConfirm.mockResolvedValue(true)
  alertMocks.alertError.mockReset()
  catalogMocks.listener = null
  catalogMocks.unsubscribe.mockReset()
  inlayMocks.listInlayAssets.mockResolvedValue(
    Array.from({ length: 40 }, (_, index) => [
      `asset-${index}`,
      { data: '', ext: 'json', name: `Asset ${index}`, type: 'signature' },
    ]),
  )

  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect() {}
      observe() {}
    },
  )
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('PlaygroundInlayExplorer', () => {
  it('reloads a mounted explorer when another client changes the server catalog', async () => {
    inlayMocks.listInlayAssets
      .mockResolvedValueOnce([['asset-a', { ext: 'png', name: 'Asset A', size: 10, type: 'image' }]])
      .mockResolvedValueOnce([['asset-b', { ext: 'png', name: 'Asset B', size: 20, type: 'image' }]])
    inlayMocks.getInlayAssetBlob.mockResolvedValue(null)

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Asset A'))
    catalogMocks.listener?.()
    await vi.waitFor(() => expect(target.textContent).toContain('Asset B'))

    expect(target.textContent).not.toContain('Asset A')
    expect(inlayMocks.listInlayAssets).toHaveBeenCalledTimes(2)
  })

  it('stays subscribed while a paginated catalog is mounted', async () => {
    const initialAssets = Array.from({ length: 40 }, (_, index) => [
      `asset-${index}`,
      { data: '', ext: 'json', name: `Asset ${index}`, type: 'signature' },
    ])
    const refreshedAssets = [
      ...initialAssets,
      ['asset-40', { data: '', ext: 'json', name: 'Authoritative Asset', type: 'signature' }],
    ]
    inlayMocks.listInlayAssets.mockResolvedValueOnce(initialAssets).mockResolvedValueOnce(refreshedAssets)

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Total 40 assets'))

    expect(catalogMocks.unsubscribe).not.toHaveBeenCalled()
    catalogMocks.listener?.()
    await vi.waitFor(() => expect(target.textContent).toContain('Total 41 assets'))
    expect(inlayMocks.listInlayAssets).toHaveBeenCalledTimes(2)

    await unmount(component)
    component = undefined
    expect(catalogMocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('shows a recoverable error when the initial asset list fails', async () => {
    inlayMocks.listInlayAssets.mockRejectedValueOnce(new Error('IndexedDB unavailable')).mockResolvedValueOnce([])

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Could not load inlay assets'))

    expect(target.textContent).toContain('IndexedDB unavailable')
    const retry = Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.includes('Retry'))
    expect(retry).toBeTruthy()
    retry!.click()

    await vi.waitFor(() => expect(inlayMocks.listInlayAssets).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(target.textContent).toContain('No saved inlay assets'))
    expect(target.textContent).not.toContain('Could not load inlay assets')
  })

  it('keeps the explorer usable when an individual preview fails', async () => {
    inlayMocks.listInlayAssets.mockResolvedValue([
      ['asset-1', { data: '', ext: 'png', name: 'Asset 1', type: 'image' }],
    ])
    inlayMocks.getInlayAssetBlob.mockRejectedValue(new Error('asset bytes missing'))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    component = mount(PlaygroundInlayExplorer, { target })

    await vi.waitFor(() => expect(target.textContent).toContain('Preview unavailable'))
    expect(target.textContent).toContain('Asset 1')
    expect(consoleWarn).toHaveBeenCalledWith('Failed to load inlay preview asset-1:', expect.any(Error))
  })

  it('selects assets beyond the currently rendered page', async () => {
    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Total 40 assets'))

    const selectAll = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Select All'),
    )
    expect(selectAll).toBeTruthy()
    expect(selectAll?.parentElement?.classList.contains('flex-wrap')).toBe(true)
    selectAll!.click()
    await tick()

    expect(target.textContent).toContain('Deselect All (40)')
  })

  it('does not leak preview URLs resolved after unmount', async () => {
    const preview = deferred<{ data: Blob }>()
    inlayMocks.listInlayAssets.mockResolvedValue([
      ['asset-1', { data: '', ext: 'png', name: 'Asset 1', type: 'image' }],
    ])
    inlayMocks.getInlayAssetBlob.mockReturnValue(preview.promise)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late-preview')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(inlayMocks.getInlayAssetBlob).toHaveBeenCalledWith('asset-1'))

    await unmount(component)
    component = undefined
    preview.resolve({ data: new Blob(['preview'], { type: 'image/png' }) })
    await preview.promise
    await tick()

    expect(createObjectURL.mock.calls.length).toBe(revokeObjectURL.mock.calls.length)
  })

  it('keeps ownership of the newest preview when selection remounts an asset', async () => {
    const olderPreview = deferred<{ data: Blob }>()
    const newerPreview = deferred<{ data: Blob }>()
    inlayMocks.listInlayAssets.mockResolvedValue([
      ['asset-1', { data: '', ext: 'png', name: 'Asset 1', type: 'image' }],
    ])
    inlayMocks.getInlayAssetBlob.mockReturnValueOnce(olderPreview.promise).mockReturnValueOnce(newerPreview.promise)
    const createObjectURL = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValueOnce('blob:newer-preview')
      .mockReturnValueOnce('blob:older-preview')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(inlayMocks.getInlayAssetBlob).toHaveBeenCalledTimes(1))

    const checkbox = target.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(checkbox).toBeTruthy()
    expect(checkbox?.getAttribute('aria-label')).toBe(language.playground.inlaySelectAsset('Asset 1'))
    expect(checkbox?.checked).toBe(false)
    checkbox!.click()
    await vi.waitFor(() => expect(inlayMocks.getInlayAssetBlob).toHaveBeenCalledTimes(2))
    const selectedCheckbox = target.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(selectedCheckbox?.getAttribute('aria-label')).toBe(language.playground.inlaySelectAsset('Asset 1'))
    expect(selectedCheckbox?.checked).toBe(true)

    newerPreview.resolve({ data: new Blob(['newer'], { type: 'image/png' }) })
    await newerPreview.promise
    await vi.waitFor(() => expect(target.querySelector('img')?.src).toBe('blob:newer-preview'))

    olderPreview.resolve({ data: new Blob(['older'], { type: 'image/png' }) })
    await olderPreview.promise
    await tick()
    await unmount(component)
    component = undefined

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:newer-preview')
  })

  it('does not retain a preview that finishes after its asset is deleted', async () => {
    const preview = deferred<{ data: Blob }>()
    inlayMocks.listInlayAssets.mockResolvedValue([
      ['asset-1', { data: '', ext: 'png', name: 'Asset 1', type: 'image' }],
    ])
    inlayMocks.getInlayAssetBlob.mockReturnValue(preview.promise)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:deleted-preview')

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(inlayMocks.getInlayAssetBlob).toHaveBeenCalledWith('asset-1'))

    const deleteButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent === language.playground.inlayDelete,
    )
    deleteButton!.click()
    await vi.waitFor(() => expect(inlayMocks.removeInlayAsset).toHaveBeenCalledWith('asset-1'))
    await vi.waitFor(() => expect(target.textContent).not.toContain('Asset 1'))

    preview.resolve({ data: new Blob(['preview'], { type: 'image/png' }) })
    await preview.promise
    await tick()

    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('keeps successful bulk deletions when one selected asset fails', async () => {
    inlayMocks.listInlayAssets.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => [
        `asset-${index}`,
        { data: '', ext: 'json', name: `Asset ${index}`, type: 'signature' },
      ]),
    )
    const deleteError = new Error('asset-1 failed')
    inlayMocks.removeInlayAsset.mockImplementation(async (id: string) => {
      if (id === 'asset-1') throw deleteError
    })

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Total 3 assets'))

    const selectAll = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Select All'),
    )
    selectAll!.click()
    await tick()
    const deleteSelected = Array.from(target.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Delete Selected'),
    )
    deleteSelected!.click()

    await vi.waitFor(() => expect(inlayMocks.removeInlayAsset).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(target.textContent).toContain('Total 1 assets'))

    expect(target.textContent).toContain('Asset 1')
    expect(target.textContent).not.toContain('Asset 0')
    expect(target.textContent).not.toContain('Asset 2')
    expect(target.textContent).toContain('Deselect All (1)')
    expect(alertMocks.alertError).toHaveBeenCalledWith(deleteError)
  })

  it('keeps a single asset visible and reports the error when deletion fails', async () => {
    inlayMocks.listInlayAssets.mockResolvedValue([
      ['asset-1', { data: '', ext: 'json', name: 'Asset 1', type: 'signature' }],
    ])
    const deleteError = new Error('delete failed')
    inlayMocks.removeInlayAsset.mockRejectedValue(deleteError)

    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Asset 1'))

    const deleteButton = Array.from(target.querySelectorAll('button')).find((button) => button.textContent === 'Delete')
    expect(deleteButton).toBeTruthy()
    deleteButton!.click()

    await vi.waitFor(() => expect(inlayMocks.removeInlayAsset).toHaveBeenCalledWith('asset-1'))
    await vi.waitFor(() => expect(alertMocks.alertError).toHaveBeenCalledWith(deleteError))
    expect(target.textContent).toContain('Asset 1')
  })

  it('prevents repeated deletion while the confirmation or request is pending', async () => {
    inlayMocks.listInlayAssets.mockResolvedValue([
      ['asset-1', { data: '', ext: 'json', name: 'Asset 1', type: 'signature' }],
    ])
    const confirmation = deferred<boolean>()
    const removal = deferred<void>()
    alertMocks.alertConfirm.mockReturnValue(confirmation.promise)
    inlayMocks.removeInlayAsset.mockReturnValue(removal.promise)
    component = mount(PlaygroundInlayExplorer, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Asset 1'))
    const deleteButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent === language.playground.inlayDelete,
    )
    if (!deleteButton) throw new Error('Inlay delete control not found')

    deleteButton.click()
    await vi.waitFor(() => expect(alertMocks.alertConfirm).toHaveBeenCalledOnce())
    expect(deleteButton.disabled).toBe(true)
    deleteButton.click()
    expect(alertMocks.alertConfirm).toHaveBeenCalledOnce()

    confirmation.resolve(true)
    await vi.waitFor(() => expect(inlayMocks.removeInlayAsset).toHaveBeenCalledOnce())
    deleteButton.click()
    expect(inlayMocks.removeInlayAsset).toHaveBeenCalledOnce()
    removal.resolve()
    await vi.waitFor(() => expect(target.textContent).not.toContain('Asset 1'))
  })
})
