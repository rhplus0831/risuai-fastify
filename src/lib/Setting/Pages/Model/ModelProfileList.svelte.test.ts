import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commandSpies = vi.hoisted(() => ({
  createModelProfileDurably: vi.fn(),
  updateModelProfileDurably: vi.fn(),
  duplicateModelProfileDurably: vi.fn(),
  deleteModelProfileDurably: vi.fn(),
  reorderModelProfilesDurably: vi.fn(),
  updateModelRuntimeDefaultsDurably: vi.fn(),
}))

const sortableSpies = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  option: vi.fn(),
}))

vi.mock('sortablejs', () => ({
  default: { create: sortableSpies.create },
}))

vi.mock('src/ts/server/commands', () => ({
  subscribeServerCommandLocalEffectApplied: vi.fn(() => () => {}),
}))
vi.mock('src/ts/model/modelProfileMutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/ts/model/modelProfileMutations')>()),
  createModelProfileDurably: commandSpies.createModelProfileDurably,
  updateModelProfileDurably: commandSpies.updateModelProfileDurably,
  duplicateModelProfileDurably: commandSpies.duplicateModelProfileDurably,
  deleteModelProfileDurably: commandSpies.deleteModelProfileDurably,
  reorderModelProfilesDurably: commandSpies.reorderModelProfilesDurably,
  updateModelRuntimeDefaultsDurably: commandSpies.updateModelRuntimeDefaultsDurably,
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

import ModelProfileList from './ModelProfileList.svelte'
import { language } from 'src/lang'
import { resolveModelProfile } from 'src/ts/model/modelProfileResolver'
import { finishPendingModelMutation, getPendingModelMutations } from 'src/ts/model/modelProfileMutations'
import { MASKED_PROVIDER_SECRET } from 'src/ts/providerSecretMask'
import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
import { setDatabaseLite, type Database } from 'src/ts/storage/database.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function buttonByText(label: string): HTMLButtonElement {
  const button = buttonsByText(label)[0]
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`)
  return button
}

function buttonsByText(label: string): HTMLButtonElement[] {
  return Array.from(target.querySelectorAll('button')).filter(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement && !!candidate.textContent?.includes(label),
  )
}

function profileEditTrigger(): HTMLButtonElement {
  const trigger = target.querySelector<HTMLButtonElement>('[data-model-profile-row] > button')
  if (!trigger) throw new Error('Model edit trigger not found')
  return trigger
}

function profileActionsTrigger(): HTMLButtonElement {
  const trigger = target.querySelector<HTMLButtonElement>('[data-model-profile-row] button[aria-expanded]')
  if (!trigger) throw new Error('Model actions trigger not found')
  return trigger
}

async function clickProfileAction(label: string): Promise<void> {
  profileActionsTrigger().click()
  await tick()
  buttonByText(label).click()
}

function runtimeNumberInput(label: string): HTMLInputElement {
  const input = Array.from(target.querySelectorAll<HTMLLabelElement>('label'))
    .find((candidate) => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement>('input[type="number"]')
  if (!input) throw new Error(`Runtime number input not found: ${label}`)
  return input
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function modelProfileSortableOptions(): Record<string, any> {
  const options = sortableSpies.create.mock.calls.at(-1)?.[1]
  if (!options) throw new Error('Model profile Sortable options not found')
  return options
}

function clearPendingModelMutations(): void {
  for (const lane of ['model-profiles', 'model-runtime-defaults'] as const) {
    for (const pending of getPendingModelMutations(lane)) finishPendingModelMutation(pending.token)
  }
}

beforeEach(() => {
  clearPendingModelMutations()
  target = document.createElement('div')
  document.body.appendChild(target)
  setDatabaseLite({
    modelProfiles: [
      {
        id: 'profile-1',
        name: 'Profile 1',
        providerId: 'debug-echo',
        modelId: 'debug-echo',
      },
    ],
    providerCredentials: [{ id: 'credential-api', name: 'OpenAI', type: 'apiKey', apiKey: 'secret-key' }],
    modelRoleProfiles: {},
    modelRuntimeDefaults: {},
  } as any)
  for (const spy of Object.values(commandSpies)) {
    spy.mockReset()
    spy.mockResolvedValue({ status: 'accepted', result: { status: 'ok' } })
  }
  sortableSpies.create.mockReset()
  sortableSpies.destroy.mockReset()
  sortableSpies.option.mockReset()
  sortableSpies.create.mockReturnValue({
    destroy: sortableSpies.destroy,
    option: sortableSpies.option,
  })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  clearPendingModelMutations()
  setDatabaseLite({} as any)
  vi.restoreAllMocks()
})

describe('ModelProfileList', () => {
  it('opens the model editor from its named edit control', async () => {
    component = mount(ModelProfileList, { target })
    await tick()

    expect(target.querySelector('[role="dialog"]')).toBeNull()
    profileEditTrigger().click()
    await tick()

    const dialog = target.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('input')?.value).toBe('Profile 1')
    expect(commandSpies.updateModelProfileDurably).not.toHaveBeenCalled()
  })

  it('discloses secondary actions and returns keyboard focus after Escape', async () => {
    component = mount(ModelProfileList, { target })
    await tick()
    expect(buttonsByText(language.modelProfiles.delete)).toHaveLength(0)
    expect(buttonsByText(language.modelProfiles.duplicate)).toHaveLength(0)
    const actions = profileActionsTrigger()
    actions.focus()
    actions.click()
    await flushAsync()
    const duplicate = buttonByText(language.modelProfiles.duplicate)
    expect(actions.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(duplicate)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    duplicate.dispatchEvent(escape)
    await tick()
    expect(escape.defaultPrevented).toBe(true)
    expect(actions.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(actions)
    expect(buttonsByText(language.modelProfiles.delete)).toHaveLength(0)
  })

  it.each([
    ['a missing stable ID', [{ name: 'Missing ID', providerId: 'debug-echo', modelId: 'debug-echo' }]],
    [
      'duplicate stable IDs',
      [
        { id: 'duplicate-profile', name: 'First', providerId: 'debug-echo', modelId: 'debug-echo' },
        { id: 'duplicate-profile', name: 'Second', providerId: 'debug-echo', modelId: 'debug-echo' },
      ],
    ],
  ])('fails closed when the canonical profile owner contains %s', async (_case, profiles) => {
    settingsResourceState.value.modelProfiles = profiles as never
    settingsResourceState.value.modelProfileOrder = []

    component = mount(ModelProfileList, { target })
    await tick()

    expect(target.querySelectorAll('[data-model-profile-row]')).toHaveLength(0)
    expect(target.textContent).toContain(language.modelProfiles.noProfiles)
    expect(buttonsByText(language.modelProfiles.createProfile)[0]?.disabled).toBe(true)
  })

  it('keeps a configured profile quiet while retaining actionable errors', async () => {
    getDatabase().providerCredentials = [
      {
        id: 'credential-api',
        name: 'OpenAI',
        type: 'apiKey',
        apiKey: MASKED_PROVIDER_SECRET,
      },
    ]
    getDatabase().modelProfiles = [
      {
        id: 'profile-openai',
        name: 'OpenAI Profile',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { credentialId: 'credential-api' },
      },
    ]

    component = mount(ModelProfileList, { target })
    await tick()

    const row = target.querySelector<HTMLElement>('[data-model-profile-row]')
    expect(row?.textContent).not.toContain(language.modelProfiles.statusBuckets.ready)
    expect(row?.textContent).not.toContain(language.modelProfiles.statusReasons['credential-missing'])
    expect(row?.textContent).not.toContain(language.modelProfiles.statusReasons['api-key-missing'])
  })

  it('hides internal profile IDs and removes Used By from rows and the editor', async () => {
    getDatabase().modelProfiles = [
      { id: 'mp_1234567890', name: 'Generated', providerId: 'debug-echo', modelId: 'debug-echo' },
      { id: 'custom-profile', name: 'Custom', providerId: 'debug-echo', modelId: 'debug-echo' },
    ]
    component = mount(ModelProfileList, { target })
    await tick()

    expect(target.textContent).not.toContain('mp_1234567890')
    expect(target.textContent).not.toContain('custom-profile')
    expect(target.textContent).not.toContain(language.modelProfiles.usedByColumn)

    profileEditTrigger()?.click()
    await tick()

    expect(target.querySelector('[role="dialog"]')?.textContent).not.toContain(language.modelProfiles.usedByColumn)
  })

  it('uses immediate fallback sorting on every pointer type and reorders profiles by stable ID', async () => {
    getDatabase().modelProfiles = [
      { id: 'profile-a', name: 'A', providerId: 'debug-echo', modelId: 'debug-echo' },
      { id: 'profile-b', name: 'B', providerId: 'debug-echo', modelId: 'debug-echo' },
      { id: 'profile-c', name: 'C', providerId: 'debug-echo', modelId: 'debug-echo' },
    ]
    component = mount(ModelProfileList, { target })
    await tick()

    const rows = target.querySelectorAll<HTMLElement>('[data-model-profile-row]')
    const list = target.querySelector<HTMLElement>('[role="list"]')
    if (!rows[0] || !rows[1] || !list) throw new Error('Profile sort targets not found')
    const options = modelProfileSortableOptions()
    expect(options).toMatchObject({
      delay: 0,
      delayOnTouchOnly: false,
      forceFallback: true,
      draggable: '[data-model-profile-sortable-item]',
      handle: '[data-model-profile-drag-handle]',
    })
    expect(rows[0].hasAttribute('draggable')).toBe(false)
    expect(rows[0].querySelector('[data-model-profile-drag-handle]')).toBeTruthy()

    const draggedRow = rows[1]
    getDatabase().modelProfileOrder = [
      { kind: 'profile', profileId: 'profile-b' },
      { kind: 'profile', profileId: 'profile-c' },
      { kind: 'profile', profileId: 'profile-a' },
    ]
    await tick()
    list.append(draggedRow)
    options.onEnd({ from: list, item: draggedRow, oldDraggableIndex: 1, newDraggableIndex: 2 })
    await flushAsync()

    expect(commandSpies.reorderModelProfilesDurably).toHaveBeenCalledWith([
      { kind: 'profile', profileId: 'profile-c' },
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ])
    expect(draggedRow.previousElementSibling?.getAttribute('data-model-profile-drop-key')).toBe('profile:profile-b')
  })

  it('renders, reorders, and confirms deletion of a divider', async () => {
    getDatabase().modelProfiles = [
      { id: 'profile-a', name: 'A', providerId: 'debug-echo', modelId: 'debug-echo' },
      { id: 'profile-b', name: 'B', providerId: 'debug-echo', modelId: 'debug-echo' },
    ]
    getDatabase().modelProfileOrder = [
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ]
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    component = mount(ModelProfileList, { target })
    await tick()

    const divider = target.querySelector<HTMLElement>('[data-model-profile-divider-row]')
    const list = target.querySelector<HTMLElement>('[role="list"]')
    if (!divider || !list) throw new Error('Divider sort targets not found')
    expect(divider.textContent).toContain('---')
    expect(divider.querySelector('button')?.hasAttribute('data-model-profile-drag-handle')).toBe(false)
    expect(divider.querySelector('[data-model-profile-drag-handle]')).toBeTruthy()

    list.append(divider)
    modelProfileSortableOptions().onEnd({
      from: list,
      item: divider,
      oldDraggableIndex: 1,
      newDraggableIndex: 2,
    })
    await flushAsync()
    expect(commandSpies.reorderModelProfilesDurably).toHaveBeenCalledWith([
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'profile', profileId: 'profile-b' },
      { kind: 'divider', id: 'divider-a' },
    ])

    commandSpies.reorderModelProfilesDurably.mockClear()
    divider.querySelector('button')?.click()
    expect(confirm).toHaveBeenCalledWith(language.modelProfiles.deleteDividerConfirm)
    expect(commandSpies.reorderModelProfilesDurably).not.toHaveBeenCalled()

    divider.querySelector('button')?.click()
    await flushAsync()
    expect(commandSpies.reorderModelProfilesDurably).toHaveBeenCalledWith([
      { kind: 'profile', profileId: 'profile-a' },
      { kind: 'profile', profileId: 'profile-b' },
    ])
  })

  it('adds a divider at the end of the durable profile order', async () => {
    component = mount(ModelProfileList, { target })
    await tick()

    buttonByText(language.modelProfiles.addDivider).click()
    await flushAsync()

    expect(commandSpies.reorderModelProfilesDurably).toHaveBeenCalledWith([
      { kind: 'profile', profileId: 'profile-1' },
      { kind: 'divider', id: expect.stringMatching(/^mpd_/) },
    ])
  })

  it('blocks deletion when any Model Preset uses the profile', async () => {
    getDatabase().modelPresets = [
      { id: 'preset-a', name: 'Unrelated', modelRoleProfiles: {} },
      {
        id: 'preset-b',
        name: 'Uses Profile',
        modelRoleProfiles: { memory: { mode: 'profile', profileId: 'profile-1' } },
      },
    ] as any
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    component = mount(ModelProfileList, { target })
    await tick()

    await clickProfileAction(language.modelProfiles.delete)
    await flushAsync()

    expect(target.textContent).toContain(language.modelProfiles.profileUsedByModelPresets('Profile 1', 'Uses Profile'))
    expect(confirm).not.toHaveBeenCalled()
    expect(commandSpies.deleteModelProfileDurably).not.toHaveBeenCalled()
  })

  it('keeps custom API capability labels readable in the responsive drawer grid', async () => {
    getDatabase().modelProfiles[0] = {
      id: 'profile-1',
      name: 'Custom API profile',
      providerId: 'custom-api',
      modelId: 'custom-api',
      providerOptions: { customApi: { flags: [] } },
    } as any
    component = mount(ModelProfileList, { target })
    await tick()

    const editTrigger = profileEditTrigger()
    if (!editTrigger) throw new Error('Profile edit button not found')
    editTrigger.click()
    await tick()

    buttonByText(language.modelProfiles.runtimeOverridesTitle).click()
    await tick()

    const flags = target.querySelector<HTMLElement>('[data-model-custom-api-flags]')
    const labels = Array.from(flags?.querySelectorAll('label span') ?? [])
    expect(flags).toBeTruthy()
    expect(flags?.classList.contains('grid-cols-1')).toBe(true)
    expect(flags?.classList.contains('sm:grid-cols-2')).toBe(true)
    expect(labels.length).toBeGreaterThan(10)
    expect(labels.every((label) => label.classList.contains('break-all'))).toBe(true)
  })

  it('does not dispatch an unchanged profile save', async () => {
    component = mount(ModelProfileList, { target })
    await tick()

    const profileEditButton = profileEditTrigger()
    if (!profileEditButton) throw new Error('Profile edit button not found')
    profileEditButton.click()
    await tick()

    const save = buttonByText(language.modelProfiles.save)
    expect(save.disabled).toBe(true)
    save.click()
    await flushAsync()

    expect(commandSpies.updateModelProfileDurably).not.toHaveBeenCalled()
  })

  it('persists decimal profile temperature on the x100 scale and resolves it as the entered decimal', async () => {
    getDatabase().modelProfiles = [
      {
        id: 'profile-1',
        name: 'Profile 1',
        providerId: 'debug-echo',
        modelId: 'debug-echo',
        runtimeOptions: { temperature: 50 },
      },
    ]
    component = mount(ModelProfileList, { target })
    await tick()

    const profileEditButton = profileEditTrigger()
    if (!profileEditButton) throw new Error('Profile edit button not found')
    profileEditButton.click()
    await tick()
    buttonByText(language.modelProfiles.runtimeOverridesTitle).click()
    await tick()

    const temperature = runtimeNumberInput(language.modelProfiles.runtimeFields.temperature)
    expect(temperature.value).toBe('0.5')
    temperature.value = '0.7'
    temperature.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    buttonByText(language.modelProfiles.save).click()
    await flushAsync()

    const submitted = commandSpies.updateModelProfileDurably.mock.calls[0][1]
    expect(submitted.runtimeOptions?.temperature).toBe(70)

    const database = {
      ...getDatabase(),
      modelProfiles: [submitted],
      modelRoleProfiles: {
        chatMain: { mode: 'profile', profileId: 'profile-1' },
      },
    } as Database
    expect(resolveModelProfile({ database, role: 'chatMain' }).runtimeOptions.temperature).toBe(0.7)
  })

  it.each(['custom-api', 'anthropic'] as const)(
    'does not carry an OpenAI credential when the provider changes to %s',
    async (nextProviderId) => {
      getDatabase().modelProfiles[0] = {
        id: 'profile-1',
        name: 'OpenAI profile',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { credentialId: 'credential-api' },
      }
      component = mount(ModelProfileList, { target })
      await tick()

      const profileEditButton = profileEditTrigger()
      if (!profileEditButton) throw new Error('Profile edit button not found')
      profileEditButton.click()
      await tick()

      const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
      const providerSelect = dialog?.querySelector<HTMLSelectElement>('select')
      const credentialSelect = dialog?.querySelector<HTMLSelectElement>('[data-provider-credential-picker] select')
      expect(providerSelect).toBeTruthy()
      expect(credentialSelect?.value).toBe('credential-api')

      providerSelect!.value = nextProviderId
      providerSelect!.dispatchEvent(new Event('change', { bubbles: true }))
      await tick()

      expect(dialog?.querySelector<HTMLSelectElement>('[data-provider-credential-picker] select')?.value).toBe('')
      expect(dialog?.querySelector('[data-model-profile-provider-secret-reset]')?.textContent).toContain(
        language.modelProfiles.providerChangeClearedCredential,
      )

      buttonByText(language.modelProfiles.save).click()
      await flushAsync()

      expect(commandSpies.updateModelProfileDurably).toHaveBeenCalledOnce()
      const submitted = commandSpies.updateModelProfileDurably.mock.calls[0][1]
      expect(submitted.providerId).toBe(nextProviderId)
      expect(submitted.providerOptions?.credentialId).toBeUndefined()
      expect(JSON.stringify(submitted)).not.toContain('__RISU_SECRET_MASKED__')
    },
  )

  it('sends the frozen profile baseline and keeps a conflicting draft after an authoritative refresh', async () => {
    getDatabase().modelProfiles = [
      {
        id: 'profile-1',
        name: 'Profile 1',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { requestModel: 'wire-v1' },
        runtimeOptions: { temperature: 50 },
      },
    ]
    commandSpies.updateModelProfileDurably.mockResolvedValue({
      status: 'failed',
      result: { status: 'conflict', currentRevision: 124 },
    })

    component = mount(ModelProfileList, { target })
    await tick()

    const profileEditButton = profileEditTrigger()
    if (!profileEditButton) throw new Error('Profile edit button not found')
    profileEditButton.click()
    await tick()

    const nameInput = target.querySelector<HTMLInputElement>('input')
    if (!nameInput) throw new Error('Profile name input not found')
    nameInput.value = 'Locally renamed'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    getDatabase().modelProfiles = [
      {
        id: 'profile-1',
        name: 'Profile 1',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { requestModel: 'wire-v2' },
        runtimeOptions: { temperature: 70 },
      },
    ]
    await tick()

    buttonByText(language.modelProfiles.save).click()
    await flushAsync()

    expect(commandSpies.updateModelProfileDurably).toHaveBeenCalledWith(
      'profile-1',
      {
        id: 'profile-1',
        name: 'Locally renamed',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { requestModel: 'wire-v1' },
        runtimeOptions: { temperature: 50 },
      },
      {
        id: 'profile-1',
        name: 'Profile 1',
        providerId: 'openai',
        modelId: 'gpt-5',
        providerOptions: { requestModel: 'wire-v1' },
        runtimeOptions: { temperature: 50 },
      },
    )
    expect(target.querySelector('[role="dialog"]')).not.toBeNull()
    expect(nameInput.value).toBe('Locally renamed')
    expect(target.textContent).toContain(language.modelProfiles.commandConflict)
  })

  it('does not create a replacement when an edited profile disappears before save', async () => {
    component = mount(ModelProfileList, { target })
    await tick()

    const profileEditButton = profileEditTrigger()
    if (!profileEditButton) throw new Error('Profile edit button not found')
    profileEditButton.click()
    await tick()

    const nameInput = target.querySelector<HTMLInputElement>('input')
    if (!nameInput) throw new Error('Profile name input not found')
    nameInput.value = 'Edited profile'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    getDatabase().modelProfiles = []
    await tick()

    buttonByText(language.modelProfiles.save).click()
    await flushAsync()

    expect(commandSpies.createModelProfileDurably).not.toHaveBeenCalled()
    expect(commandSpies.updateModelProfileDurably).not.toHaveBeenCalled()
    expect(target.textContent).toContain(language.modelProfiles.editTargetMissing)
    expect(target.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('locks profile fields and dismissal paths until a deferred save failure settles', async () => {
    const pending = deferred<{ status: 'failed'; result: { status: 'error'; error: string } }>()
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    commandSpies.updateModelProfileDurably.mockReturnValueOnce(pending.promise)

    component = mount(ModelProfileList, { target })
    await tick()

    const profileEditButton = profileEditTrigger()
    if (!profileEditButton) throw new Error('Profile edit button not found')
    profileEditButton.click()
    await tick()

    const nameInput = target.querySelector<HTMLInputElement>('input')
    if (!nameInput) throw new Error('Profile name input not found')
    nameInput.value = 'Pending profile name'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    buttonByText(language.modelProfiles.save).click()
    await flushAsync()

    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    const backdrop = dialog?.parentElement
    const form = dialog?.querySelector<HTMLFieldSetElement>('[data-model-profile-editable-form]')
    const close = dialog?.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    const providerSelect = dialog?.querySelector<HTMLSelectElement>('select')
    const cancel = buttonByText(language.modelProfiles.cancel)
    if (!dialog || !backdrop || !form || !close || !providerSelect) throw new Error('Busy profile editor not found')

    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(form.disabled).toBe(true)
    expect(nameInput.closest('fieldset[disabled]')).toBe(form)
    expect(providerSelect.closest('fieldset[disabled]')).toBe(form)
    expect(close.disabled).toBe(true)
    expect(cancel.disabled).toBe(true)

    backdrop.click()
    close.click()
    cancel.click()
    const escape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    dialog.dispatchEvent(escape)
    await tick()

    expect(escape.defaultPrevented).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(target.querySelector('[role="dialog"]')).toBe(dialog)

    pending.resolve({ status: 'failed', result: { status: 'error', error: 'Profile save failed' } })
    await flushAsync()

    expect(dialog.getAttribute('aria-busy')).toBe('false')
    expect(form.getAttribute('aria-busy')).toBe('false')
    expect(form.disabled).toBe(false)
    expect(nameInput.closest('fieldset[disabled]')).toBeNull()
    expect(providerSelect.closest('fieldset[disabled]')).toBeNull()
    expect(close.disabled).toBe(false)
    expect(cancel.disabled).toBe(false)
    expect(target.textContent).toContain('Profile save failed')

    nameInput.value = 'Editable after failure'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(nameInput.value).toBe('Editable after failure')

    close.click()
    await tick()
    expect(confirm).toHaveBeenCalledWith(language.modelProfiles.discardProfileChangesConfirm)
    expect(target.querySelector('[role="dialog"]')).toBeNull()
  })

  it('duplicates profiles while naturally preserving credential references', async () => {
    component = mount(ModelProfileList, { target })
    await tick()

    await clickProfileAction(language.modelProfiles.duplicate)
    await flushAsync()

    expect(commandSpies.duplicateModelProfileDurably).toHaveBeenCalledWith(
      'profile-1',
      language.modelProfiles.copyName('Profile 1'),
    )
  })

  it('releases profile controls when the mutation helper rejects unexpectedly', async () => {
    commandSpies.duplicateModelProfileDurably.mockRejectedValueOnce(new Error('staging rejected'))
    component = mount(ModelProfileList, { target })
    await tick()

    await clickProfileAction(language.modelProfiles.duplicate)
    await flushAsync()

    expect(target.textContent).toContain(language.modelProfiles.commandUnavailable)
    expect(profileActionsTrigger().disabled).toBe(false)
    expect(buttonByText(language.modelProfiles.createProfile).disabled).toBe(false)
    expect(getPendingModelMutations('model-profiles')).toEqual([])
  })

  it('latches a queued profile mutation and prevents duplicate submits', async () => {
    commandSpies.duplicateModelProfileDurably.mockResolvedValue({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'queued-duplicate',
    })
    component = mount(ModelProfileList, { target })
    await tick()

    const duplicate = profileActionsTrigger()
    await clickProfileAction(language.modelProfiles.duplicate)
    await flushAsync()

    expect(target.querySelector('[data-model-profile-command-notice]')).toBeNull()
    expect(duplicate.disabled).toBe(true)
    expect(buttonByText(language.modelProfiles.createProfile).disabled).toBe(true)
    duplicate.click()
    await flushAsync()
    expect(commandSpies.duplicateModelProfileDurably).toHaveBeenCalledTimes(1)

    getDatabase().modelProfiles = [
      ...getDatabase().modelProfiles,
      {
        id: 'unrelated-copy',
        name: language.modelProfiles.copyName('Profile 1'),
        providerId: 'debug-echo',
        modelId: 'different-model',
      },
    ]
    await flushAsync()
    expect(duplicate.disabled).toBe(true)
    expect(target.querySelector('[data-model-profile-command-notice]')).toBeNull()

    getDatabase().modelProfiles = [
      ...getDatabase().modelProfiles,
      {
        ...JSON.parse(JSON.stringify(getDatabase().modelProfiles[0])),
        id: 'profile-copy',
        name: language.modelProfiles.copyName('Profile 1'),
      },
    ]
    await flushAsync()
    expect(target.querySelector('[data-model-profile-command-notice]')).toBeNull()
    expect(duplicate.disabled).toBe(false)
  })

  it('keeps a queued generated-ID duplicate fenced across a component remount', async () => {
    commandSpies.duplicateModelProfileDurably.mockResolvedValue({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'queued-duplicate-remount',
    })
    component = mount(ModelProfileList, { target })
    await tick()

    await clickProfileAction(language.modelProfiles.duplicate)
    await flushAsync()
    unmount(component)
    component = undefined
    target.replaceChildren()

    component = mount(ModelProfileList, { target })
    await tick()
    const duplicate = profileActionsTrigger()
    expect(duplicate.disabled).toBe(true)
    duplicate.click()
    await flushAsync()
    expect(commandSpies.duplicateModelProfileDurably).toHaveBeenCalledTimes(1)

    getDatabase().modelProfiles = [
      ...getDatabase().modelProfiles,
      {
        ...JSON.parse(JSON.stringify(getDatabase().modelProfiles[0])),
        id: 'profile-copy-after-remount',
        name: language.modelProfiles.copyName('Profile 1'),
      },
    ]
    await flushAsync()
    expect(profileActionsTrigger().disabled).toBe(false)
  })

  it('keeps a dirty profile draft when Escape dismissal is rejected', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    component = mount(ModelProfileList, { target })
    await tick()

    const profileEditButton = profileEditTrigger()
    if (!profileEditButton) throw new Error('Profile edit button not found')
    profileEditButton.click()
    await tick()

    const nameInput = target.querySelector<HTMLInputElement>('input')
    const providerSelect = target.querySelector<HTMLSelectElement>('select')
    if (!nameInput || !providerSelect) throw new Error('Profile editor fields not found')
    nameInput.value = 'Unsaved profile name'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    providerSelect.focus()
    const rejectedEscape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    })
    providerSelect.dispatchEvent(rejectedEscape)
    await tick()

    expect(rejectedEscape.defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledWith(language.modelProfiles.discardProfileChangesConfirm)
    expect(target.querySelector('[role="dialog"]')).not.toBeNull()
    expect(nameInput.value).toBe('Unsaved profile name')

    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    if (!dialog) throw new Error('Profile editor dialog not found')
    const dialogEscape = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Escape',
    })
    dialog.dispatchEvent(dialogEscape)
    await tick()

    expect(dialogEscape.defaultPrevented).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(target.querySelector('[role="dialog"]')).not.toBeNull()

    confirm.mockReturnValue(true)
    providerSelect.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
      }),
    )
    await tick()

    expect(target.querySelector('[role="dialog"]')).toBeNull()
  })

  it('contains focus in the drawer and restores the edit trigger after Escape', async () => {
    component = mount(ModelProfileList, { target })
    await tick()

    const editTrigger = profileEditTrigger()
    if (!editTrigger) throw new Error('Profile edit button not found')
    editTrigger.focus()
    editTrigger.click()
    await flushAsync()

    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    const backdrop = dialog?.parentElement
    const initialFocus = dialog?.querySelector<HTMLElement>('[data-modal-initial-focus]')
    if (!dialog || !backdrop || !initialFocus) throw new Error('Profile editor modal not found')
    expect(backdrop.hasAttribute('data-modal-root')).toBe(true)
    expect(backdrop.hasAttribute('role')).toBe(false)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(initialFocus)

    let backgroundBranch: HTMLElement = editTrigger
    while (backgroundBranch.parentElement && backgroundBranch.parentElement !== backdrop.parentElement) {
      backgroundBranch = backgroundBranch.parentElement
    }
    expect(backgroundBranch.inert).toBe(true)

    editTrigger.focus()
    expect(document.activeElement).toBe(initialFocus)

    const escape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    initialFocus.dispatchEvent(escape)
    await flushAsync()

    expect(escape.defaultPrevented).toBe(true)
    expect(target.querySelector('[role="dialog"]')).toBeNull()
    expect(backgroundBranch.inert).toBe(false)
    expect(document.activeElement).toBe(editTrigger)
  })
})
