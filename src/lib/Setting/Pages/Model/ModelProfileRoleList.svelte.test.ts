import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commandSpies = vi.hoisted(() => ({
  updateModelRoleProfilesDurably: vi.fn(),
  updateModelPresetCommand: vi.fn(),
}))
const storeMocks = vi.hoisted(() => ({
  selIdState: {
    selId: -1,
  },
}))

vi.mock('src/ts/server/commands', () => ({
  subscribeServerCommandLocalEffectApplied: vi.fn(),
  updateModelPresetCommand: commandSpies.updateModelPresetCommand,
}))
vi.mock('src/ts/model/modelProfileMutations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/ts/model/modelProfileMutations')>()),
  updateModelRoleProfilesDurably: commandSpies.updateModelRoleProfilesDurably,
}))
vi.mock('src/ts/stores.svelte', () => ({
  selIdState: storeMocks.selIdState,
}))
import ModelProfileRoleList from './ModelProfileRoleList.svelte'
import { language } from 'src/lang'
import { finishPendingModelMutation, getPendingModelMutations } from 'src/ts/model/modelProfileMutations'
import { normalizeModelRoleProfiles } from 'src/ts/model/modelProfileRecords'
import { MODEL_ROLES } from '@risuai/shared-core/model-roles'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

let target: HTMLElement
let component: MountedComponent | undefined

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function roleModeSelect(roleIndex: number): HTMLSelectElement {
  const role = MODEL_ROLES[roleIndex]
  const ariaLabel = role ? `${language.modelRoles.roles[role]}: ${language.modelProfiles.bindingModeColumn}` : undefined
  const select = Array.from(target.querySelectorAll('select')).find(
    (candidate) => candidate.getAttribute('aria-label') === ariaLabel,
  )
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Role mode select not found at index ${roleIndex}`)
  return select
}

function roleProfileSelect(roleIndex: number): HTMLSelectElement {
  const role = MODEL_ROLES[roleIndex]
  const ariaLabel = role
    ? `${language.modelRoles.roles[role]}: ${language.modelProfiles.effectiveProfileColumn}`
    : undefined
  const select = Array.from(target.querySelectorAll('select')).find(
    (candidate) => candidate.getAttribute('aria-label') === ariaLabel,
  )
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Role profile select not found at index ${roleIndex}`)
  return select
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
        modelId: 'echo_model',
      },
    ],
    modelRoleProfiles: normalizeModelRoleProfiles(undefined),
    modelPresets: [
      {
        id: 'model-a',
        name: 'Model A',
      },
      {
        id: 'model-b',
        name: 'Model B',
      },
    ],
    modelPresetsId: 0,
  } as any)
  commandSpies.updateModelRoleProfilesDurably.mockReset()
  commandSpies.updateModelRoleProfilesDurably.mockResolvedValue({ status: 'accepted', result: { status: 'ok' } })
  commandSpies.updateModelPresetCommand.mockReset()
  commandSpies.updateModelPresetCommand.mockResolvedValue({ status: 'ok' })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  clearPendingModelMutations()
  setDatabaseLite({} as any)
})

describe('ModelProfileRoleList', () => {
  it('gives each role binding and profile select a unique accessible name', async () => {
    component = mount(ModelProfileRoleList, { target })
    await tick()

    const modeSelects = Array.from(target.querySelectorAll<HTMLSelectElement>('select'))
    const modeNames = modeSelects.map((select) => select.getAttribute('aria-label'))

    expect(modeNames).toEqual(
      MODEL_ROLES.map((role) => `${language.modelRoles.roles[role]}: ${language.modelProfiles.bindingModeColumn}`),
    )

    setSelectValue(modeSelects[0], 'profile')
    await tick()

    const chatMainSelects = [roleModeSelect(0), roleProfileSelect(0)]
    expect(chatMainSelects.map((select) => select.getAttribute('aria-label'))).toEqual([
      `${language.modelRoles.roles.chatMain}: ${language.modelProfiles.bindingModeColumn}`,
      `${language.modelRoles.roles.chatMain}: ${language.modelProfiles.effectiveProfileColumn}`,
    ])
    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledWith(
      {
        chatMain: { mode: 'profile', profileId: 'profile-1' },
      },
      'model-a',
    )
  })

  it('shows dividers in profile order and immediately restores the previous role selection', async () => {
    getDatabase().modelProfiles = [
      ...getDatabase().modelProfiles,
      { id: 'profile-2', name: 'Profile 2', providerId: 'debug-echo', modelId: 'echo_model' },
    ]
    getDatabase().modelProfileOrder = [
      { kind: 'profile', profileId: 'profile-1' },
      { kind: 'divider', id: 'divider-a' },
      { kind: 'profile', profileId: 'profile-2' },
    ]
    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatMain: { mode: 'profile', profileId: 'profile-1' },
    })
    component = mount(ModelProfileRoleList, { target })
    await tick()

    const select = roleProfileSelect(0)
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['Profile 1', '---', 'Profile 2'])
    const dividerOption = select.querySelector<HTMLOptionElement>('[data-model-profile-divider="true"]')
    if (!dividerOption) throw new Error('Divider option not found')

    setSelectValue(select, dividerOption.value)
    await tick()

    expect(roleProfileSelect(0).value).toBe('profile-1')
    expect(getDatabase().modelRoleProfiles.chatMain).toEqual({ mode: 'profile', profileId: 'profile-1' })
    expect(commandSpies.updateModelRoleProfilesDurably).not.toHaveBeenCalled()
  })

  it('reports an unavailable command transport without treating it as success', async () => {
    commandSpies.updateModelRoleProfilesDurably.mockResolvedValue({
      status: 'failed',
      result: { status: 'unavailable' },
    })
    component = mount(ModelProfileRoleList, { target })
    await tick()

    const [chatMainModeSelect] = Array.from(target.querySelectorAll('select'))
    if (!(chatMainModeSelect instanceof HTMLSelectElement)) throw new Error('Chat main binding mode select not found')
    setSelectValue(chatMainModeSelect, 'profile')
    await flushAsync()

    expect(target.textContent).toContain(language.modelProfiles.commandUnavailable)
    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledTimes(1)
    expect(roleModeSelect(0).value).toBe('legacy')
  })

  it('atomically mirrors roles into the model preset selected when the binding changed', async () => {
    const roleCommand = createDeferred<{ status: 'accepted'; result: { status: 'ok' } }>()
    commandSpies.updateModelRoleProfilesDurably.mockReturnValue(roleCommand.promise)
    component = mount(ModelProfileRoleList, { target })
    await tick()

    const [chatMainModeSelect] = Array.from(target.querySelectorAll('select'))
    if (!(chatMainModeSelect instanceof HTMLSelectElement)) throw new Error('Chat main binding mode select not found')

    setSelectValue(chatMainModeSelect, 'profile')
    await tick()

    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledWith(
      {
        chatMain: { mode: 'profile', profileId: 'profile-1' },
      },
      'model-a',
    )

    getDatabase().modelPresetsId = 1
    roleCommand.resolve({ status: 'accepted', result: { status: 'ok' } })
    await flushAsync()

    expect(commandSpies.updateModelPresetCommand).not.toHaveBeenCalled()
    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledTimes(1)
  })

  it('automatically applies a selected profile change', async () => {
    getDatabase().modelProfiles = [
      ...(getDatabase().modelProfiles ?? []),
      {
        id: 'profile-2',
        name: 'Profile 2',
        providerId: 'debug-echo',
        modelId: 'echo_model',
      },
    ]
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await flushAsync()
    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatMain: { mode: 'profile', profileId: 'profile-1' },
    })
    await flushAsync()

    setSelectValue(roleProfileSelect(0), 'profile-2')
    await flushAsync()

    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenLastCalledWith(
      {
        chatMain: { mode: 'profile', profileId: 'profile-2' },
      },
      'model-a',
    )
    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledTimes(2)
  })

  it('restores a failed automatic update and retries on the next change', async () => {
    commandSpies.updateModelRoleProfilesDurably
      .mockResolvedValueOnce({
        status: 'failed',
        result: { status: 'error', error: 'save failed' },
      })
      .mockResolvedValueOnce({ status: 'accepted', result: { status: 'ok' } })
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await flushAsync()

    expect(target.textContent).toContain('save failed')
    expect(roleModeSelect(0).value).toBe('legacy')
    expect(Array.from(target.querySelectorAll('select')).every((select) => !select.disabled)).toBe(true)

    setSelectValue(roleModeSelect(0), 'profile')
    await flushAsync()

    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledTimes(2)
    expect(commandSpies.updateModelPresetCommand).not.toHaveBeenCalled()
  })

  it('prevents role edits while an automatic update is pending', async () => {
    const roleCommand = createDeferred<{ status: 'accepted'; result: { status: 'ok' } }>()
    commandSpies.updateModelRoleProfilesDurably.mockReturnValue(roleCommand.promise)
    component = mount(ModelProfileRoleList, { target })
    await tick()

    const [chatMainModeSelect] = Array.from(target.querySelectorAll('select'))
    if (!(chatMainModeSelect instanceof HTMLSelectElement)) throw new Error('Chat main binding mode select not found')

    setSelectValue(chatMainModeSelect, 'profile')
    await tick()

    expect(Array.from(target.querySelectorAll('select')).every((select) => select.disabled)).toBe(true)

    roleCommand.resolve({ status: 'accepted', result: { status: 'ok' } })
    await flushAsync()

    expect(Array.from(target.querySelectorAll('select')).every((select) => !select.disabled)).toBe(true)
  })

  it('latches a durably queued role update until its projection converges', async () => {
    commandSpies.updateModelRoleProfilesDurably.mockResolvedValue({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationId: 'queued-role-bindings',
    })
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await flushAsync()

    expect(target.querySelector('[data-model-role-command-notice]')).toBeNull()
    expect(target.querySelectorAll('button')).toHaveLength(0)
    expect(Array.from(target.querySelectorAll('select')).every((select) => select.disabled)).toBe(true)

    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledTimes(1)

    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatAux: { mode: 'profile', profileId: 'profile-1' },
    })
    await flushAsync()
    expect(target.querySelector('[data-model-role-command-notice]')).toBeNull()
    expect(Array.from(target.querySelectorAll('select')).every((select) => select.disabled)).toBe(true)

    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatMain: { mode: 'profile', profileId: 'profile-1' },
      chatAux: { mode: 'profile', profileId: 'profile-1' },
    })
    await flushAsync()
    expect(target.querySelector('[data-model-role-command-notice]')).toBeNull()
    expect(Array.from(target.querySelectorAll('select')).every((select) => !select.disabled)).toBe(true)
  })

  it('releases role controls when the mutation helper rejects unexpectedly', async () => {
    commandSpies.updateModelRoleProfilesDurably.mockRejectedValueOnce(new Error('staging rejected'))
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await flushAsync()

    expect(target.textContent).toContain(language.modelProfiles.commandUnavailable)
    expect(roleModeSelect(0).value).toBe('legacy')
    expect(Array.from(target.querySelectorAll('select')).every((select) => !select.disabled)).toBe(true)
  })

  it('rebases authoritative changes for untouched roles without discarding a dirty role', async () => {
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await tick()

    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatAux: { mode: 'profile', profileId: 'profile-1' },
    })
    await flushAsync()

    expect(roleModeSelect(0).value).toBe('profile')
    expect(roleModeSelect(1).value).toBe('profile')

    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledWith(
      {
        chatMain: { mode: 'profile', profileId: 'profile-1' },
      },
      'model-a',
    )
  })

  it('preserves a dirty role when that authoritative binding changes to a different value', async () => {
    getDatabase().modelProfiles = [
      ...(getDatabase().modelProfiles ?? []),
      {
        id: 'profile-2',
        name: 'Profile 2',
        providerId: 'debug-echo',
        modelId: 'echo_model',
      },
    ]
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await tick()

    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatMain: { mode: 'profile', profileId: 'profile-2' },
    })
    await flushAsync()

    expect(roleProfileSelect(0).value).toBe('profile-1')

    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledWith(
      {
        chatMain: { mode: 'profile', profileId: 'profile-1' },
      },
      'model-a',
    )
  })

  it('keeps the automatic binding when the authoritative projection converges', async () => {
    component = mount(ModelProfileRoleList, { target })
    await tick()

    setSelectValue(roleModeSelect(0), 'profile')
    await tick()

    getDatabase().modelRoleProfiles = normalizeModelRoleProfiles({
      chatMain: { mode: 'profile', profileId: 'profile-1' },
    })
    await flushAsync()

    expect(roleModeSelect(0).value).toBe('profile')
    expect(commandSpies.updateModelRoleProfilesDurably).toHaveBeenCalledTimes(1)
  })
})
