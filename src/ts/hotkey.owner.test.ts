import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testDatabaseState } from './__tests__/resourceDatabaseState'
import {
  beginClientSession,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from './clientSession'
import { currentRoute, navigate } from './router'
import { get } from 'svelte/store'

// Regression coverage: ordinary keydown matching must not mutate
// `testDatabaseState.db.hotkeys`, and hotkey settings edits must route through a
// server-backed settings patch instead of mutating an aggregate database.

const platformState = vi.hoisted(() => ({ isFastifyServer: true }))
const changeCharMock = vi.hoisted(() => vi.fn(async () => {}))
const alertSpies = vi.hoisted(() => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  alertToast: vi.fn(),
}))

vi.mock('./platform', async (importActual) => {
  const actual = await importActual<typeof import('./platform')>()
  return {
    ...actual,
    get isFastifyServer() {
      return platformState.isFastifyServer
    },
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'hotkey-command-token',
}))

vi.mock('./characters', () => ({
  changeChar: changeCharMock,
}))

vi.mock('./alert', async (importActual) => ({
  ...(await importActual<typeof import('./alert')>()),
  ...alertSpies,
}))

// stores.svelte.ts installs a root $effect that calls moduleUpdate() whenever
// testDatabaseState.db changes; stub it so seeding the database does not trigger the
// module pipeline (and its circular-import init order) under test.
vi.mock('./process/modules', async (importActual) => {
  const actual = await importActual<typeof import('./process/modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

import { adjacentCharacterIndex, changeToAdjacentCharacter, changeToPreset, hotkeyMatches, initHotkey } from './hotkey'
import { applyServerBackedSetting } from './server/settingsOwner.svelte'
import { settingsGroupForKey, clearCachedServerCommandRevision } from './server/commands'

import { charactersResourceState } from './server/resourceState.svelte'
import { alertStore, selectedCharID } from './stores.svelte'
import { language } from 'src/lang'
interface CapturedFetch {
  url: string
  method: string
  body: any
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubCommandFetch(options: { generationSettingsResponse?: Promise<Response> } = {}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      calls.push({
        url,
        method: init.method ?? 'GET',
        body,
      })
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url.startsWith('/api/v1/commands/settings/')) {
        return jsonResponse({
          revision: 11,
          event: { type: 'settings.patched', revision: 11, resource: 'settings' },
        })
      }
      if (url === '/api/v1/commands/model-presets/select') {
        return jsonResponse({
          revision: 11,
          event: { type: 'modelPreset.selected', revision: 11, resource: 'model-preset' },
          modelPresetId: 'model-second',
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
        if (options.generationSettingsResponse) return options.generationSettingsResponse
        return jsonResponse({
          revision: 11,
          event: {
            type: 'chat.updated',
            revision: 11,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
          characterId: 'char-a',
          certificate: 'chat-generation-settings-sparse-v1',
          patchedKeys: Object.keys(body?.patch ?? {}).sort(),
          deletedKeys: [...(body?.deleteKeys ?? [])].sort(),
          sidebarTogglePatchedKeys: Object.keys(body?.patch?.sidebarToggles ?? {}).sort(),
          sidebarToggleDeletedKeys: [...(body?.sidebarToggleDeleteKeys ?? [])].sort(),
          prunedSidebarToggleKeys: [],
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

async function waitForCommand(
  calls: CapturedFetch[],
  predicate: (call: CapturedFetch) => boolean,
): Promise<CapturedFetch> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const match = calls.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`command not dispatched; saw: ${JSON.stringify(calls)}`)
}

function seedDatabase(): void {
  testDatabaseState.db = {
    hotkeys: [
      { key: 'a', action: 'home' },
      { key: 'r', ctrl: true, alt: true, action: 'reroll' },
    ],
    botPresets: [],
    modelPresets: [
      { id: 'model-default', name: 'Default Model' },
      { id: 'model-second', name: 'Second Model' },
    ],
    modelPresetsId: 0,
    promptPresets: [{ id: 'prompt-default', name: 'Default Prompt' }],
    promptPresetsId: 0,
  } as any
}

function seedReadyCharacterOwners(
  characters: Array<Record<string, unknown>>,
  characterOrder: unknown[],
  currentChar: number,
): void {
  charactersResourceState.characters = characters as any
  charactersResourceState.characterOrder = characterOrder as any
  charactersResourceState.currentChar = currentChar
  charactersResourceState.rowStatuses = Object.fromEntries(
    characters.flatMap((character) =>
      typeof character.chaId === 'string' && character.chaId.length > 0 ? [[character.chaId, 'ready']] : [],
    ),
  ) as any
  charactersResourceState.status = 'ready'
}

beforeEach(() => {
  resetClientSessionForTests()
  changeCharMock.mockClear()
  for (const spy of Object.values(alertSpies)) spy.mockReset()
  platformState.isFastifyServer = true
  alertStore.set({ type: 'none', msg: '' })
  selectedCharID.set(-1)
  clearCachedServerCommandRevision()
  seedDatabase()
})

afterEach(() => {
  resetClientSessionForTests()
  vi.unstubAllGlobals()
})

describe('hotkey handling through explicit resource owners', () => {
  it('uses the reader URL for adjacent navigation without persisting selection or presets', async () => {
    seedReadyCharacterOwners(
      [
        { name: 'Alpha', chaId: 'char-a' },
        { name: 'Bravo', chaId: 'char-b' },
        { name: 'Charlie', chaId: 'char-c' },
      ],
      ['char-a', 'char-b', 'char-c'],
      2,
    )
    const operation = beginClientSession('reader-a')
    settleClientReader(operation, { databaseLineage: 'lineage-a', writer: { sessionId: 'writer-b', epoch: 1 } })
    setClientProjectionReady(true)
    setClientConnectionState('live')
    navigate('/character/char-a')
    await expect(changeToAdjacentCharacter('next')).resolves.toBe(true)
    expect(get(currentRoute)).toMatchObject({ kind: 'character', chaId: 'char-b' })
    expect(charactersResourceState.currentChar).toBe(2)
    expect(changeCharMock).not.toHaveBeenCalled()
    expect(changeToPreset(0)).toBe(false)
  })
  it('finds adjacent characters at both ends of the alphabetized list', () => {
    const characters = [{ name: 'Charlie' }, { name: 'Alpha' }, { name: 'Bravo' }] as any

    expect(adjacentCharacterIndex(characters, 1, 'next')).toBe(2)
    expect(adjacentCharacterIndex(characters, 0, 'previous')).toBe(2)
    expect(adjacentCharacterIndex(characters, 1, 'previous')).toBeNull()
    expect(adjacentCharacterIndex(characters, 0, 'next')).toBeNull()
  })

  it('uses the normal character selection flow for adjacent-character hotkeys', async () => {
    const characters = [
      { name: 'Charlie', chaId: 'char-c' },
      { name: 'Alpha', chaId: 'char-a' },
      { name: 'Bravo', chaId: 'char-b' },
    ]

    seedReadyCharacterOwners(characters, ['char-c', 'char-a', 'char-b'], 1)
    selectedCharID.set(0)
    await expect(changeToAdjacentCharacter('next')).resolves.toBe(true)
    expect(changeCharMock).toHaveBeenLastCalledWith(2)

    seedReadyCharacterOwners(characters, ['char-c', 'char-a', 'char-b'], 0)
    selectedCharID.set(1)
    await expect(changeToAdjacentCharacter('previous')).resolves.toBe(true)
    expect(changeCharMock).toHaveBeenLastCalledWith(2)

    seedReadyCharacterOwners(characters, ['char-c', 'char-a', 'char-b'], 1)
    selectedCharID.set(2)
    await expect(changeToAdjacentCharacter('previous')).resolves.toBe(false)
    expect(changeCharMock).toHaveBeenCalledTimes(2)
  })

  it('fails closed for malformed or duplicate ready character owners', async () => {
    seedReadyCharacterOwners(
      [
        { name: 'Charlie', chaId: 'duplicate-character' },
        { name: 'Alpha', chaId: 'duplicate-character' },
      ],
      ['duplicate-character'],
      0,
    )
    selectedCharID.set(0)

    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)
    expect(changeCharMock).not.toHaveBeenCalled()

    seedReadyCharacterOwners(
      [
        { name: 'Charlie', chaId: '' },
        { name: 'Alpha', chaId: 'char-a' },
      ],
      ['char-a'],
      0,
    )
    selectedCharID.set(0)

    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)
    expect(changeCharMock).not.toHaveBeenCalled()
  })

  it('fails closed for malformed or duplicate ready character-order ids', async () => {
    const characters = [
      { name: 'Alpha', chaId: 'char-a' },
      { name: 'Bravo', chaId: 'char-b' },
    ]

    seedReadyCharacterOwners(characters, ['char-a', 'char-a'], 0)
    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)

    seedReadyCharacterOwners(characters, ['char-a', 'missing-character'], 0)
    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)

    seedReadyCharacterOwners(
      characters,
      [{ id: 'folder-a', name: 'Folder', color: '', data: ['char-a', 'char-b', 'char-b'] }],
      0,
    )
    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)
    expect(changeCharMock).not.toHaveBeenCalled()
  })

  it('fails closed for an invalid ready selection owner without using the selected-index mirror', async () => {
    seedReadyCharacterOwners(
      [
        { name: 'Alpha', chaId: 'char-a' },
        { name: 'Bravo', chaId: 'char-b' },
      ],
      ['char-a', 'char-b'],
      9,
    )
    selectedCharID.set(0)

    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)
    expect(changeCharMock).not.toHaveBeenCalled()
  })

  it('fails closed when character resources are in an error state', async () => {
    seedReadyCharacterOwners(
      [
        { name: 'Alpha', chaId: 'char-a' },
        { name: 'Bravo', chaId: 'char-b' },
      ],
      ['char-a', 'char-b'],
      0,
    )
    charactersResourceState.status = 'error'
    selectedCharID.set(0)

    await expect(changeToAdjacentCharacter('next')).resolves.toBe(false)
    expect(changeCharMock).not.toHaveBeenCalled()
  })

  it.each(['idle', 'loading'] as const)(
    'keeps retained-owner adjacent navigation while character resources are %s',
    async (status) => {
      testDatabaseState.db.characters = [{ name: 'Charlie' }, { name: 'Alpha' }] as any
      charactersResourceState.status = status
      selectedCharID.set(1)

      await expect(changeToAdjacentCharacter('next')).resolves.toBe(true)
      expect(changeCharMock).toHaveBeenLastCalledWith(0)
    },
  )

  it('maps hotkeys to sidebar settings group', () => {
    expect(settingsGroupForKey('hotkeys')).toBe('sidebar')
  })

  it('matches hotkeys without mutating the settings owner', () => {
    const hotkey = testDatabaseState.db.hotkeys[0]
    const event = new KeyboardEvent('keydown', { key: 'a' })

    // hotkeyMatches must not write default modifier fields back onto the entry.
    let matched = false
    expect(() => {
      matched = hotkeyMatches(hotkey, event)
    }).not.toThrow()
    expect(matched).toBe(true)
    // The entry is left untouched: no defaults were projected onto it.
    expect(hotkey.ctrl).toBeUndefined()
    expect(hotkey.alt).toBeUndefined()
    expect(hotkey.shift).toBeUndefined()
  })

  it('treats keydown inside a Monaco EditContext editor as editable', () => {
    // Monaco ≥0.53 focuses a plain div.native-edit-context, so the unmodified
    // Space→focusInput hotkey must be rejected via the .monaco-editor guard.
    const editorRoot = document.createElement('div')
    editorRoot.className = 'monaco-editor'
    const editContext = document.createElement('div')
    editContext.className = 'native-edit-context'
    editorRoot.appendChild(editContext)
    document.body.appendChild(editorRoot)
    try {
      const hotkey = { key: ' ', action: 'focusInput' } as any
      let matched: boolean | null = null
      editContext.addEventListener('keydown', (ev) => {
        matched = hotkeyMatches(hotkey, ev)
      })
      editContext.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      expect(matched).toBe(false)
    } finally {
      editorRoot.remove()
    }
  })

  it('rejects mismatched modifiers without mutation', () => {
    const hotkey = testDatabaseState.db.hotkeys[0]
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })

    expect(hotkeyMatches(hotkey, event)).toBe(false)
    expect(hotkey.ctrl).toBeUndefined()
  })

  it('routes numbered preset shortcuts to modern model presets on a fresh split database', async () => {
    const calls = stubCommandFetch()
    expect(testDatabaseState.db.botPresets).toEqual([])

    expect(changeToPreset(1)).toBe(true)
    expect(testDatabaseState.db.modelPresetsId).toBe(1)
    expect(changeToPreset(8)).toBe(false)

    const command = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/model-presets/select' && call.method === 'POST',
    )
    expect(command.body).toMatchObject({ modelPresetId: 'model-second' })
  })

  it('fails closed when a numbered preset does not have a unique stable id', () => {
    testDatabaseState.db.modelPresets.push({ id: 'model-second', name: 'Duplicate Model' })

    expect(changeToPreset(1)).toBe(false)
    expect(changeToPreset(2)).toBe(false)
  })

  it('keeps Ctrl+1 functional when a fresh database has only its default modern preset', async () => {
    const calls = stubCommandFetch()
    testDatabaseState.db.modelPresets = [{ id: 'model-default', name: 'Default Model' }]
    testDatabaseState.db.modelPresetsId = 0

    expect(changeToPreset(0)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual([])
  })

  it('switches the active chat generation model preset when the chat owns preset selection', async () => {
    const calls = stubCommandFetch()
    const characters = [
      {
        chaId: 'char-a',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            generationSettings: {
              configured: true,
              personaId: 'persona-default',
              modelPresetId: 'model-default',
              promptPresetId: 'prompt-default',
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      },
    ]
    seedReadyCharacterOwners(characters, ['char-a'], 0)
    selectedCharID.set(0)

    expect(changeToPreset(1)).toBe(true)
    expect(charactersResourceState.characters[0].chats[0].generationSettings.modelPresetId).toBe('model-second')
    expect(charactersResourceState.characters[0].chats[0].generationSettings.modelPresetSelectionSource).toBe('manual')
    expect(testDatabaseState.db.modelPresetsId).toBe(0)

    const command = await waitForCommand(calls, (call) => call.url.endsWith('/chat-a/generation-settings'))
    expect(command.body).toEqual({
      baseRevision: 10,
      baseGenerationSettingsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      patch: { modelPresetId: 'model-second', modelPresetSelectionSource: 'manual' },
    })
    await vi.waitFor(() => expect(alertSpies.alertToast).toHaveBeenCalledWith(`${language.modelPresets}: Second Model`))
  })

  it('reports an active-chat preset rejection without showing a success toast', async () => {
    const calls = stubCommandFetch({
      generationSettingsResponse: Promise.resolve(jsonResponse({ error: 'hotkey selection rejected' }, 400)),
    })
    const characters = [
      {
        chaId: 'char-a',
        chatPage: 0,
        chats: [
          {
            id: 'chat-a',
            generationSettings: {
              configured: true,
              personaId: 'persona-default',
              modelPresetId: 'model-default',
              promptPresetId: 'prompt-default',
              jailbreakToggle: false,
              sidebarToggles: {},
            },
          },
        ],
      },
    ]
    seedReadyCharacterOwners(characters, ['char-a'], 0)
    selectedCharID.set(0)

    expect(changeToPreset(1)).toBe(true)
    await waitForCommand(calls, (call) => call.url.endsWith('/chat-a/generation-settings'))
    await vi.waitFor(() =>
      expect(alertSpies.alertError).toHaveBeenCalledWith(
        language.chatGenerationSettingsSaveFailed('hotkey selection rejected'),
      ),
    )

    expect(alertSpies.alertToast).not.toHaveBeenCalled()
    expect(charactersResourceState.characters[0].chats[0].generationSettings.modelPresetId).toBe('model-default')
  })

  it('routes a hotkey settings edit through a sidebar settings patch', async () => {
    const calls = stubCommandFetch()
    // Mirror HotkeySettings.svelte: build a fresh array and apply it.
    const next = testDatabaseState.db.hotkeys.map((hotkey, i) => (i === 0 ? { ...hotkey, ctrl: true } : { ...hotkey }))

    expect(() => applyServerBackedSetting('hotkeys', next)).not.toThrow()

    // Optimistic projection update is applied without throwing the guard.
    expect(testDatabaseState.db.hotkeys[0].ctrl).toBe(true)

    const patch = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/settings/sidebar' && call.method === 'PATCH',
    )
    expect(patch.body.patch.hotkeys).toBeDefined()
    expect(patch.body.patch.hotkeys[0].ctrl).toBe(true)
    expect(patch.body.patch.hotkeys[0].action).toBe('home')
  })

  it('dispatches a configured document hotkey without mutating the settings owner', async () => {
    testDatabaseState.db.hotkeys = [{ key: 'a', action: 'send' }] as any
    const configuredHotkey = testDatabaseState.db.hotkeys[0]
    const sendButton = document.createElement('button')
    sendButton.className = 'button-icon-send'
    const sendSpy = vi.fn()
    const bubbledToWindow = vi.fn()
    sendButton.addEventListener('click', sendSpy)
    document.body.appendChild(sendButton)
    window.addEventListener('keydown', bubbledToWindow)
    initHotkey()
    try {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
      })
      expect(() => document.dispatchEvent(event)).not.toThrow()
      await Promise.resolve()

      expect(sendSpy).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      expect(bubbledToWindow).not.toHaveBeenCalled()
      expect(configuredHotkey).toEqual({ key: 'a', action: 'send' })
    } finally {
      window.removeEventListener('keydown', bubbledToWindow)
      sendButton.remove()
    }
  })
})
