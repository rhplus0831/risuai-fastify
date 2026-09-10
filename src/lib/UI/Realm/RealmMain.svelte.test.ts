import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const realmMocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  authenticatedHubFetch: vi.fn(),
  cancelPendingRealmInfoRequest: vi.fn(),
  downloadRisuHub: vi.fn(),
  getRisuHub: vi.fn(),
}))

vi.mock('src/ts/characterCards', () => ({
  authenticatedHubFetch: realmMocks.authenticatedHubFetch,
  cancelPendingRealmInfoRequest: realmMocks.cancelPendingRealmInfoRequest,
  downloadRisuHub: realmMocks.downloadRisuHub,
  getRealmInfo: vi.fn(),
  getRisuHub: realmMocks.getRisuHub,
  hubURL: 'https://realm.example',
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: realmMocks.alertConfirm,
  alertError: realmMocks.alertError,
  alertInput: realmMocks.alertInput,
  alertNormal: realmMocks.alertNormal,
}))

vi.mock('src/ts/server/resourceState.svelte', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/server/resourceState.svelte')>()
  return {
    ...actual,
    getResourceDatabase: () => ({ hideAllImages: true, language: 'en' }),
  }
})

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import RealmMain from './RealmMain.svelte'
import { MobileGUI, RealmInitialOpenChar } from 'src/ts/stores.svelte'
import type { hubType, RisuHubCatalogResult } from 'src/ts/characterCards'
import { language } from 'src/lang'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function card(id: string, name: string): hubType {
  return {
    id,
    name,
    desc: `${name} description`,
    download: '',
    img: '',
    tags: [],
    viewScreen: 'none',
    hasLore: false,
    hasEmotion: false,
    hasAsset: false,
    hot: 0,
    license: '',
    type: 'character',
  }
}

function catalog(cards: hubType[], additionalHTML = ''): RisuHubCatalogResult {
  return { status: 'ok', cards, additionalHTML }
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(target.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`button not found: ${label}`)
  return match
}

function nextPageButton(): HTMLButtonElement {
  return labelledButton(language.realm.nextPage)
}

function searchInput(): HTMLInputElement {
  const match = target.querySelector('input')
  if (!match) throw new Error('Realm search input not found')
  return match
}

function searchButton(): HTMLButtonElement {
  const match = searchInput().nextElementSibling
  if (!(match instanceof HTMLButtonElement)) throw new Error('Realm search button not found')
  return match
}

function labelledButton(label: string): HTMLButtonElement {
  const match = target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!match) throw new Error(`labelled button not found: ${label}`)
  return match
}

function latestQuery(): { search: string; page: number; nsfw: boolean; sort: string } {
  const call = realmMocks.getRisuHub.mock.calls.at(-1)
  if (!call) throw new Error('Realm query not found')
  return call[0]
}

function currentPage(): HTMLElement {
  const match = target.querySelector<HTMLElement>('[aria-current="page"]')
  if (!match) throw new Error('current Realm page not found')
  return match
}

let component: Parameters<typeof unmount>[0] | undefined
let target: HTMLElement

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  realmMocks.getRisuHub.mockReset()
  realmMocks.alertConfirm.mockReset()
  realmMocks.alertError.mockReset()
  realmMocks.alertInput.mockReset()
  realmMocks.alertNormal.mockReset()
  realmMocks.authenticatedHubFetch.mockReset()
  realmMocks.downloadRisuHub.mockReset()
  MobileGUI.set(false)
  RealmInitialOpenChar.set(null)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  MobileGUI.set(false)
  RealmInitialOpenChar.set(null)
})

describe('RealmMain request ownership', () => {
  it('distinguishes a failed catalog request from a valid empty result and retries', async () => {
    realmMocks.getRisuHub
      .mockResolvedValueOnce({ status: 'error', cards: [], additionalHTML: '' })
      .mockResolvedValueOnce(catalog([]))

    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(target.textContent).toContain(language.realm.catalogLoadFailed))
    expect(target.querySelector('[role="alert"]')).toBeTruthy()

    button(language.retry).click()
    await vi.waitFor(() => expect(target.textContent).toContain(language.realm.emptyCatalog))
    expect(target.querySelector('[role="alert"]')).toBeNull()
    expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(2)
  })

  it('does not let an older catalog response replace the latest cards or banner', async () => {
    const older = deferred<RisuHubCatalogResult>()
    const latest = deferred<RisuHubCatalogResult>()
    realmMocks.getRisuHub.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)

    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    button('Recent').click()
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(2))

    latest.resolve(catalog([card('latest', 'Latest result')], '<aside>Latest banner</aside>'))
    await tick()
    expect(target.textContent).toContain('Latest result')
    expect(target.textContent).toContain('Latest banner')

    older.resolve(catalog([card('older', 'Older result')], '<aside>Older banner</aside>'))
    await tick()
    expect(target.textContent).toContain('Latest result')
    expect(target.textContent).toContain('Latest banner')
    expect(target.textContent).not.toContain('Older result')
    expect(target.textContent).not.toContain('Older banner')
  })

  it('clears the prior banner when the latest response omits it', async () => {
    realmMocks.getRisuHub
      .mockResolvedValueOnce(catalog([card('initial', 'Initial result')], '<aside>Initial banner</aside>'))
      .mockResolvedValueOnce(catalog([card('latest', 'Latest result')]))

    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Initial banner'))

    button('Recent').click()
    await vi.waitFor(() => expect(target.textContent).toContain('Latest result'))
    expect(target.textContent).not.toContain('Initial result')
    expect(target.textContent).not.toContain('Initial banner')
  })

  it('invalidates and aborts a pending catalog request when unmounted', async () => {
    const pending = deferred<RisuHubCatalogResult>()
    realmMocks.getRisuHub.mockReturnValue(pending.promise)

    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))
    const signal = realmMocks.getRisuHub.mock.calls[0][0].signal as AbortSignal
    expect(signal.aborted).toBe(false)

    unmount(component)
    component = undefined
    expect(signal.aborted).toBe(true)

    pending.resolve(catalog([card('late', 'Late result')], '<aside>Late banner</aside>'))
    await tick()
    expect(target.textContent).not.toContain('Late result')
    expect(target.textContent).not.toContain('Late banner')
  })
})

describe('RealmMain query pagination', () => {
  it('announces the active desktop catalog filters', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    expect(button('NSFW').getAttribute('aria-pressed')).toBe('false')
    expect(button('Recent').getAttribute('aria-pressed')).toBe('false')

    button('NSFW').click()
    button('Trending').click()
    await tick()

    expect(button('NSFW').getAttribute('aria-pressed')).toBe('true')
    expect(button('Recent').getAttribute('aria-pressed')).toBe('false')
    expect(button('Trending').getAttribute('aria-pressed')).toBe('true')
    expect(button('Downloads').getAttribute('aria-pressed')).toBe('false')
  })

  it('returns desktop search, sort, and content filters to the first page', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    button('Recent').click()
    await tick()
    nextPageButton().click()
    expect(latestQuery()).toMatchObject({ page: 1, sort: '' })

    button('NSFW').click()
    expect(latestQuery()).toMatchObject({ page: 0, nsfw: true, sort: '' })
    expect(currentPage().textContent?.trim()).toBe('1')

    nextPageButton().click()
    const input = searchInput()
    input.value = 'new query'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    searchButton().click()
    expect(latestQuery()).toMatchObject({ search: 'new query', page: 0 })
    expect(currentPage().textContent?.trim()).toBe('1')

    nextPageButton().click()
    button('Trending').click()
    expect(latestQuery()).toMatchObject({ page: 0, sort: 'trending' })
    expect(currentPage().textContent?.trim()).toBe('1')
  })

  it('returns the mobile sort cycle to the first page', async () => {
    MobileGUI.set(true)
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    button('Recommended').click()
    await tick()
    nextPageButton().click()
    expect(latestQuery()).toMatchObject({ page: 1, sort: '' })

    button('Recent').click()
    expect(latestQuery()).toMatchObject({ page: 0, sort: 'trending' })
    expect(currentPage().textContent?.trim()).toBe('1')
  })
})

describe('RealmMain character import input', () => {
  it('does nothing when the input prompt is cancelled or blank', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    realmMocks.alertInput.mockResolvedValue('   ')
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    labelledButton(language.menu).click()
    await tick()
    button(language.realm.importCharacter).click()

    await vi.waitFor(() => expect(realmMocks.alertInput).toHaveBeenCalledWith(language.realm.importPrompt))
    expect(realmMocks.downloadRisuHub).not.toHaveBeenCalled()
    expect(realmMocks.alertError).not.toHaveBeenCalled()
  })

  it('rejects malformed URLs without throwing or starting a download', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    realmMocks.alertInput.mockResolvedValue('https://[broken')
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    labelledButton(language.menu).click()
    await tick()
    button(language.realm.importCharacter).click()

    await vi.waitFor(() => expect(realmMocks.alertError).toHaveBeenCalledWith(language.realm.invalidImport))
    expect(realmMocks.downloadRisuHub).not.toHaveBeenCalled()
  })

  it('downloads the path id from a Realm URL without its query or fragment', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    realmMocks.alertInput.mockResolvedValue('https://realm.risuai.net/character/path-card?source=share#preview')
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    labelledButton(language.menu).click()
    await tick()
    button(language.realm.importCharacter).click()

    await vi.waitFor(() => expect(realmMocks.downloadRisuHub).toHaveBeenCalledWith('path-card'))
  })
})

describe('RealmMain modal behavior', () => {
  it('traps menu focus and closes it with Escape while restoring its opener', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([]))
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(realmMocks.getRisuHub).toHaveBeenCalledTimes(1))

    const opener = labelledButton(language.menu)
    opener.focus()
    opener.click()
    await tick()
    await Promise.resolve()

    expect(target.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(language.close)

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    await Promise.resolve()
    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(opener)
  })

  it('closes the character dialog through Escape and backdrop clicks', async () => {
    realmMocks.getRisuHub.mockResolvedValue(catalog([card('realm-card', 'Realm result')]))
    component = mount(RealmMain, { target })
    await vi.waitFor(() => expect(target.textContent).toContain('Realm result'))

    const opener = labelledButton(language.openCharacter('Realm result'))
    opener.focus()
    opener.click()
    await tick()
    await Promise.resolve()
    expect(target.querySelector('[role="dialog"]')).not.toBeNull()

    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    await Promise.resolve()
    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)

    opener.click()
    await tick()
    const backdrop = target.querySelector<HTMLElement>('[data-modal-root]')
    expect(backdrop).not.toBeNull()
    backdrop?.click()
    await tick()
    expect(target.querySelector('[role="dialog"]')).toBeNull()
  })
})
