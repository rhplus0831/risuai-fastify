import { flushSync } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({ available: false }))
vi.mock('./server/commands', async (importActual) => ({
  ...(await importActual<typeof import('./server/commands')>()),
  canUseServerCommands: () => transport.available,
}))

import {
  authorizeClientWriterRecovery,
  beginClientPromotion,
  beginClientSession,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
  setClientConnectionState,
  setClientProjectionReady,
  settleClientReader,
} from './clientSession'
import { replaceResourceDatabase } from './server/resourceState.svelte'
import { getResourceDatabase } from './__tests__/resourceDatabaseState'
import { selectedCharID } from './stores.svelte'
import { setDeferredSettingValue, setSettingValue } from './setting/utils'
import type { SettingContext, SettingItem } from './setting/types'
import { saveGlobalModuleDraftWithOutcome, setGlobalModuleEnabled } from './moduleCommands'
import {
  applyPersonaStateSnapshotLocally,
  currentPersonaStateSnapshot,
  reconcileSelectedPersonaProjectionEpoch,
  updateSelectedPersonaField,
  changeUserPersonaWithOutcome,
  updateSelectedPersonaFieldWithOutcome,
} from './persona'
import { applyLoadout, deleteLoadout, saveCurrentLoadout, toggleLoadoutFavorite } from './loadout'
import { applyCharacterRowMutationScoped, applyCharacterSelectionOptimistically } from './characterCommands'
import {
  applyChatNoteValueLocally,
  dispatchStagedChatNoteMutation,
  stageChatNoteMutation,
  appendCurrentChatUserMessageForSend,
  currentChatStateSnapshot,
  dispatchCreateChatWithOutcome,
  mutateChatWithScopedCommand,
  setChatNoteValue,
} from './chatCommands'
import { updateAgentPreset } from './agentPresets'
import { applyLorebookEntryDraftEdit } from './server/lorebookOwner.svelte'
import { applyCharacterScriptDefinitionDraft } from './server/scriptDefinitionOwner.svelte'
import {
  applyServerBackedSettingsPatch,
  createServerBackedSettingDraft,
  persistServerBackedSettingsPatch,
} from './server/settingsOwner.svelte'
import { createCharacterOwnerDraft } from './server/characterDraft.svelte'
import { applyPromptItemProjectionWrite } from './server/promptTemplateMutations.svelte'

function readSession(): void {
  const operation = beginClientSession('reader-tab')
  expect(
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other-tab', epoch: 1 } }),
  ).toBe(true)
  setClientProjectionReady(true)
  setClientConnectionState('live')
}

function promote(): void {
  const operation = beginClientPromotion()!
  expect(operation).not.toBeNull()
  expect(
    authorizeClientWriterRecovery(operation, {
      databaseLineage: 'lineage',
      writer: { sessionId: 'reader-tab', epoch: 2 },
    }),
  ).toBe(true)
  expect(completeClientWriterRecovery(operation)).toBe(true)
}

beforeEach(() => {
  resetClientSessionForTests()
  replaceResourceDatabase({
    currentChar: 0,
    characters: [
      {
        chaId: 'char-a',
        name: 'A',
        desc: 'Original',
        lastInteraction: 10,
        chatPage: 0,
        customscript: [],
        triggerscript: [],
        chats: [
          {
            id: 'chat-a',
            name: 'Chat',
            note: 'Original note',
            localLore: [{ id: 'lore-a', key: 'key', content: 'Original lore' }],
            message: [],
          },
        ],
      },
    ],
    notification: false,
    modules: [{ id: 'module-a', name: 'Original module', regex: [], trigger: [], lorebook: [] }],
    enabledModules: [],
    personas: [
      { id: 'persona-a', name: 'A', personaPrompt: '', note: '', icon: '', modules: [] },
      { id: 'persona-b', name: 'B', personaPrompt: '', note: '', icon: '', modules: [] },
    ],
    username: 'A',
    userIcon: '',
    personaPrompt: '',
    userNote: '',
    selectedPersonaId: 'persona-a',
    selectedPersona: 0,
    loadouts: [
      {
        id: 'loadout-a',
        name: 'Original loadout',
        favorite: false,
        modules: [],
        globalVariables: {},
        personaId: 'persona-a',
      },
    ],
    agentPresets: [{ id: 'agent-a', name: 'Original agent', steps: [] }],
    promptTemplate: [{ id: 'prompt-a', type: 'plain', role: 'system', text: 'Original prompt' }],
  } as never)
  selectedCharID.set(0)
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Reader mutation reached transport')
    }),
  )
  readSession()
})

afterEach(() => {
  resetClientSessionForTests()
  vi.unstubAllGlobals()
  selectedCharID.set(-1)
  replaceResourceDatabase({} as never)
})

describe.each([false, true])('reader local mutation admission (commands available: %s)', (available) => {
  beforeEach(() => {
    transport.available = available
  })

  it('rejects settings, persona, module, loadout and agent edits before local fallback or acceptance', async () => {
    const baseline = JSON.stringify(getResourceDatabase())
    const onChange = vi.fn()
    const item = { id: 'notification', type: 'check', bindKey: 'notification', onChange } as SettingItem
    const context = { db: getResourceDatabase(), modelInfo: {}, subModelInfo: {} } as SettingContext
    setSettingValue(item, true, context)
    expect(setDeferredSettingValue(item, true, context).queued).toBe(false)
    applyServerBackedSettingsPatch({ notification: true })
    expect(await persistServerBackedSettingsPatch({ notification: true })).toBe('failed')
    expect(await updateSelectedPersonaFieldWithOutcome('username', 'Edited')).toBe('failed')
    expect(await changeUserPersonaWithOutcome(1)).toBe('failed')
    expect(await setGlobalModuleEnabled('module-a', true)).toMatchObject({ status: 'failed' })
    expect(
      await saveGlobalModuleDraftWithOutcome('module-a', { ...getResourceDatabase().modules[0], name: 'Edited' }),
    ).toMatchObject({ status: 'failed' })
    expect(await toggleLoadoutFavorite('loadout-a')).toBe('failed')
    expect(await deleteLoadout('loadout-a')).toBe('failed')
    expect(await applyLoadout(getResourceDatabase().loadouts[0], ['modules'])).toBe('persistence-failed')
    expect(await saveCurrentLoadout('New loadout')).toMatchObject({ status: 'failed' })
    expect(await updateAgentPreset('agent-a', { name: 'Edited' })).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(getResourceDatabase())).toBe(baseline)
    expect(onChange).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves shared chat, character, lore, script and prompt owners unchanged', async () => {
    const baseline = JSON.stringify(getResourceDatabase())
    const mutation = vi.fn((value: { name: string }) => {
      value.name = 'Edited'
    })
    expect(applyCharacterRowMutationScoped(0, 'char-a', mutation)).toBe(false)
    expect(applyCharacterSelectionOptimistically('char-a', 100)).toBe(-1)
    expect(mutateChatWithScopedCommand(mutation)).toBe(false)
    expect(setChatNoteValue('chat-a', 'Edited')).toBe(false)
    expect(
      await dispatchCreateChatWithOutcome(
        'char-a',
        { id: 'new-chat', name: 'New chat', message: [], note: '', localLore: [] } as never,
        currentChatStateSnapshot(),
      ),
    ).toMatchObject({ status: 'failed' })
    expect(await appendCurrentChatUserMessageForSend('Reader input')).toMatchObject({ status: 'error' })
    expect(
      applyLorebookEntryDraftEdit({ kind: 'chat', chatId: 'chat-a' }, 0, {
        id: 'lore-a',
        key: 'key',
        content: 'Edited',
      } as never),
    ).toBe(false)
    expect(
      applyCharacterScriptDefinitionDraft(
        'char-a',
        [{ id: 'new-script', in: 'x', out: 'y', type: 'editinput' }] as never,
        [],
      ),
    ).toBe(false)
    expect(
      applyPromptItemProjectionWrite(
        [{ id: 'prompt-a', type: 'plain', role: 'system', text: 'Edited' }] as never,
        'prompt-a',
        null,
      ),
    ).toBeNull()
    expect(mutation).not.toHaveBeenCalled()
    expect(get(selectedCharID)).toBe(0)
    expect(JSON.stringify(getResourceDatabase())).toBe(baseline)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps editable component drafts separate from reader projections', async () => {
    let setting!: ReturnType<typeof createServerBackedSettingDraft<boolean>>
    let character!: ReturnType<typeof createCharacterOwnerDraft>
    const stop = $effect.root(() => {
      setting = createServerBackedSettingDraft('notification', false)
      character = createCharacterOwnerDraft(['name'])
    })
    try {
      flushSync()
      await Promise.resolve()
      setting.value = true
      character.value.name = 'Reader draft'
      flushSync()
      await Promise.resolve()
      expect(setting.value).toBe(true)
      expect(character.value.name).toBe('Reader draft')
      expect(getResourceDatabase().notification).toBe(false)
      expect(getResourceDatabase().characters[0].name).toBe('A')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

it('restores the existing local fallback only after explicit writer recovery completes', async () => {
  transport.available = false
  promote()
  expect(await setGlobalModuleEnabled('module-a', true)).toMatchObject({ status: 'accepted' })
  expect(getResourceDatabase().enabledModules).toContain('module-a')
  expect(await updateSelectedPersonaFieldWithOutcome('username', 'Writer name')).toBe('accepted')
  expect(getResourceDatabase().personas[0].name).toBe('Writer name')
  demoteClientSession()
  expect(await setGlobalModuleEnabled('module-a', false)).toMatchObject({ status: 'failed' })
  expect(getResourceDatabase().enabledModules).toContain('module-a')
  expect(fetch).not.toHaveBeenCalled()
})

it('allows a canonical persona apply without reasserting the former writer draft over reader content', () => {
  promote()
  updateSelectedPersonaField('username', 'Pending writer draft')
  const canonical = currentPersonaStateSnapshot()
  canonical.personas[0].name = 'Canonical persona'
  canonical.username = 'Canonical persona'
  demoteClientSession()
  applyPersonaStateSnapshotLocally(canonical)
  reconcileSelectedPersonaProjectionEpoch()
  expect(getResourceDatabase().personas[0].name).toBe('Canonical persona')
  expect(fetch).not.toHaveBeenCalled()
})

it('leaves an exact staged note dormant when its editor dispatches after re-promotion', async () => {
  promote()
  const rollback = applyChatNoteValueLocally('chat-a', 'Pending note')!
  const mutation = stageChatNoteMutation({ chatId: 'chat-a', characterId: 'char-a', note: 'Pending note' })
  demoteClientSession()
  promote()
  expect(await dispatchStagedChatNoteMutation(mutation, rollback)).toEqual({ status: 'unavailable' })
  expect(mutation.outbox.phase).toBe('staged')
  expect(getResourceDatabase().characters[0].chats[0].note).toBe('Pending note')
  expect(fetch).not.toHaveBeenCalled()
})
