import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mutationSpies = vi.hoisted(() => ({
  createProviderCredentialDurably: vi.fn(),
  deleteProviderCredentialDurably: vi.fn(),
  updateProviderCredentialDurably: vi.fn(),
}))

vi.mock('src/ts/model/modelProfileMutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/ts/model/modelProfileMutations')>()),
  ...mutationSpies,
}))
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

import { language } from 'src/lang'
import { finishPendingModelMutation, getPendingModelMutations } from 'src/ts/model/modelProfileMutations'
import { MASKED_PROVIDER_SECRET } from 'src/ts/providerSecretMask'
import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import ProviderCredentialList from './ProviderCredentialList.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function button(label: string, index = 0): HTMLButtonElement {
  const matches = Array.from(target.querySelectorAll('button')).filter(
    (candidate) =>
      candidate.textContent?.includes(label) || candidate.getAttribute('aria-label')?.startsWith(`${label}:`),
  )
  const found = matches[index]
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`)
  return found
}

async function openActions(): Promise<void> {
  target.querySelector<HTMLButtonElement>('article button[aria-expanded]')?.click()
  await tick()
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

function clearPendingCredentials(): void {
  for (const pending of getPendingModelMutations('provider-credentials')) {
    finishPendingModelMutation(pending.token)
  }
}

beforeEach(() => {
  clearPendingCredentials()
  target = document.createElement('div')
  document.body.appendChild(target)
  setDatabaseLite({
    providerCredentials: [
      {
        id: 'credential-api',
        name: 'OpenAI',
        type: 'apiKey',
        apiKey: MASKED_PROVIDER_SECRET,
      },
    ],
    modelProfiles: [
      {
        id: 'profile-a',
        name: 'Profile A',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { credentialId: 'credential-api' },
      },
    ],
  } as any)
  for (const spy of Object.values(mutationSpies)) {
    spy.mockReset()
    spy.mockResolvedValue({ status: 'accepted', result: { status: 'ok' } })
  }
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  clearPendingCredentials()
  setDatabaseLite({} as any)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ProviderCredentialList', () => {
  it('opens the credential editor from its named edit control', async () => {
    component = mount(ProviderCredentialList, { target })
    await tick()

    expect(target.querySelector('[data-provider-credential-editor]')).toBeNull()
    button(language.modelProfiles.edit).click()
    await tick()

    const editor = target.querySelector('[data-provider-credential-editor]')
    expect(editor).not.toBeNull()
    expect(editor?.querySelector('input:not([type="password"])')).toHaveProperty('value', 'OpenAI')
    expect(mutationSpies.updateProviderCredentialDurably).not.toHaveBeenCalled()
  })

  it('fails closed on credential deletion when profile owner IDs are ambiguous', async () => {
    settingsResourceState.value.modelProfiles = [
      {
        id: 'duplicate-profile',
        name: 'First',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { credentialId: 'credential-api' },
      },
      {
        id: 'duplicate-profile',
        name: 'Second',
        providerId: 'openai',
        modelId: 'gpt-5',
      },
    ]

    component = mount(ProviderCredentialList, { target })
    await tick()

    await openActions()
    expect(button(language.modelProfiles.delete).disabled).toBe(true)
    expect(mutationSpies.deleteProviderCredentialDurably).not.toHaveBeenCalled()
  })

  it('renames a credential while preserving its masked secret and disables deletion while in use', async () => {
    component = mount(ProviderCredentialList, { target })
    await tick()

    await openActions()
    const deleteButton = button(language.modelProfiles.delete)
    expect(deleteButton.disabled).toBe(true)

    button(language.modelProfiles.edit).click()
    await tick()
    expect(target.querySelector('[data-secret-saved-state]')).not.toBeNull()

    const name = target.querySelector<HTMLInputElement>(
      '[data-provider-credential-editor] input:not([type="password"])',
    )
    if (!name) throw new Error('Credential name input not found')
    name.value = 'OpenAI renamed'
    name.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    button(language.modelProfiles.save).click()
    await flushAsync()

    expect(mutationSpies.updateProviderCredentialDurably).toHaveBeenCalledWith(
      'credential-api',
      {
        name: 'OpenAI renamed',
        type: 'apiKey',
        apiKey: MASKED_PROVIDER_SECRET,
      },
      {
        id: 'credential-api',
        name: 'OpenAI',
        type: 'apiKey',
        apiKey: MASKED_PROVIDER_SECRET,
      },
    )
  })

  it('creates a credential and deletes an unused credential', async () => {
    component = mount(ProviderCredentialList, { target })
    await tick()

    button(language.modelProfiles.createApiCredential).click()
    await tick()
    const secret = target.querySelector<HTMLInputElement>('[data-provider-credential-editor] input[type="password"]')
    if (!secret) throw new Error('Credential secret input not found')
    secret.value = 'new-secret'
    secret.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    await tick()

    button(language.modelProfiles.save).click()
    await flushAsync()
    expect(mutationSpies.createProviderCredentialDurably).toHaveBeenCalledWith({
      name: language.modelProfiles.newApiCredentialName,
      type: 'apiKey',
      apiKey: 'new-secret',
    })

    getDatabase().modelProfiles = []
    await tick()
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    await openActions()
    button(language.modelProfiles.delete).click()
    await flushAsync()

    expect(confirm).toHaveBeenCalledWith(language.modelProfiles.deleteCredentialConfirm('OpenAI'))
    expect(mutationSpies.deleteProviderCredentialDurably).toHaveBeenCalledWith('credential-api')
  })
})
