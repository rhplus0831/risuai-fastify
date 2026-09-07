import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SERVER_CHARACTER_SUMMARY_VERSION } from '@risuai/protocol/character-summary-resource'
import { setManagedWriterForTest } from '../__tests__/managedClientSession'
import { demoteClientSession, requireClientAuthentication, resetClientSessionForTests } from '../clientSession'
import type { character } from '../storage/database.svelte'
import {
  applyCharacterResource,
  applyCharactersResource,
  applyChatGenerationSettingsLocalEffect,
  applyPersonaPatchLocalEffect,
  replaceResourceDatabase,
  updatePersonaOwnerState,
  collectionsResourceState,
  settingsResourceState,
  charactersResourceState,
  resetServerResourceState,
} from './resourceState.svelte'
import { clearRetainedChatProjections, registerRetainedChatProjection } from './chatRetainedProjection'
import {
  getReaderTranscriptCharacters,
  getReaderTranscriptPersona,
  isReaderPersonaReadRequired,
} from './readerTranscriptProjection.svelte'

function characterRow(): character {
  return {
    chaId: 'character-a',
    name: 'Committed character',
    type: 'character',
    firstMessage: 'Committed greeting',
    alternateGreetings: ['Alternate greeting'],
    desc: 'Prompt-only description',
    globalLore: [{ key: 'private prompt data' }],
    chats: [
      {
        id: 'chat-a',
        name: 'Committed chat',
        fmIndex: -1,
        generationSettings: { personaId: 'persona-a', authorNote: 'Private generation setting' },
        scriptstate: { private: 'not a reader input' },
        message: [{ role: 'user', data: 'Body has its own owner', chatId: 'message-a' }],
      },
    ],
  } as unknown as character
}

function applyRows(rows: character[], revision: number): void {
  expect(
    applyCharactersResource({
      version: SERVER_CHARACTER_SUMMARY_VERSION,
      revision,
      characters: rows,
      characterOrder: [],
      currentChar: 0,
    }),
  ).toBe(true)
}

beforeEach(() => {
  resetClientSessionForTests()
  resetServerResourceState()
})
afterEach(() => {
  clearRetainedChatProjections()
  resetClientSessionForTests()
  resetServerResourceState()
})

describe('authoritative reader display metadata', () => {
  it('captures raw server metadata before retained owner overlays and omits unrelated prompt/body state', () => {
    applyRows([characterRow()], 1)
    registerRetainedChatProjection({ kind: 'character', characterId: 'character-a' }, () => {
      const live = charactersResourceState.characters[0]
      live.name = 'Pending name'
      live.firstMessage = 'Pending greeting'
      live.chats[0].name = 'Pending chat name'
      live.chats[0].generationSettings = { personaId: 'pending-persona' }
    })
    const source = characterRow()
    expect(applyCharacterResource({ revision: 2, character: source })).toBe(true)
    source.name = 'Mutated caller input'
    const reader = getReaderTranscriptCharacters()[0]
    expect(reader).toMatchObject({ name: 'Committed character', firstMessage: 'Committed greeting' })
    expect(reader).not.toHaveProperty('desc')
    expect(reader).not.toHaveProperty('globalLore')
    expect(reader.chats[0]).toMatchObject({
      name: 'Committed chat',
      generationSettings: { personaId: 'persona-a' },
      message: [],
    })
    expect(reader.chats[0]).not.toHaveProperty('scriptstate')
    expect(reader.chats[0].generationSettings).not.toHaveProperty('authorNote')
    expect(charactersResourceState.characters[0].name).toBe('Pending name')
  })

  it('keeps certified details across same-revision shell summaries without taking the mutable writer row', () => {
    const shell = {
      chaId: 'character-a',
      type: 'character',
      name: 'Summary name',
      __serverCharacterShell: true,
      chatIds: ['chat-a'],
    } as unknown as character
    applyRows([shell], 1)
    expect(getReaderTranscriptCharacters()[0]).toMatchObject({ __serverCharacterShell: true, chatIds: ['chat-a'] })
    expect(applyCharacterResource({ revision: 1, character: characterRow() })).toBe(true)
    charactersResourceState.characters[0].name = 'Pending name'
    applyRows([shell], 1)
    expect(getReaderTranscriptCharacters()[0]).toMatchObject({ name: 'Committed character', chats: [{ id: 'chat-a' }] })
    expect(getReaderTranscriptCharacters()[0]).not.toHaveProperty('__serverCharacterShell')
    applyRows([{ ...shell, name: 'New summary name' }], 2)
    expect(getReaderTranscriptCharacters()[0]).toMatchObject({ name: 'New summary name', __serverCharacterShell: true })
  })

  it('shows the accepted persona binding while retaining a newer pending binding in the writer owner', () => {
    applyRows([characterRow()], 1)
    charactersResourceState.characters[0].chats[0].generationSettings = { personaId: 'newer-draft-persona' }
    expect(
      applyChatGenerationSettingsLocalEffect({
        revision: 2,
        characterId: 'character-a',
        chatId: 'chat-a',
        attemptedGenerationSettings: { personaId: 'persona-b' },
        generationSettings: { personaId: 'persona-b' },
      }),
    ).toBe(true)
    expect(getReaderTranscriptCharacters()[0].chats[0].generationSettings).toEqual({ personaId: 'persona-b' })
    expect(charactersResourceState.characters[0].chats[0].generationSettings).toEqual({
      personaId: 'newer-draft-persona',
    })
  })

  it('retains same-lineage metadata after demotion and clears it immediately on authentication loss', () => {
    setManagedWriterForTest()
    applyRows([characterRow()], 1)
    const committed = getReaderTranscriptCharacters()
    demoteClientSession()
    expect(getReaderTranscriptCharacters()).toBe(committed)
    requireClientAuthentication()
    expect(getReaderTranscriptCharacters()).toEqual([])
  })
  it('applies only receipt-certified persona fields while preserving newer pending owner fields', () => {
    replaceResourceDatabase(
      {
        characters: [],
        personas: [
          {
            id: 'persona-a',
            name: 'Before',
            displayName: 'Certified display name',
            icon: 'before.png',
            personaPrompt: '',
            note: '',
          },
        ],
        selectedPersonaId: 'persona-a',
        selectedPersona: 0,
        username: 'Before',
        userIcon: 'before.png',
        personaPrompt: '',
        userNote: '',
      } as never,
      1,
    )
    updatePersonaOwnerState((draft) => {
      draft.personas[0].name = 'Newer pending name'
      draft.personas[0].displayName = 'Newer pending display name'
      draft.personas[0].icon = 'pending.png'
      draft.username = 'Newer pending name'
      draft.userIcon = 'pending.png'
    })
    expect(
      applyPersonaPatchLocalEffect({
        revision: 2,
        personaId: 'persona-a',
        attemptedPatch: { name: 'Accepted name', icon: 'accepted.png' },
        attemptedPersona: {
          id: 'persona-a',
          name: 'Accepted name',
          displayName: 'Unacknowledged snapshot display name',
          icon: 'accepted.png',
          personaPrompt: '',
          note: '',
        },
        attemptedLegacyProfile: {
          username: 'Accepted name',
          userIcon: 'accepted.png',
          personaPrompt: '',
          userNote: '',
        },
        legacyProfileProjectionApplied: true,
      }),
    ).toBe(true)
    expect(getReaderTranscriptPersona()).toMatchObject({
      username: 'Accepted name',
      userIcon: 'accepted.png',
      selectedPersonaId: 'persona-a',
      personas: [{ name: 'Accepted name', icon: 'accepted.png', displayName: 'Certified display name' }],
    })
    expect(collectionsResourceState.values.personas![0]).toMatchObject({
      name: 'Newer pending name',
      icon: 'pending.png',
      displayName: 'Newer pending display name',
    })
    expect(settingsResourceState.value).toMatchObject({ username: 'Newer pending name', userIcon: 'pending.png' })
    expect(isReaderPersonaReadRequired('personas')).toBe(false)
    expect(isReaderPersonaReadRequired('username')).toBe(false)
  })
})
