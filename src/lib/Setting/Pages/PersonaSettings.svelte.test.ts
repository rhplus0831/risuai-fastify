import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const characterSpies = vi.hoisted(() => ({
  getCharImage: vi.fn(),
}))

const sortableSpies = vi.hoisted(() => ({
  create: vi.fn(() => ({ destroy: vi.fn() })),
}))

vi.mock('src/ts/characters', () => ({
  getCharImage: characterSpies.getCharImage,
}))

vi.mock('sortablejs/modular/sortable.core.esm.js', () => ({
  default: sortableSpies,
}))

import PersonaSettings from './PersonaSettings.svelte'
import { language } from 'src/lang'
import { setDatabaseLite } from 'src/ts/storage/database.svelte'
import {
  collectionsResourceState,
  resetServerResourceState,
  settingsResourceState,
} from 'src/ts/server/resourceState.svelte'

type MountedComponent = Parameters<typeof unmount>[0]

let target: HTMLElement
let component: MountedComponent | undefined

beforeEach(() => {
  target = document.createElement('div')
  document.body.appendChild(target)
  characterSpies.getCharImage.mockReset().mockResolvedValue('background-image: url("persona")')
  sortableSpies.create.mockClear()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  setDatabaseLite({} as any)
})

describe('PersonaSettings owner changes', () => {
  it('fails closed when the selected persona disappears from an authoritative projection', async () => {
    setDatabaseLite({
      characters: [],
      enabledModules: [],
      loreBook: [],
      loreBookPage: 0,
      modules: [],
      personaPrompt: '',
      personas: [],
      selectedPersonaId: 'missing-persona',
      selectedPersona: 0,
      userIcon: 'persona-icon',
      username: 'Missing persona',
      userNote: '',
    } as any)

    component = mount(PersonaSettings, { target })
    await tick()

    expect(target.querySelector('h2')?.textContent).toBe(language.persona)
    expect(characterSpies.getCharImage).not.toHaveBeenCalled()
    expect(target.textContent).toContain(language.largePortrait)
  })

  it('renders valid resident persona owners while the collection is pre-ready', async () => {
    resetServerResourceState()
    collectionsResourceState.values.personas = [
      { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' },
    ]
    collectionsResourceState.statuses.personas = 'loading'
    settingsResourceState.value.selectedPersonaId = 'persona-a'
    settingsResourceState.value.selectedPersona = 0
    settingsResourceState.value.username = 'Persona A'
    settingsResourceState.value.userIcon = ''
    settingsResourceState.value.personaPrompt = ''
    settingsResourceState.value.userNote = ''
    settingsResourceState.standaloneStatuses.selectedPersonaId = 'loading'
    settingsResourceState.standaloneStatuses.selectedPersona = 'loading'

    component = mount(PersonaSettings, { target })
    await tick()

    expect(target.querySelectorAll('[data-risu-idx]')).toHaveLength(1)
  })

  it('fails closed when a ready persona owner is missing or ambiguous', async () => {
    resetServerResourceState()
    collectionsResourceState.values.personas = [
      { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' },
      { id: 'persona-a', name: 'Ambiguous Persona', icon: '', personaPrompt: '', note: '' },
    ]
    collectionsResourceState.statuses.personas = 'ready'
    settingsResourceState.value.selectedPersonaId = 'persona-a'
    settingsResourceState.value.selectedPersona = 0
    settingsResourceState.value.username = 'Persona A'
    settingsResourceState.value.userIcon = ''
    settingsResourceState.value.personaPrompt = ''
    settingsResourceState.value.userNote = ''
    settingsResourceState.standaloneStatuses.selectedPersonaId = 'ready'
    settingsResourceState.standaloneStatuses.selectedPersona = 'ready'

    component = mount(PersonaSettings, { target })
    await tick()

    expect(target.querySelectorAll('[data-risu-idx]')).toHaveLength(0)
  })

  it('fails closed on an errored persona owner', async () => {
    resetServerResourceState()
    collectionsResourceState.values.personas = [
      { id: 'persona-a', name: 'Persona A', icon: '', personaPrompt: '', note: '' },
    ]
    collectionsResourceState.statuses.personas = 'error'
    settingsResourceState.value.selectedPersonaId = 'persona-a'
    settingsResourceState.value.selectedPersona = 0
    settingsResourceState.value.username = 'Persona A'
    settingsResourceState.value.userIcon = ''
    settingsResourceState.value.personaPrompt = ''
    settingsResourceState.value.userNote = ''
    settingsResourceState.standaloneStatuses.selectedPersonaId = 'ready'
    settingsResourceState.standaloneStatuses.selectedPersona = 'ready'

    component = mount(PersonaSettings, { target })
    await tick()

    expect(target.querySelectorAll('[data-risu-idx]')).toHaveLength(0)
  })
})

it('captures a persona field even before its optimistic watcher queues the save', async () => {
  await beginWriterDraftCaptureTest()
  try {
    setDatabaseLite({
      characters: [],
      modules: [],
      enabledModules: [],
      personas: [{ id: 'persona-draft', name: 'Original persona', icon: '', personaPrompt: '', note: '' }],
      selectedPersonaId: 'persona-draft',
      selectedPersona: 0,
      username: 'Original persona',
      userIcon: '',
      personaPrompt: '',
      userNote: '',
    } as any)
    component = mount(PersonaSettings, { target })
    await tick()
    const input = target.querySelector<HTMLInputElement>('input[placeholder="User"]')!
    input.value = 'Newest persona typing'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(capturedWriterDrafts()).toEqual([
      expect.objectContaining({
        key: 'persona:persona-draft',
        data: { username: 'Newest persona typing' },
        baseline: { username: 'Original persona' },
      }),
    ])
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
