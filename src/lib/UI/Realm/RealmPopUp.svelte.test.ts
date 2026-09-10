import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const popupMocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  authenticatedHubFetch: vi.fn(),
  cancelPendingRealmInfoRequest: vi.fn(),
  clipboardWrite: vi.fn(),
  downloadRisuHub: vi.fn(),
  getRealmInfo: vi.fn(),
  database: {
    hideAllImages: true,
    language: 'en',
    account: {
      id: 'realm-owner',
      token: '__RISU_SECRET_MASKED__',
    },
  },
}))

vi.mock('src/ts/characterCards', () => ({
  authenticatedHubFetch: popupMocks.authenticatedHubFetch,
  downloadRisuHub: popupMocks.downloadRisuHub,
  cancelPendingRealmInfoRequest: popupMocks.cancelPendingRealmInfoRequest,
  getRealmInfo: popupMocks.getRealmInfo,
  hubURL: '/api/v1/hub',
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: popupMocks.alertConfirm,
  alertError: popupMocks.alertError,
  alertInput: popupMocks.alertInput,
  alertNormal: popupMocks.alertNormal,
}))

vi.mock('src/ts/server/resourceState.svelte', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/server/resourceState.svelte')>()
  return {
    ...actual,
    settingsResourceState: {
      status: 'ready',
      value: popupMocks.database,
      groupStatuses: {
        account: 'ready',
        display: 'ready',
        language: 'ready',
      },
    },
  }
})

vi.mock('src/ts/process/modules', () => ({
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import RealmPopUp from './RealmPopUp.svelte'
import type { hubType } from 'src/ts/characterCards'
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

function card(id = 'realm-card'): hubType {
  return {
    id,
    name: 'Realm card',
    desc: 'Realm description',
    download: '3',
    img: '',
    tags: [],
    viewScreen: 'none',
    hasLore: false,
    hasEmotion: false,
    hasAsset: false,
    creator: 'realm-owner',
    hot: 0,
    license: '',
    type: 'character',
  }
}

function labelledButton(label: string): HTMLButtonElement {
  const match = target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!match) throw new Error(`button not found: ${label}`)
  return match
}

let component: Parameters<typeof unmount>[0] | undefined
let target: HTMLElement

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  popupMocks.alertConfirm.mockReset()
  popupMocks.alertError.mockReset()
  popupMocks.alertInput.mockReset()
  popupMocks.alertNormal.mockReset()
  popupMocks.authenticatedHubFetch.mockReset()
  popupMocks.cancelPendingRealmInfoRequest.mockReset()
  popupMocks.clipboardWrite.mockReset()
  popupMocks.downloadRisuHub.mockReset()
  popupMocks.getRealmInfo.mockReset()
  popupMocks.database.account.id = 'realm-owner'
  popupMocks.authenticatedHubFetch.mockResolvedValue(new Response('removed'))
  popupMocks.clipboardWrite.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: popupMocks.clipboardWrite },
  })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
})

describe('RealmPopUp removal ownership', () => {
  it('uses the projected account id and sends only a stable card id', async () => {
    const confirmation = deferred<boolean>()
    popupMocks.alertConfirm.mockReturnValue(confirmation.promise)
    const response = new Response('removed')
    const text = vi.spyOn(response, 'text')
    popupMocks.authenticatedHubFetch.mockResolvedValue(response)
    const openedData = card('original-card')
    component = mount(RealmPopUp, { target, props: { openedData } })

    labelledButton(language.realm.removeCharacter).click()
    openedData.id = 'replacement-card'
    confirmation.resolve(true)

    await vi.waitFor(() => expect(popupMocks.authenticatedHubFetch).toHaveBeenCalledTimes(1))
    const [url, init] = popupMocks.authenticatedHubFetch.mock.calls[0]
    expect(url).toBe('/api/v1/hub/hub/remove')
    expect(JSON.parse(String(init.body))).toEqual({ id: 'original-card' })
    expect(JSON.parse(String(init.body))).not.toHaveProperty('token')
    await vi.waitFor(() => expect(popupMocks.alertNormal).toHaveBeenCalledWith('removed'))
    expect(text).toHaveBeenCalledTimes(1)
    expect(popupMocks.alertError).not.toHaveBeenCalled()
  })

  it('does not offer removal when the card has no creator identity', () => {
    const openedData = card()
    openedData.creator = undefined
    component = mount(RealmPopUp, { target, props: { openedData } })

    expect(target.querySelector(`button[aria-label="${language.realm.removeCharacter}"]`)).toBeNull()
  })

  it('does not offer removal when the signed-in account does not own the card', () => {
    popupMocks.database.account.id = 'different-account'
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    expect(target.querySelector(`button[aria-label="${language.realm.removeCharacter}"]`)).toBeNull()
    expect(target.querySelector(`button[aria-label="${language.realm.reportCharacter}"]`)).not.toBeNull()
  })

  it('allows only one removal request and removes the accepted card from its owner', async () => {
    popupMocks.alertConfirm.mockResolvedValue(true)
    const response = deferred<Response>()
    popupMocks.authenticatedHubFetch.mockReturnValue(response.promise)
    const onRemoved = vi.fn()
    component = mount(RealmPopUp, { target, props: { openedData: card('delete-once'), onRemoved } })

    const remove = labelledButton(language.realm.removeCharacter)
    remove.click()
    await vi.waitFor(() => expect(popupMocks.authenticatedHubFetch).toHaveBeenCalledOnce())
    expect(remove.disabled).toBe(true)
    expect(remove.getAttribute('aria-busy')).toBe('true')
    remove.click()
    expect(popupMocks.authenticatedHubFetch).toHaveBeenCalledOnce()

    response.resolve(new Response('removed'))
    await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledWith('delete-once'))
    expect(popupMocks.cancelPendingRealmInfoRequest).toHaveBeenCalledOnce()
  })
})

describe('RealmPopUp report actions', () => {
  it('stops when report confirmation is cancelled', async () => {
    popupMocks.alertConfirm.mockResolvedValue(false)
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    labelledButton(language.realm.reportCharacter).click()

    await vi.waitFor(() => expect(popupMocks.alertConfirm).toHaveBeenCalledWith(language.realm.reportConfirm))
    expect(popupMocks.alertInput).not.toHaveBeenCalled()
    expect(popupMocks.authenticatedHubFetch).not.toHaveBeenCalled()
  })

  it('stops when the report prompt is cancelled or blank', async () => {
    popupMocks.alertConfirm.mockResolvedValue(true)
    popupMocks.alertInput.mockResolvedValue('   ')
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    labelledButton(language.realm.reportCharacter).click()

    await vi.waitFor(() => expect(popupMocks.alertInput).toHaveBeenCalledWith(language.realm.reportPrompt))
    expect(popupMocks.authenticatedHubFetch).not.toHaveBeenCalled()
  })

  it('keeps the clicked card id stable across both report prompts', async () => {
    const confirmation = deferred<boolean>()
    popupMocks.alertConfirm.mockReturnValue(confirmation.promise)
    popupMocks.alertInput.mockResolvedValue('  actionable report  ')
    popupMocks.authenticatedHubFetch.mockResolvedValue(new Response('reported'))
    const openedData = card('original-card')
    component = mount(RealmPopUp, { target, props: { openedData } })

    labelledButton(language.realm.reportCharacter).click()
    openedData.id = 'replacement-card'
    confirmation.resolve(true)

    await vi.waitFor(() => expect(popupMocks.authenticatedHubFetch).toHaveBeenCalledTimes(1))
    const [url, init] = popupMocks.authenticatedHubFetch.mock.calls[0]
    expect(url).toBe('/api/v1/hub/hub/report')
    expect(JSON.parse(String(init.body))).toEqual({
      id: 'original-card',
      report: 'actionable report',
    })
    expect(popupMocks.alertNormal).toHaveBeenCalledWith('reported')
  })
})

describe('RealmPopUp action responses', () => {
  it('routes a 401 report response to a localized error without claiming success', async () => {
    const response = new Response('authentication required', { status: 401 })
    const text = vi.spyOn(response, 'text')
    popupMocks.alertConfirm.mockResolvedValue(true)
    popupMocks.alertInput.mockResolvedValue('actionable report')
    popupMocks.authenticatedHubFetch.mockResolvedValue(response)
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    labelledButton(language.realm.reportCharacter).click()

    await vi.waitFor(() =>
      expect(popupMocks.alertError).toHaveBeenCalledWith(
        `${language.errors.httpError} HTTP 401: authentication required`,
      ),
    )
    expect(text).toHaveBeenCalledTimes(1)
    expect(popupMocks.alertNormal).not.toHaveBeenCalled()
  })

  it('routes a 500 removal response to a localized error without claiming success', async () => {
    const response = new Response('Realm unavailable', { status: 500 })
    const text = vi.spyOn(response, 'text')
    popupMocks.alertConfirm.mockResolvedValue(true)
    popupMocks.authenticatedHubFetch.mockResolvedValue(response)
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    labelledButton(language.realm.removeCharacter).click()

    await vi.waitFor(() =>
      expect(popupMocks.alertError).toHaveBeenCalledWith(`${language.errors.httpError} HTTP 500: Realm unavailable`),
    )
    expect(text).toHaveBeenCalledTimes(1)
    expect(popupMocks.alertNormal).not.toHaveBeenCalled()
  })

  it('reports a successful report response body once', async () => {
    const response = new Response('reported', { status: 200 })
    const text = vi.spyOn(response, 'text')
    popupMocks.alertConfirm.mockResolvedValue(true)
    popupMocks.alertInput.mockResolvedValue('actionable report')
    popupMocks.authenticatedHubFetch.mockResolvedValue(response)
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    labelledButton(language.realm.reportCharacter).click()

    await vi.waitFor(() => expect(popupMocks.alertNormal).toHaveBeenCalledWith('reported'))
    expect(text).toHaveBeenCalledTimes(1)
    expect(popupMocks.alertError).not.toHaveBeenCalled()
  })
})

describe('RealmPopUp clipboard and modal accessibility', () => {
  it('reports clipboard failures instead of claiming success', async () => {
    popupMocks.clipboardWrite.mockRejectedValue(new Error('permission denied'))
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    labelledButton(language.realm.copyLink).click()

    await vi.waitFor(() => expect(popupMocks.alertError).toHaveBeenCalledWith(language.realm.clipboardFailed))
    expect(popupMocks.alertNormal).not.toHaveBeenCalledWith(language.clipboardSuccess)
  })

  it('names every icon-only action for assistive technology', () => {
    const openedData = card()
    openedData.hasEmotion = true
    openedData.hasAsset = true
    openedData.hasLore = true
    component = mount(RealmPopUp, { target, props: { openedData } })

    const iconButtons = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
      button.querySelector('svg'),
    )
    expect(iconButtons.length).toBeGreaterThan(0)
    for (const button of iconButtons) {
      expect(button.getAttribute('aria-label')?.trim()).toBeTruthy()
    }
  })

  it('traps initial focus, inerts the modal background, and restores it on destroy', async () => {
    const background = document.createElement('button')
    background.textContent = 'Background action'
    target.appendChild(background)
    component = mount(RealmPopUp, { target, props: { openedData: card() } })

    await tick()
    await Promise.resolve()
    expect(background.inert).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement?.getAttribute('aria-label')).toBe(language.close)

    unmount(component)
    component = undefined
    await Promise.resolve()
    expect(background.inert).toBe(false)
    expect(document.body.style.overflow).toBe('')
  })
})
