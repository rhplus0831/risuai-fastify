import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bardWikiMocks = vi.hoisted(() => ({
  draft: {
    value: {} as Record<string, unknown>,
    retryPersistence: vi.fn(),
  },
  persistenceStatus: undefined as undefined | ((status: 'idle' | 'saving' | 'accepted' | 'queued' | 'failed') => void),
  navigate: vi.fn(),
  openWorkspace: vi.fn(),
  canOpenWorkspace: false,
  alertConfirm: vi.fn(),
}))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  createServerBackedSettingDraft: (
    _key: string,
    _fallback: unknown,
    options?: { onPersistenceStatus?: typeof bardWikiMocks.persistenceStatus },
  ) => {
    bardWikiMocks.persistenceStatus = options?.onPersistenceStatus
    return bardWikiMocks.draft
  },
}))

vi.mock('src/ts/router', () => ({
  canOpenBardWikiWorkspaceFromSettings: () => bardWikiMocks.canOpenWorkspace,
  navigate: bardWikiMocks.navigate,
  openBardWikiWorkspaceFromSettings: bardWikiMocks.openWorkspace,
}))

vi.mock('src/ts/alert', () => ({
  alertConfirm: bardWikiMocks.alertConfirm,
}))

import BardWikiSettings from './BardWikiSettings.svelte'
import { language } from 'src/lang'
import { DEFAULT_BARDWIKI_GLOBAL_SETTINGS } from '@risuai/protocol'
import { replaceResourceDatabase } from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

beforeEach(() => {
  bardWikiMocks.draft.value = structuredClone(DEFAULT_BARDWIKI_GLOBAL_SETTINGS)
  bardWikiMocks.draft.retryPersistence.mockReset()
  bardWikiMocks.persistenceStatus = undefined
  bardWikiMocks.navigate.mockReset()
  bardWikiMocks.openWorkspace.mockReset()
  bardWikiMocks.canOpenWorkspace = false
  bardWikiMocks.alertConfirm.mockReset()
  bardWikiMocks.alertConfirm.mockResolvedValue(true)
  replaceResourceDatabase({
    modelProfiles: [{ id: 'profile-a', name: 'Profile A' }],
    promptPresets: [{ id: 'prompt-a', name: 'Prompt A' }],
  } as any)
  target = document.createElement('div')
  document.body.appendChild(target)
})

afterEach(() => {
  if (component) unmount(component)
  component = undefined
  target.remove()
})

describe('BardWiki settings', () => {
  it('explains the defaults and reveals only controls that affect the selected memory source', async () => {
    component = mount(BardWikiSettings, { target })
    await tick()

    expect(target.querySelector('[data-risu-bardwiki-settings]')).toBeTruthy()
    expect(target.querySelector('[data-testid="bardwiki-effective-summary"]')?.textContent).toContain(
      language.bardWiki.summaryDisabled,
    )
    expect(target.querySelector('[data-testid="bardwiki-mode-description"]')?.textContent).toContain(
      language.bardWiki.modeHypaDescription,
    )
    expect(target.querySelector('[data-testid="bardwiki-advanced-retrieval"]')).toBeNull()

    component && unmount(component)
    component = undefined
    target.replaceChildren()
    bardWikiMocks.draft.value = { ...bardWikiMocks.draft.value, memoryMode: 'hybrid' }
    component = mount(BardWikiSettings, { target })
    await tick()

    expect(target.querySelector('[data-testid="bardwiki-advanced-retrieval"]')).toBeTruthy()
    expect(
      target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.totalTokenBudget}"]`)?.value,
    ).toBe('2048')
    expect(target.querySelector<HTMLSelectElement>('#bardwiki-model-profile')?.options).toHaveLength(2)
    expect(target.querySelector<HTMLSelectElement>('#bardwiki-prompt-preset')?.options).toHaveLength(2)
    expect(
      target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.automaticConfirmation}"]`)
        ?.disabled,
    ).toBe(false)
    expect(
      target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.canonicalUpdates}"]`)?.disabled,
    ).toBe(false)
    expect(target.textContent).toContain(language.bardWiki.autosave)
  })

  it('projects user-controlled settings into the server-backed object draft', async () => {
    component = mount(BardWikiSettings, { target })
    await tick()

    target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.enabledByDefault}"]`)?.click()
    target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.automaticConfirmation}"]`)?.click()
    target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.canonicalUpdates}"]`)?.click()
    target.querySelectorAll<HTMLButtonElement>('button[data-segment-btn]').item(2).click()
    const profile = target.querySelector<HTMLSelectElement>('#bardwiki-model-profile')!
    profile.value = 'profile-a'
    profile.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()

    expect(bardWikiMocks.draft.value).toMatchObject({
      enabledByDefault: true,
      memoryMode: 'hybrid',
      modelProfileId: 'profile-a',
      confirmationPolicy: 'automatic',
      canonicalUpdates: true,
    })
  })

  it('shows the effective hybrid allocation and preserves hidden values when modes change', async () => {
    bardWikiMocks.draft.value = {
      ...structuredClone(DEFAULT_BARDWIKI_GLOBAL_SETTINGS),
      enabledByDefault: true,
      memoryMode: 'hybrid',
      hybridHypaTokenBudget: 1800,
      hybridBardWikiTokenBudget: 1000,
    }
    component = mount(BardWikiSettings, { target })
    await tick()

    expect(target.querySelector('[data-testid="bardwiki-hybrid-budget-status"]')?.getAttribute('role')).toBe('alert')
    expect(target.querySelector('[data-testid="bardwiki-hybrid-budget-status"]')?.textContent).toContain('1,800 Hypa')
    expect(target.querySelector('[data-testid="bardwiki-hybrid-budget-status"]')?.textContent).toContain('248 BardWiki')

    target.querySelectorAll<HTMLButtonElement>('button[data-segment-btn]').item(0).click()
    component && unmount(component)
    component = undefined
    target.replaceChildren()
    component = mount(BardWikiSettings, { target })
    await tick()
    expect(target.querySelector('[data-testid="bardwiki-advanced-retrieval"]')).toBeNull()

    target.querySelectorAll<HTMLButtonElement>('button[data-segment-btn]').item(2).click()
    component && unmount(component)
    component = undefined
    target.replaceChildren()
    component = mount(BardWikiSettings, { target })
    await tick()
    expect(
      target.querySelector<HTMLInputElement>(`input[aria-label="${language.bardWiki.hybridHypaTokenBudget}"]`)?.value,
    ).toBe('1800')
  })

  it('renders persistence feedback and retries a retained failed draft', async () => {
    component = mount(BardWikiSettings, { target })
    await tick()

    bardWikiMocks.persistenceStatus?.('saving')
    await tick()
    expect(target.textContent).toContain(language.bardWiki.saving)

    bardWikiMocks.persistenceStatus?.('failed')
    await tick()
    expect(target.textContent).toContain(language.bardWiki.saveFailed)
    Array.from(target.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === language.retry)
      ?.click()
    expect(bardWikiMocks.draft.retryPersistence).toHaveBeenCalledOnce()
  })

  it('opens the originating chat workspace when Settings has a chat origin', async () => {
    bardWikiMocks.canOpenWorkspace = true
    component = mount(BardWikiSettings, { target })
    await tick()

    Array.from(target.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === language.bardWiki.openCurrentChatWorkspace)
      ?.click()

    expect(bardWikiMocks.openWorkspace).toHaveBeenCalledOnce()
  })

  it('resets the complete setting object to recommended defaults after confirmation', async () => {
    bardWikiMocks.draft.value = {
      ...structuredClone(DEFAULT_BARDWIKI_GLOBAL_SETTINGS),
      enabledByDefault: true,
      memoryMode: 'hybrid',
      modelProfileId: 'profile-a',
    }
    component = mount(BardWikiSettings, { target })
    await tick()

    Array.from(target.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === language.bardWiki.resetRecommended)
      ?.click()
    await vi.waitFor(() => expect(bardWikiMocks.alertConfirm).toHaveBeenCalledOnce())
    expect(bardWikiMocks.draft.value).toEqual(DEFAULT_BARDWIKI_GLOBAL_SETTINGS)
  })
})
