import { demoteClientSession } from 'src/ts/clientSession'
import {
  beginWriterDraftCaptureTest,
  endWriterDraftCaptureTest,
  capturedWriterDrafts,
} from 'src/ts/__tests__/writerDraftCapture'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loadoutStore = vi.hoisted(() => ({ open: true }))
const loadoutDatabase = vi.hoisted(() => ({ loadouts: [] as Array<Record<string, unknown>> }))
const loadoutCollectionState = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  statuses: {} as Record<string, string>,
}))
const characterOwnerState = vi.hoisted(() => ({
  characters: [] as Array<{ chaId: string }>,
  currentChar: -1,
  status: 'idle' as string,
}))
const loadoutMocks = vi.hoisted(() => ({
  applyLoadout: vi.fn(),
  deleteLoadout: vi.fn(),
  saveCurrentLoadout: vi.fn(),
  toggleLoadoutFavorite: vi.fn(),
}))
const alertMocks = vi.hoisted(() => ({ confirm: vi.fn(), normal: vi.fn() }))

vi.mock('src/ts/stores.svelte', () => ({
  loadoutModalStore: loadoutStore,
}))
vi.mock('src/ts/server/resourceState.svelte', () => ({
  collectionsResourceState: loadoutCollectionState,
  charactersResourceState: characterOwnerState,
  getCharacterResourceOwner: (characterId: string) => {
    const matches = characterOwnerState.characters.filter((character) => character.chaId === characterId)
    return matches.length === 1 ? matches[0] : undefined
  },
}))
vi.mock('src/ts/loadout', () => loadoutMocks)
vi.mock('src/ts/storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(() => null),
}))
vi.mock('src/ts/alert', () => ({ alertConfirm: alertMocks.confirm, alertNormal: alertMocks.normal }))

import LoadoutModal from './LoadoutModal.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let opener: HTMLButtonElement
let target: HTMLElement

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
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

function seedLoadoutOwners(loadouts: Array<Record<string, unknown>>): void {
  loadoutDatabase.loadouts = loadouts
  loadoutCollectionState.values = { loadouts }
  loadoutCollectionState.statuses = { loadouts: 'ready' }
}

beforeEach(() => {
  loadoutStore.open = true
  seedLoadoutOwners([])
  characterOwnerState.characters = []
  characterOwnerState.currentChar = -1
  characterOwnerState.status = 'idle'
  loadoutMocks.applyLoadout.mockReset().mockResolvedValue('applied')
  loadoutMocks.deleteLoadout.mockReset().mockResolvedValue('accepted')
  loadoutMocks.saveCurrentLoadout
    .mockReset()
    .mockResolvedValue({ status: 'accepted', loadout: { id: 'saved-loadout' } })
  loadoutMocks.toggleLoadoutFavorite.mockReset().mockResolvedValue('accepted')
  alertMocks.confirm.mockReset().mockResolvedValue(true)
  alertMocks.normal.mockReset()
  opener = document.createElement('button')
  opener.textContent = 'Open loadouts'
  target = document.createElement('div')
  document.body.append(opener, target)
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  opener.remove()
  target.remove()
  document.body.innerHTML = ''
})

describe('LoadoutModal focus', () => {
  it('contains focus, closes on owned Escape, and restores the opener', async () => {
    opener.focus()
    component = mount(LoadoutModal, { target })
    await settle()

    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    const backdrop = dialog?.parentElement
    const close = dialog?.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    if (!dialog || !backdrop || !close) throw new Error('Loadout modal not found')
    expect(backdrop.hasAttribute('data-modal-root')).toBe(true)
    expect(dialog.getAttribute('aria-labelledby')).toBe('risu-loadout-modal-title')
    expect(opener.inert).toBe(true)
    expect(document.activeElement).toBe(close)

    opener.focus()
    expect(document.activeElement).toBe(close)

    const escape = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' })
    close.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(loadoutStore.open).toBe(false)

    unmount(component)
    component = undefined
    await settle()
    expect(opener.inert).toBe(false)
    expect(document.activeElement).toBe(opener)
  })
})

describe('LoadoutModal operations', () => {
  const savedLoadout = {
    id: 'loadout-a',
    name: 'Loadout A',
    lastUsed: 100,
    favorite: false,
    characterIds: [],
    modules: [],
    globalVariables: {},
    presetName: 'Preset A',
    personaId: '',
  }

  it('exposes each apply scope state to assistive technology', async () => {
    component = mount(LoadoutModal, { target })
    await settle()

    const modules = target.querySelector<HTMLButtonElement>('[data-risu-loadout-option="modules"]')
    if (!modules) throw new Error('Loadout modules option not found')
    expect(modules.getAttribute('aria-pressed')).toBe('true')

    modules.click()
    await tick()

    expect(modules.getAttribute('aria-pressed')).toBe('false')
  })

  it('stays locked and open until a full apply is accepted, then closes', async () => {
    seedLoadoutOwners([savedLoadout])
    const application = deferred<'applied'>()
    loadoutMocks.applyLoadout.mockReturnValue(application.promise)
    component = mount(LoadoutModal, { target })
    await settle()

    const apply = target.querySelector<HTMLButtonElement>(
      '[data-risu-loadout-action="apply"][data-risu-loadout-id="loadout-a"]',
    )
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    const close = target.querySelector<HTMLButtonElement>('[data-modal-initial-focus]')
    if (!apply || !dialog || !close) throw new Error('Loadout apply controls not found')

    apply.click()
    await settle()

    expect(loadoutStore.open).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(apply.disabled).toBe(true)
    expect(close.disabled).toBe(true)

    application.resolve('applied')
    await settle()

    expect(loadoutStore.open).toBe(false)
    expect(dialog.getAttribute('aria-busy')).toBe('false')
  })

  it('stays open and reports a failed apply after command settlement', async () => {
    seedLoadoutOwners([savedLoadout])
    const application = deferred<'persistence-failed'>()
    loadoutMocks.applyLoadout.mockReturnValue(application.promise)
    component = mount(LoadoutModal, { target })
    await settle()

    const apply = target.querySelector<HTMLButtonElement>(
      '[data-risu-loadout-action="apply"][data-risu-loadout-id="loadout-a"]',
    )
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    if (!apply || !dialog) throw new Error('Loadout apply control not found')

    apply.click()
    await settle()
    application.resolve('persistence-failed')
    await settle()

    expect(loadoutStore.open).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('false')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Could not apply this loadout')
  })

  it('closes with a no-retry notice when durable loadout work is queued locally', async () => {
    seedLoadoutOwners([savedLoadout])
    loadoutMocks.applyLoadout.mockResolvedValue('queued')
    component = mount(LoadoutModal, { target })
    await settle()

    const apply = target.querySelector<HTMLButtonElement>(
      '[data-risu-loadout-action="apply"][data-risu-loadout-id="loadout-a"]',
    )
    if (!apply) throw new Error('Loadout apply control not found')

    apply.click()
    await settle()

    expect(loadoutStore.open).toBe(false)
    expect(alertMocks.normal).toHaveBeenCalledWith(
      'Changes are saved locally and queued. You do not need to apply this loadout again.',
    )
  })

  it('stays open while applying and reports preset hydration failure', async () => {
    seedLoadoutOwners([savedLoadout])
    const application = deferred<'preset-hydration-failed'>()
    loadoutMocks.applyLoadout.mockReturnValue(application.promise)
    component = mount(LoadoutModal, { target })
    await settle()

    const apply = target.querySelector<HTMLButtonElement>(
      '[data-risu-loadout-action="apply"][data-risu-loadout-id="loadout-a"]',
    )
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    if (!apply || !dialog) throw new Error('Loadout apply control not found')

    apply.click()
    await tick()

    expect(loadoutStore.open).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(target.querySelector('[role="status"]')?.textContent).toContain('Loading')

    application.resolve('preset-hydration-failed')
    await settle()

    expect(loadoutStore.open).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('false')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Could not load the preset')
  })

  it('keeps the save name and lock until create is accepted, then clears it', async () => {
    const creation = deferred<{ status: 'accepted'; loadout: { id: string } }>()
    loadoutMocks.saveCurrentLoadout.mockReturnValue(creation.promise)
    component = mount(LoadoutModal, { target })
    await settle()

    const input = target.querySelector<HTMLInputElement>('input[type="text"]')
    const save = target.querySelector<HTMLButtonElement>('[data-risu-loadout-action="save"]')
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    if (!input || !save || !dialog) throw new Error('Loadout save controls not found')
    expect(input.getAttribute('aria-label')).toBe('Loadout Name')
    input.value = '  Snapshot  '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    save.click()
    save.click()
    await settle()

    expect(loadoutMocks.saveCurrentLoadout).toHaveBeenCalledOnce()
    expect(loadoutMocks.saveCurrentLoadout).toHaveBeenCalledWith('Snapshot')
    expect(input.value).toBe('  Snapshot  ')
    expect(input.disabled).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')

    creation.resolve({ status: 'accepted', loadout: { id: 'saved-loadout' } })
    await settle()

    expect(input.value).toBe('')
    expect(input.disabled).toBe(false)
    expect(dialog.getAttribute('aria-busy')).toBe('false')
  })

  it('clears the name and reports a create retained in the durable queue', async () => {
    loadoutMocks.saveCurrentLoadout.mockResolvedValue({
      status: 'queued',
      loadout: { id: 'queued-loadout' },
    })
    component = mount(LoadoutModal, { target })
    await settle()

    const input = target.querySelector<HTMLInputElement>('input[type="text"]')
    const save = target.querySelector<HTMLButtonElement>('[data-risu-loadout-action="save"]')
    if (!input || !save) throw new Error('Loadout save controls not found')
    input.value = 'Queued Snapshot'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    save.click()
    await settle()

    expect(input.value).toBe('')
    expect(alertMocks.normal).toHaveBeenCalledWith(
      'This loadout is saved locally and queued. You do not need to save it again.',
    )
    expect(target.querySelector('[role="alert"]')).toBeNull()
  })

  it('restores the save controls and retains the name when create fails', async () => {
    const creation = deferred<{ status: 'failed'; loadout: { id: string } }>()
    loadoutMocks.saveCurrentLoadout.mockReturnValue(creation.promise)
    component = mount(LoadoutModal, { target })
    await settle()

    const input = target.querySelector<HTMLInputElement>('input[type="text"]')
    const save = target.querySelector<HTMLButtonElement>('[data-risu-loadout-action="save"]')
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    if (!input || !save || !dialog) throw new Error('Loadout save controls not found')
    input.value = 'Retry Snapshot'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    save.click()
    await settle()

    expect(loadoutStore.open).toBe(true)
    expect(input.value).toBe('Retry Snapshot')
    expect(input.disabled).toBe(true)
    expect(dialog.getAttribute('aria-busy')).toBe('true')

    creation.resolve({ status: 'failed', loadout: { id: 'failed-loadout' } })
    await settle()

    expect(loadoutStore.open).toBe(true)
    expect(input.value).toBe('Retry Snapshot')
    expect(input.disabled).toBe(false)
    expect(dialog.getAttribute('aria-busy')).toBe('false')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Could not save this loadout')
  })

  it('confirms removal once and disables repeated destructive actions while the prompt is open', async () => {
    seedLoadoutOwners([savedLoadout])
    const confirmation = deferred<boolean>()
    const deletion = deferred<'accepted'>()
    alertMocks.confirm.mockReturnValue(confirmation.promise)
    loadoutMocks.deleteLoadout.mockImplementation(() => {
      seedLoadoutOwners([])
      return deletion.promise
    })
    component = mount(LoadoutModal, { target })
    await settle()
    const remove = target.querySelector<HTMLButtonElement>('[aria-label="Remove loadout"]')
    if (!remove) throw new Error('Loadout remove control not found')

    remove.click()
    await settle()
    expect(alertMocks.confirm).toHaveBeenCalledOnce()
    expect(alertMocks.confirm).toHaveBeenCalledWith('Remove the loadout “Loadout A”?')
    expect(remove.disabled).toBe(true)
    remove.click()
    expect(alertMocks.confirm).toHaveBeenCalledOnce()

    confirmation.resolve(true)
    await settle()
    expect(loadoutMocks.deleteLoadout).toHaveBeenCalledOnce()
    expect(loadoutMocks.deleteLoadout).toHaveBeenCalledWith('loadout-a')
    expect(target.querySelector('[data-risu-loadout-pending]')?.getAttribute('aria-busy')).toBe('true')
    expect(target.querySelector('[data-risu-loadout-id="loadout-a"]')).not.toBeNull()

    deletion.resolve('accepted')
    await settle()

    expect(target.querySelector('[data-risu-loadout-id="loadout-a"]')).toBeNull()
    expect(target.querySelector<HTMLElement>('[role="dialog"]')?.getAttribute('aria-busy')).toBe('false')
  })

  it('keeps a favorite mutation pending and reports a terminal failure', async () => {
    seedLoadoutOwners([savedLoadout])
    const favorite = deferred<'failed'>()
    loadoutMocks.toggleLoadoutFavorite.mockReturnValue(favorite.promise)
    component = mount(LoadoutModal, { target })
    await settle()

    const star = target.querySelector<HTMLButtonElement>('[aria-label="Add to favorites"]')
    const dialog = target.querySelector<HTMLElement>('[role="dialog"]')
    if (!star || !dialog) throw new Error('Loadout favorite controls not found')

    star.click()
    await settle()

    expect(dialog.getAttribute('aria-busy')).toBe('true')
    expect(target.querySelector('[data-risu-loadout-pending]')?.textContent).toContain('Loading')
    expect(star.disabled).toBe(true)

    favorite.resolve('failed')
    await settle()

    expect(dialog.getAttribute('aria-busy')).toBe('false')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Could not update favorites for “Loadout A”')
  })

  it('labels a retained delete as queued after settlement', async () => {
    seedLoadoutOwners([savedLoadout])
    loadoutMocks.deleteLoadout.mockImplementation(async () => {
      seedLoadoutOwners([])
      return 'queued'
    })
    component = mount(LoadoutModal, { target })
    await settle()

    const remove = target.querySelector<HTMLButtonElement>('[aria-label="Remove loadout"]')
    if (!remove) throw new Error('Loadout remove control not found')
    remove.click()
    await settle()

    expect(alertMocks.normal).toHaveBeenCalledWith('Removal of “Loadout A” is saved locally and queued.')
    expect(target.querySelector('[data-risu-loadout-id="loadout-a"]')).toBeNull()
  })

  it('renders the ready loadout collection owner instead of the compatibility facade', async () => {
    const facadeLoadout = { ...savedLoadout, id: 'facade-loadout', name: 'Facade Loadout' }
    const ownerLoadout = { ...savedLoadout, id: 'owner-loadout', name: 'Owner Loadout' }
    loadoutDatabase.loadouts = [facadeLoadout]
    loadoutCollectionState.values = { loadouts: [ownerLoadout] }
    loadoutCollectionState.statuses = { loadouts: 'ready' }

    component = mount(LoadoutModal, { target })
    await settle()

    expect(target.querySelector('[data-risu-loadout-id="owner-loadout"]')).not.toBeNull()
    expect(target.querySelector('[data-risu-loadout-id="facade-loadout"]')).toBeNull()
  })

  it('uses the selected character owner for the character-scoped loadout section', async () => {
    const ownerLoadout = { ...savedLoadout, characterIds: ['owner-character'] }
    loadoutCollectionState.values = { loadouts: [ownerLoadout] }
    loadoutCollectionState.statuses = { loadouts: 'ready' }
    characterOwnerState.characters = [{ chaId: 'owner-character' }]
    characterOwnerState.currentChar = 0
    characterOwnerState.status = 'ready'

    component = mount(LoadoutModal, { target })
    await settle()

    expect(target.textContent).toContain('Recently Used with This Character')
  })

  it('fails closed when the ready loadout owner has duplicate stable ids', async () => {
    seedLoadoutOwners([savedLoadout])
    loadoutCollectionState.values = { loadouts: [savedLoadout, { ...savedLoadout }] }
    loadoutCollectionState.statuses = { loadouts: 'ready' }

    component = mount(LoadoutModal, { target })
    await settle()

    expect(target.querySelector('[data-risu-loadout-id]')).toBeNull()
  })
})

it('retains a typed loadout name before save or unmount', async () => {
  await beginWriterDraftCaptureTest()
  try {
    component = mount(LoadoutModal, { target })
    await tick()
    const input = target.querySelector<HTMLInputElement>('input[type="text"]')!
    input.value = 'Unsubmitted loadout'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts().find((draft) => draft.key === 'loadout:new:global')?.data).toMatchObject({
      saveName: 'Unsubmitted loadout',
    })
    expect(loadoutMocks.saveCurrentLoadout).not.toHaveBeenCalled()
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
