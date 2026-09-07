import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commandSpies = vi.hoisted(() => ({
  runServerCommand: vi.fn(),
  createModelPresetCommand: vi.fn(),
  updateModelPresetCommand: vi.fn(),
  deleteModelPresetCommand: vi.fn(),
  selectModelPresetCommand: vi.fn(),
  reorderModelPresetsCommand: vi.fn(),
}))

const mutationSpies = vi.hoisted(() => ({
  createModelPreset: vi.fn(),
  deleteModelPreset: vi.fn(),
  reorderModelPresets: vi.fn(),
  selectModelPreset: vi.fn(),
  updateModelPreset: vi.fn(),
}))

const alertSpies = vi.hoisted(() => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
}))

vi.mock('src/ts/server/commands', () => ({
  runServerCommand: commandSpies.runServerCommand,
  createModelPresetCommand: commandSpies.createModelPresetCommand,
  updateModelPresetCommand: commandSpies.updateModelPresetCommand,
  deleteModelPresetCommand: commandSpies.deleteModelPresetCommand,
  selectModelPresetCommand: commandSpies.selectModelPresetCommand,
  reorderModelPresetsCommand: commandSpies.reorderModelPresetsCommand,
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
vi.mock('src/ts/storage/database.svelte', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/storage/database.svelte')>()),
  ...mutationSpies,
}))
vi.mock('src/ts/alert', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/alert')>()),
  ...alertSpies,
}))

import ModelPresetList from './ModelPresetList.svelte'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import { language } from 'src/lang'
import { getDatabase } from 'src/ts/__tests__/resourceDatabaseState'
import { collectionsResourceState } from 'src/ts/server/resourceState.svelte'
import { normalizeModelRoleProfiles } from 'src/ts/model/modelProfileRecords'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await tick()
}

function buttonWithText(text: string, index = 0): HTMLButtonElement {
  const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).filter(
    (button) => button.textContent?.trim() === text,
  )
  const button = buttons[index]
  if (!button) throw new Error(`Button not found: ${text}`)
  return button
}

function presetNameInput(): HTMLInputElement {
  const input = target.querySelector<HTMLInputElement>('input[id$="-rename-name"]')
  if (!input) throw new Error('Preset name editor not found')
  return input
}

async function openActions(name = 'Model A'): Promise<HTMLButtonElement> {
  const button = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === language.modelProfiles.itemActions(name),
  )
  if (!button) throw new Error(`Preset actions not found: ${name}`)
  button.click()
  await tick()
  return button
}

async function openRename(): Promise<HTMLInputElement> {
  await openActions()
  buttonWithText(language.modelProfiles.renameModelPreset).click()
  await tick()
  return presetNameInput()
}

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  setDatabaseLite({
    modelProfiles: [],
    modelRoleProfiles: {},
    modelRuntimeDefaults: {},
    modelPresets: [
      {
        id: 'model-a',
        name: 'Model A',
        modelRoleProfiles: {},
      },
      {
        id: 'model-b',
        name: 'Model B',
        modelRoleProfiles: {},
      },
    ],
    modelPresetsId: 0,
    promptPresets: [],
    promptPresetsId: -1,
  } as any)
  for (const spy of Object.values(commandSpies)) {
    spy.mockReset()
  }
  for (const spy of Object.values(mutationSpies)) {
    spy.mockReset().mockResolvedValue({ status: 'accepted' })
  }
  alertSpies.alertError.mockReset()
  alertSpies.alertNormal.mockReset()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  setDatabaseLite({} as any)
  vi.unstubAllGlobals()
})

describe('ModelPresetList', () => {
  it('does not apply a preset when Space is pressed inside the preset name input', async () => {
    const afterApply = vi.fn()
    component = mount(ModelPresetList, { target, props: { embedded: true, afterApply } })
    await tick()

    expect(target.querySelector('table')).toBeNull()
    expect(target.querySelectorAll('[data-model-preset-select]')).toHaveLength(2)

    const nameInput = await openRename()

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    nameInput.dispatchEvent(event)
    await tick()

    expect(event.defaultPrevented).toBe(false)
    expect(afterApply).not.toHaveBeenCalled()
    expect(commandSpies.selectModelPresetCommand).not.toHaveBeenCalled()
    expect(getDatabase().modelPresetsId).toBe(0)
  })

  it.each(['rename', 'delete', 'reorder'])('surfaces a failed model-preset %s', async (action) => {
    component = mount(ModelPresetList, { target })
    await tick()

    if (action === 'rename') {
      mutationSpies.updateModelPreset.mockResolvedValueOnce({ status: 'failed' })
      const input = await openRename()
      input.value = 'Rejected rename'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      buttonWithText(language.save).click()
    } else {
      await openActions()
      if (action === 'delete') {
        mutationSpies.deleteModelPreset.mockResolvedValueOnce({ status: 'failed' })
        vi.stubGlobal(
          'confirm',
          vi.fn(() => true),
        )
        buttonWithText(language.modelProfiles.delete).click()
      } else {
        mutationSpies.reorderModelPresets.mockResolvedValueOnce({ status: 'failed' })
        buttonWithText(language.modelProfiles.moveDown).click()
      }
    }
    await settle()

    expect(target.querySelector('[data-risu-preset-mutation-status]')?.textContent).toContain(
      language.presetMutationFailed,
    )
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.presetMutationFailed)
    expect(mutationSpies.selectModelPreset).not.toHaveBeenCalled()
    if (action === 'rename') {
      expect(presetNameInput().value).toBe('Rejected rename')
      expect(presetNameInput().disabled).toBe(false)
    }
  })

  it('recovers from a rejected selection and permits a retry', async () => {
    mutationSpies.selectModelPreset.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      status: 'accepted',
    })
    const afterApply = vi.fn()
    component = mount(ModelPresetList, { target, props: { embedded: true, afterApply } })
    await tick()

    const modelB = target.querySelectorAll<HTMLElement>('[data-model-preset-select]')[1]
    if (!modelB) throw new Error('Model B preset row was not rendered')
    modelB.click()
    await settle()

    expect(modelB.getAttribute('aria-busy')).toBe('false')
    expect(target.textContent).toContain(language.presetSelectionFailed)
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.presetSelectionFailed)
    expect(afterApply).not.toHaveBeenCalled()

    modelB.click()
    await settle()

    expect(mutationSpies.selectModelPreset).toHaveBeenCalledTimes(2)
    expect(afterApply).toHaveBeenCalledTimes(1)
  })

  it('reports a queued create and a later replay discard', async () => {
    const settlement = deferred<'accepted' | 'failed'>()
    mutationSpies.createModelPreset.mockResolvedValueOnce({
      status: 'queued',
      settlement: settlement.promise,
    })
    component = mount(ModelPresetList, { target })
    await tick()

    buttonWithText(language.modelProfiles.saveCurrentRolesAsPreset).click()
    await tick()
    expect(mutationSpies.createModelPreset).not.toHaveBeenCalled()
    buttonWithText(language.save).click()
    await settle()

    expect(target.querySelector('[data-risu-preset-mutation-status]')).toBeNull()
    expect(alertSpies.alertNormal).toHaveBeenCalledWith(language.presetMutationQueued)

    settlement.resolve('failed')
    await settle()
    expect(target.querySelector('[data-risu-preset-mutation-status]')?.textContent).toContain(
      language.presetMutationFailed,
    )
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.presetMutationFailed)
  })

  it('keeps routine metadata in Details without applying the preset', async () => {
    collectionsResourceState.values.modelPresets = [
      {
        id: 'model-a',
        name: 'Model A',
        modelRoleProfiles: normalizeModelRoleProfiles(undefined),
        aiModel: 'legacy-main',
      },
    ]
    component = mount(ModelPresetList, { target })
    await tick()

    expect(target.textContent).not.toContain('model-a')
    expect(target.textContent).not.toContain(language.modelProfiles.modelPresetLegacyBadge)
    expect(target.querySelectorAll('input')).toHaveLength(0)
    expect(target.querySelector('[data-model-preset-select]')?.getAttribute('aria-pressed')).toBe('true')
    expect(target.textContent).toContain(language.modelProfiles.modelPresetSelected)

    const trigger = await openActions()
    buttonWithText(language.modelProfiles.modelPresetDetails).click()
    await tick()

    expect(target.textContent).toContain('model-a')
    expect(target.textContent).toContain(language.modelProfiles.roleBindingsColumn)
    expect(target.textContent).toContain(language.modelProfiles.modelPresetLegacyBadge)
    expect(mutationSpies.selectModelPreset).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)

    await openActions()
    buttonWithText(language.modelProfiles.modelPresetDetails).click()
    await tick()
    expect(target.textContent).not.toContain('model-a')
  })

  it('keeps missing-model warnings visible while hiding their IDs', async () => {
    collectionsResourceState.values.modelPresets = [
      {
        id: 'model-a',
        name: 'Model A',
        modelRoleProfiles: normalizeModelRoleProfiles({
          chatMain: { mode: 'profile', profileId: 'missing-profile-id' },
        }),
      },
    ]
    component = mount(ModelPresetList, { target })
    await tick()

    expect(target.textContent).toContain(language.modelProfiles.modelPresetMissingModels(1))
    expect(target.textContent).not.toContain('missing-profile-id')

    await openActions()
    buttonWithText(language.modelProfiles.modelPresetDetails).click()
    await tick()
    expect(target.textContent).toContain('missing-profile-id')
  })

  it('resolves included models when summarizing a preset', async () => {
    collectionsResourceState.values.modelPresets = [
      {
        id: 'model-a',
        name: 'Model A',
        modelRoleProfiles: normalizeModelRoleProfiles({ chatMain: { mode: 'profile', profileId: 'included-model' } }),
        modelProfiles: [
          { id: 'included-model', name: 'Included model', providerId: 'debug-echo', modelId: 'echo_model' },
        ],
      },
    ]
    component = mount(ModelPresetList, { target })
    await tick()

    expect(target.textContent).toContain('Included model')
    expect(target.textContent).toContain(language.modelProfiles.modelPresetSettingsNotice)
    expect(target.textContent).not.toContain(language.modelProfiles.modelPresetMissingModels(1))
  })

  it('retains a queued rename until acceptance and does not apply it as a selection', async () => {
    const settlement = deferred<'accepted' | 'failed'>()
    mutationSpies.updateModelPreset.mockResolvedValueOnce({ status: 'queued', settlement: settlement.promise })
    component = mount(ModelPresetList, { target })
    await tick()

    const input = await openRename()
    input.value = 'New name'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()

    expect(mutationSpies.updateModelPreset).toHaveBeenCalledWith(0, { name: 'New name' })
    expect(mutationSpies.selectModelPreset).not.toHaveBeenCalled()
    expect(presetNameInput().value).toBe('New name')
    expect(presetNameInput().disabled).toBe(true)
    expect(target.querySelector('[role="status"]')?.textContent).toContain(language.presetMutationQueued)

    settlement.resolve('accepted')
    await settle()
    expect(target.querySelector('input[id$="-rename-name"]')).toBeNull()
  })

  it('cancels a rename with Escape and restores the action trigger focus', async () => {
    component = mount(ModelPresetList, { target })
    await tick()
    const input = await openRename()
    input.value = 'Unsubmitted name'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    input.dispatchEvent(escape)
    await tick()

    expect(escape.defaultPrevented).toBe(true)
    expect(target.querySelector('input')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe(language.modelProfiles.itemActions('Model A'))
    expect(mutationSpies.updateModelPreset).not.toHaveBeenCalled()
  })
})

it('retains a model preset rename before the input blurs', async () => {
  await beginWriterDraftCaptureTest()
  try {
    component = mount(ModelPresetList, { target })
    await tick()
    const input = await openRename()
    input.value = 'Unsubmitted preset name'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts().find((draft) => draft.key.startsWith('model-preset-form:'))?.data).toMatchObject({
      renameDraft: 'Unsubmitted preset name',
    })
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
