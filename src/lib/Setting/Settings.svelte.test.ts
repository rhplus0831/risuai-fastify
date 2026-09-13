import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const alertSpies = vi.hoisted(() => ({
  alertConfirm: vi.fn(async () => false),
}))

const supporterSpies = vi.hoisted(() => ({
  loadSupporters: vi.fn(),
}))

const routeIntentSpies = vi.hoisted(() => ({
  prefetch: vi.fn(),
}))

vi.mock('src/ts/routeIntentPrefetch', () => ({ prefetchRouteIntent: routeIntentSpies.prefetch }))

vi.mock('src/ts/server/routeResourceLoader', () => ({
  finishRouteResources: vi.fn(async () => true),
  prepareRouteResources: vi.fn(async () => true),
}))

vi.mock('src/ts/alert', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/alert')>()
  return {
    ...actual,
    alertConfirm: alertSpies.alertConfirm,
  }
})

vi.mock('src/ts/globalApi.svelte', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/globalApi.svelte')>()
  return {
    ...actual,
    openURL: vi.fn(),
  }
})

vi.mock('src/ts/process/modules', () => ({
  applyModule: vi.fn(),
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  readModule: vi.fn(),
  refreshModules: vi.fn(),
}))

vi.mock('./Pages/supporters', async (importActual) => {
  const actual = await importActual<typeof import('./Pages/supporters')>()
  supporterSpies.loadSupporters.mockImplementation(async () => {
    const supp = await fetch(actual.SUPPORTER_ENDPOINT)
    if (!supp.ok) {
      throw new Error(`Failed to load supporters (${supp.status})`)
    }

    await supp.json()
    return actual.createEmptySupporterBuckets()
  })

  return {
    ...actual,
    loadSupporters: supporterSpies.loadSupporters,
  }
})

import { SUPPORTER_ENDPOINT } from './Pages/supporters'
import Settings from './Settings.svelte'
import { language } from 'src/lang'
import { additionalSettingsMenu, MobileGUI, SettingsMenuIndex } from 'src/ts/stores.svelte'
import { replaceResourceDatabase as setDatabaseLite } from 'src/ts/server/resourceState.svelte'
import { isLite } from 'src/ts/lite'
import { applyRouteToStores, currentRoute, navigate } from 'src/ts/router'
import { getResourceDatabase as getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function supporterButton() {
  const button = Array.from(target.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(language.settingsNavSupporters),
  )
  expect(button).toBeTruthy()
  return button!
}

function settingsButton(label: string) {
  return Array.from(target.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label)
}

async function flushClick() {
  await Promise.resolve()
  await tick()
}

async function applyNavigatedRoute() {
  await applyRouteToStores(get(currentRoute))
  await tick()
  await Promise.resolve()
  await vi.waitFor(
    () => {
      expect(target.querySelector('[data-testid$="-pending"]')).toBeNull()
    },
    { timeout: 5_000 },
  )
}

async function resizeViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
  await tick()
}

describe('Settings supporter tab', () => {
  beforeEach(() => {
    navigate('/')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    additionalSettingsMenu.splice(0)
    setDatabaseLite({
      enableRisuaiProTools: false,
      doNotWarnExternalServers: false,
      settingsCloseButtonSize: 24,
    } as any)
    isLite.set(false)
    MobileGUI.set(false)
    SettingsMenuIndex.set(-1)
    alertSpies.alertConfirm.mockReset()
    alertSpies.alertConfirm.mockResolvedValue(false)
    supporterSpies.loadSupporters.mockClear()
    routeIntentSpies.prefetch.mockReset()
    vi.stubGlobal('fetch', vi.fn())

    target = document.createElement('div')
    document.body.appendChild(target)
    component = mount(Settings, { target })
  })

  afterEach(() => {
    if (component) {
      unmount(component)
      component = undefined
    }
    vi.unstubAllGlobals()
    target.remove()
    document.body.innerHTML = ''
    navigate('/')
  })

  it('does not navigate or fetch supporters when the user cancels', async () => {
    const initialPath = window.location.pathname

    supporterButton().click()
    await flushClick()

    expect(alertSpies.alertConfirm).toHaveBeenCalledWith(language.sendExternalServerWarning)
    expect(window.location.pathname).toBe(initialPath)
    expect(get(currentRoute)).toMatchObject({ kind: 'home', path: initialPath })
    expect(get(SettingsMenuIndex)).toBe(-1)
    expect(supporterSpies.loadSupporters).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('navigates to supporters only after confirmation', async () => {
    alertSpies.alertConfirm.mockResolvedValue(true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ amount: 50, name: 'top' }]))),
    )

    supporterButton().click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/supporter',
      section: 'supporter',
      index: 77,
    })
    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(77)
    expect(supporterSpies.loadSupporters).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(SUPPORTER_ENDPOINT)
  })

  it('skips the external server warning when the opt-out is enabled', async () => {
    getDatabase().doNotWarnExternalServers = true

    supporterButton().click()
    await flushClick()

    expect(alertSpies.alertConfirm).not.toHaveBeenCalled()
    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/supporter',
      section: 'supporter',
      index: 77,
    })
    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(77)
    expect(supporterSpies.loadSupporters).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(SUPPORTER_ENDPOINT)
  })

  it('groups model and prompt setup without the legacy bot presets item by default', () => {
    expect(target.textContent).toContain(language.settingsGroupChatSetup)
    expect(settingsButton(language.settingsNavModelProfiles)).toBeTruthy()
    expect(settingsButton(language.settingsNavPromptPresets)).toBeTruthy()
    expect(settingsButton(language.settingsNavAgentPresets)).toBeTruthy()
    expect(settingsButton(language.settingsNavInputHooks)).toBeTruthy()
    expect(settingsButton(language.settingsNavMemory)).toBeTruthy()
    expect(settingsButton(language.bardWiki.title)).toBeTruthy()
    expect(settingsButton(language.settingsNavLegacyBotPresets)).toBeUndefined()
  })

  it('warms the exact settings page on pointer or keyboard intent', () => {
    const modelButton = settingsButton(language.settingsNavModelProfiles)
    const promptButton = settingsButton(language.settingsNavPromptPresets)
    const memoryButton = settingsButton(language.settingsNavMemory)
    const bardWikiButton = settingsButton(language.bardWiki.title)
    expect(modelButton).toBeTruthy()
    expect(promptButton).toBeTruthy()
    expect(memoryButton).toBeTruthy()
    expect(bardWikiButton).toBeTruthy()

    modelButton?.dispatchEvent(new Event('pointerover', { bubbles: true }))
    promptButton?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    memoryButton?.dispatchEvent(new Event('pointerover', { bubbles: true }))
    bardWikiButton?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))

    expect(routeIntentSpies.prefetch).toHaveBeenNthCalledWith(1, '/settings/model')
    expect(routeIntentSpies.prefetch).toHaveBeenNthCalledWith(2, '/settings/prompt-settings')
    expect(routeIntentSpies.prefetch).toHaveBeenNthCalledWith(3, '/settings/memory')
    expect(routeIntentSpies.prefetch).toHaveBeenNthCalledWith(4, '/settings/bardwiki')
  })

  it.each([
    ['settingsNavInteraction', '/settings/interaction', 24, 'sendWithEnter', 'reducedMotion'],
    ['settingsNavAccessibility', '/settings/accessibility', 11, 'reducedMotion', 'sendWithEnter'],
  ] as const)(
    'opens %s with its own settings and mobile back navigation',
    async (label, path, index, included, excluded) => {
      const button = settingsButton(language[label])
      expect(button).toBeTruthy()
      button!.click()
      await flushClick()
      expect(get(currentRoute)).toMatchObject({ kind: 'settings', path, index })
      await applyNavigatedRoute()
      expect(target.querySelector('h2')?.textContent).toBe(language[label])
      expect(target.textContent).toContain(language[included])
      expect(target.textContent).not.toContain(language[excluded])
      const back = target.querySelector<HTMLButtonElement>('[data-risu-settings-mobile-back]')
      expect(back).toBeTruthy()
      back!.click()
      await flushClick()
      expect(get(currentRoute)).toMatchObject({ kind: 'settings', path: '/settings', index: -1 })
    },
  )

  it('links Accessibility to the display controls', async () => {
    await navigate('/settings/accessibility')
    await applyNavigatedRoute()

    const link = Array.from(target.querySelectorAll<HTMLAnchorElement>('a')).find(
      (candidate) => candidate.textContent?.trim() === language.accessibilityDisplaySettingsLink,
    )
    expect(link).toBeTruthy()
    expect(link!.getAttribute('href')).toBe('/settings/display')
    link!.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({ kind: 'settings', path: '/settings/display', index: 3 })
    await applyNavigatedRoute()
    expect(target.querySelector('h2')?.textContent).toBe(language.display)
  })

  it('opens Memory through its canonical route', async () => {
    const memoryButton = settingsButton(language.settingsNavMemory)
    expect(memoryButton).toBeTruthy()

    memoryButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/memory',
      section: 'memory',
      index: 2,
    })
  })

  it('opens the standalone BardWiki settings page from Tools & Extensions', async () => {
    const bardWikiButton = settingsButton(language.bardWiki.title)
    expect(bardWikiButton).toBeTruthy()

    bardWikiButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/bardwiki',
      section: 'bardwiki',
      index: 23,
    })

    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(23)
    expect(target.querySelector('[data-risu-bardwiki-settings]')).toBeTruthy()
  })

  it('updates a selected settings page layout across the responsive breakpoint', async () => {
    SettingsMenuIndex.set(0)
    await tick()

    expect(settingsButton(language.settingsNavBackups)).toBeUndefined()
    expect(target.querySelector('[data-risu-settings-mobile-back]')).toBeTruthy()

    await resizeViewport(800)

    expect(settingsButton(language.settingsNavBackups)).toBeTruthy()
    expect(target.querySelector('[data-risu-settings-mobile-back]')).toBeNull()

    await resizeViewport(500)

    expect(settingsButton(language.settingsNavBackups)).toBeUndefined()
    expect(target.querySelector('[data-risu-settings-mobile-back]')).toBeTruthy()
  })

  it('shows the legacy bot presets settings item only when legacy bot presets remain', async () => {
    expect(settingsButton(language.settingsNavLegacyBotPresets)).toBeUndefined()

    if (component) {
      unmount(component)
      component = undefined
    }
    setDatabaseLite({
      enableRisuaiProTools: false,
      doNotWarnExternalServers: false,
      settingsCloseButtonSize: 24,
      botPresets: [{ id: 'legacy-preset', name: 'Legacy preset' }],
    } as any)
    component = mount(Settings, { target })
    await tick()

    expect(settingsButton(language.settingsNavModelProfiles)).toBeTruthy()
    expect(settingsButton(language.settingsNavPromptPresets)).toBeTruthy()
    expect(settingsButton(language.settingsNavAgentPresets)).toBeTruthy()
    expect(settingsButton(language.settingsNavInputHooks)).toBeTruthy()
    expect(settingsButton(language.settingsNavLegacyBotPresets)).toBeTruthy()
  })

  it('opens the Agent Presets page from the settings nav', async () => {
    const agentPresetsButton = settingsButton(language.settingsNavAgentPresets)
    expect(agentPresetsButton).toBeTruthy()

    agentPresetsButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/agent-presets',
      section: 'agent-presets',
      index: 19,
    })

    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(19)
    expect(target.textContent).toContain(language.agentPresets.settingsTitle)
    expect(target.textContent).toContain(language.agentPresets.emptyState)
  })

  it('opens the Input Hooks page from the settings nav', async () => {
    const inputHooksButton = settingsButton(language.settingsNavInputHooks)
    expect(inputHooksButton).toBeTruthy()

    inputHooksButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/input-hooks',
      section: 'input-hooks',
      index: 20,
    })

    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(20)
    expect(target.textContent).toContain(language.inputHooks)
    expect(target.querySelector('[data-risu-input-hook-settings]')).toBeTruthy()
  })

  it('opens Request History from the Data settings group', async () => {
    const requestHistoryButton = settingsButton(language.settingsNavRequestHistory)
    expect(requestHistoryButton).toBeTruthy()

    requestHistoryButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/request-history',
      section: 'request-history',
      index: 21,
    })
  })

  it('opens Source Code from Advanced & About', async () => {
    const sourceCodeButton = settingsButton(language.settingsNavSourceCode)
    expect(sourceCodeButton).toBeTruthy()

    sourceCodeButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/source-code',
      section: 'source-code',
      index: 22,
    })

    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(22)
    expect(target.querySelector('[data-risu-source-code]')).toBeTruthy()
  })

  it('hides the legacy global lorebook and regex settings items by default', () => {
    expect(settingsButton(language.globalLoreBook)).toBeUndefined()
    expect(settingsButton(language.globalRegexScript)).toBeUndefined()
  })

  it.each([
    { path: '/settings/global-lorebook', section: 'global-lorebook', index: 8 },
    { path: '/settings/global-regex', section: 'global-regex', index: 9 },
  ])('keeps direct navigation to $path available while its nav item is hidden', async ({ path, section, index }) => {
    navigate(path)
    await tick()

    expect(get(currentRoute)).toMatchObject({ kind: 'settings', path, section, index })
    expect(settingsButton(language.globalLoreBook)).toBeUndefined()
    expect(settingsButton(language.globalRegexScript)).toBeUndefined()
  })

  it.each([
    {
      label: language.globalLoreBook,
      path: '/settings/global-lorebook',
      section: 'global-lorebook',
      index: 8,
    },
    {
      label: language.globalRegexScript,
      path: '/settings/global-regex',
      section: 'global-regex',
      index: 9,
    },
  ])('opens $label from the settings nav', async ({ label, path, section, index }) => {
    getDatabase().showGlobalLorebookAndRegex = true
    await tick()
    expect(settingsButton(label)).toBeTruthy()

    await resizeViewport(800)

    const button = settingsButton(label)
    expect(button).toBeTruthy()

    button?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path,
      section,
      index,
    })
  })

  it('returns from a selected mobile settings page to the settings menu', async () => {
    const backupsButton = settingsButton(language.settingsNavBackups)
    expect(backupsButton).toBeTruthy()

    backupsButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings/backup',
      section: 'backup',
      index: 0,
    })

    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(0)
    expect(target.textContent).toContain(language.saveServerBackup)
    expect(settingsButton(language.settingsNavBackups)).toBeUndefined()

    const backButton = target.querySelector<HTMLButtonElement>('[data-risu-settings-mobile-back]')
    expect(backButton).toBeTruthy()

    backButton?.click()
    await flushClick()

    expect(get(currentRoute)).toMatchObject({
      kind: 'settings',
      path: '/settings',
      section: '',
      index: -1,
    })

    await applyNavigatedRoute()

    expect(get(SettingsMenuIndex)).toBe(-1)
    expect(settingsButton(language.settingsNavBackups)).toBeTruthy()
    expect(target.textContent).not.toContain(language.saveServerBackup)
  })
})
