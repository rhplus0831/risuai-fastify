import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SERVER_CHARACTER_SUMMARY_VERSION } from '@risuai/protocol/character-summary-resource'
import { setManagedWriterForTest } from '../__tests__/managedClientSession'
import {
  beginClientSession,
  demoteClientSession,
  requireClientAuthentication,
  resetClientSessionForTests,
  settleClientReader,
} from '../clientSession'
import type { character, Database } from '../storage/database.svelte'
import {
  applyCharacterResource,
  applyCharactersResource,
  applyCharacterOrderResource,
  applyCharacterOrderLocalEffect,
  applySettingsResource,
  applySettingsPatchLocalEffect,
  applyChatGenerationSettingsLocalEffect,
  applyPersonaPatchLocalEffect,
  applyCollectionsResource,
  applySettingsGroupResource,
  applyModuleCollectionMutationLocalEffect,
  applyModuleEnabledLocalEffect,
  applySplitPresetPatchLocalEffect,
  applyAgentPresetPatchLocalEffect,
  replaceResourceDatabase,
  updatePersonaOwnerState,
  collectionsResourceState,
  settingsResourceState,
  charactersResourceState,
  resetServerResourceState,
} from './resourceState.svelte'
import { resolveActiveModuleStates } from '../moduleActivation'
import { registerPendingSettingsProjectionOverlay } from './settingsPendingProjection'
import { clearRetainedChatProjections, registerRetainedChatProjection } from './chatRetainedProjection'
import {
  getReaderTranscriptCharacters,
  getReaderTranscriptPersona,
  getReaderNavigationSettings,
  getReaderCharacterOrder,
  isReaderPersonaReadRequired,
  getReaderModuleDisplayDatabase,
  isReaderModuleReadRequired,
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
  it('records raw accepted module resources before registered writer overlays are restored', () => {
    setManagedWriterForTest()
    const stop = registerPendingSettingsProjectionOverlay((target) => {
      if (Object.hasOwn(target, 'enabledModules')) target.enabledModules = ['pending-module']
      if (Object.hasOwn(target, 'modules')) target.modules = [{ id: 'pending-module', name: 'Pending' }]
    })
    try {
      expect(applySettingsResource({ revision: 1, settings: { enabledModules: ['confirmed-module'] } })).toBe(true)
      expect(
        applyCollectionsResource(
          {
            revision: 1,
            collections: { modules: [{ id: 'confirmed-module', name: 'Confirmed', description: '' }] },
          },
          'modules',
        ),
      ).toBe(true)
      expect(settingsResourceState.value.enabledModules).toEqual(['pending-module'])
      expect(collectionsResourceState.values.modules).toEqual([{ id: 'pending-module', name: 'Pending' }])
      expect(getReaderModuleDisplayDatabase()).toMatchObject({
        enabledModules: ['confirmed-module'],
        modules: [{ id: 'confirmed-module', name: 'Confirmed' }],
      })
    } finally {
      stop()
    }
  })

  it('isolates passive module metadata and resolves activation from the reader chat instead of writer selection', () => {
    setManagedWriterForTest()
    const row = characterRow()
    row.modules = ['character-module']
    row.prebuiltAssetStyle = 'border-radius: 8px;'
    row.hideChatIcon = true
    row.chatPage = 0
    row.chats = [
      { id: 'writer-chat', message: [], modules: ['writer-module'] },
      {
        id: 'reader-chat',
        message: [],
        modules: ['chat-module'],
        generationSettings: {
          personaId: 'reader-persona',
          promptPresetId: 'reader-prompt',
          agentPresetId: 'reader-agent',
        },
      },
    ] as never
    const moduleIds = [
      'global-module',
      'character-module',
      'chat-module',
      'persona-module',
      'prompt-module',
      'agent-module',
      'writer-module',
    ]
    replaceResourceDatabase(
      {
        characters: [row],
        currentChar: 0,
        modules: moduleIds.map((id) => ({
          id,
          name: id,
          namespace: id === 'prompt-module' ? 'prompt-namespace' : id,
          assets: [['asset', `${id}.png`, 'png']],
          backgroundEmbedding: `<p>${id}</p>`,
          hideIcon: true,
          cjs: 'private executable',
          regex: [{ out: 'private transform' }],
          trigger: [{ effect: 'private' }],
          mcp: [{ key: 'private' }],
        })),
        enabledModules: ['global-module'],
        moduleIntergration: 'writer-module',
        promptPresets: [
          { id: 'reader-prompt', moduleIntergration: 'prompt-namespace', promptTemplate: [{ text: 'private prompt' }] },
        ],
        agentPresets: [
          {
            id: 'reader-agent',
            enabled: true,
            moduleIntergration: 'agent-module',
            steps: [{ instruction: 'private agent prompt' }],
          },
        ],
        agentPresetDefaultId: 'writer-agent',
        personas: [
          {
            id: 'reader-persona',
            name: 'Reader',
            modules: ['persona-module'],
            personaPrompt: 'private persona prompt',
          },
        ],
        selectedPersonaId: 'writer-persona',
        legacyMediaFindings: true,
        assetMaxDifference: 5,
        newImageHandlingBeta: true,
      } as never,
      1,
    )
    collectionsResourceState.values.modules![0].assets![0][1] = 'pending.png'
    collectionsResourceState.values.modules![0].backgroundEmbedding = 'Pending background'
    settingsResourceState.value.enabledModules = ['writer-module']
    charactersResourceState.characters[0].modules = ['writer-module']
    charactersResourceState.characters[0].chats[1].modules = ['writer-module']
    demoteClientSession()

    const projected = getReaderTranscriptCharacters()[0]
    const database = { ...getReaderModuleDisplayDatabase(), ...getReaderTranscriptPersona() } as Database
    const active = resolveActiveModuleStates(database, projected, projected.chats[1])
    expect(active.map(({ module }) => module.id)).toEqual(moduleIds.filter((id) => id !== 'writer-module'))
    expect(database.modules[0]).toEqual({
      id: 'global-module',
      name: 'global-module',
      namespace: 'global-module',
      assets: [['asset', 'global-module.png', 'png']],
      backgroundEmbedding: '<p>global-module</p>',
      hideIcon: true,
    })
    expect(database.promptPresets).toEqual([{ id: 'reader-prompt', moduleIntergration: 'prompt-namespace' }])
    expect(database.agentPresets).toEqual([{ id: 'reader-agent', enabled: true, moduleIntergration: 'agent-module' }])
    expect(database.personas[0]).not.toHaveProperty('personaPrompt')
    expect(projected).toMatchObject({ prebuiltAssetStyle: 'border-radius: 8px;', hideChatIcon: true })
    expect(getReaderNavigationSettings()).toMatchObject({
      legacyMediaFindings: true,
      assetMaxDifference: 5,
      newImageHandlingBeta: true,
    })
  })

  it('certifies prompt/agent integration patches and reader chat preset bindings without copying later writer edits', () => {
    replaceResourceDatabase(
      {
        characters: [characterRow()],
        modules: [],
        promptPresets: [{ id: 'prompt-a', moduleIntergration: 'before' }],
        agentPresets: [{ id: 'agent-a', name: 'Agent', enabled: true, steps: [], moduleIntergration: 'before' }],
      } as never,
      1,
    )
    settingsResourceState.value.agentPresets![0].moduleIntergration = 'newer-pending-agent'
    collectionsResourceState.values.promptPresets![0].moduleIntergration = 'newer-pending-prompt'
    expect(
      applyAgentPresetPatchLocalEffect({
        revision: 2,
        presetId: 'agent-a',
        updatedAt: 2,
        fields: {
          moduleIntergration: {
            attempted: { present: true, value: 'accepted-agent' },
            canonical: { present: true, value: 'accepted-agent' },
          },
        },
      }),
    ).toBe(true)
    expect(
      applySplitPresetPatchLocalEffect({
        revision: 3,
        presetKind: 'prompt',
        presetId: 'prompt-a',
        attemptedPatch: { moduleIntergration: 'accepted-prompt' },
        preset: { moduleIntergration: 'accepted-prompt' },
        attemptedSettings: {},
        settings: {},
        selectedProjectionApplied: false,
        ownerProjectionApplied: false,
      }),
    ).toBe(true)
    charactersResourceState.characters[0].chats[0].generationSettings = {
      agentPresetId: 'pending-agent',
      promptPresetId: 'pending-prompt',
    }
    expect(
      applyChatGenerationSettingsLocalEffect({
        revision: 4,
        characterId: 'character-a',
        chatId: 'chat-a',
        attemptedGenerationSettings: { agentPresetId: 'agent-a', promptPresetId: 'prompt-a' },
        generationSettings: {
          agentPresetId: 'agent-a',
          promptPresetId: 'prompt-a',
          sidebarToggles: { private: 'private generation toggle' },
        },
      }),
    ).toBe(true)
    expect(getReaderModuleDisplayDatabase()).toMatchObject({
      promptPresets: [{ id: 'prompt-a', moduleIntergration: 'accepted-prompt' }],
      agentPresets: [{ id: 'agent-a', moduleIntergration: 'accepted-agent' }],
    })
    expect(getReaderTranscriptCharacters()[0].chats[0].generationSettings).toEqual({
      agentPresetId: 'agent-a',
      promptPresetId: 'prompt-a',
    })
    expect(settingsResourceState.value.agentPresets![0].moduleIntergration).toBe('newer-pending-agent')
    expect(collectionsResourceState.values.promptPresets![0].moduleIntergration).toBe('newer-pending-prompt')
  })

  it('keeps certified module values until compact receipts receive sufficiently new authoritative reads', () => {
    setManagedWriterForTest()
    replaceResourceDatabase(
      {
        characters: [],
        modules: [{ id: 'module-a', name: 'Module A', description: '', backgroundEmbedding: 'Before' }],
        enabledModules: ['module-a'],
        promptPresets: [],
      } as never,
      3,
    )
    collectionsResourceState.values.modules![0].backgroundEmbedding = 'Newer pending background'
    settingsResourceState.value.enabledModules = ['newer-pending-module']
    expect(applyModuleCollectionMutationLocalEffect({ revision: 4, operation: 'update', moduleId: 'module-a' })).toBe(
      true,
    )
    expect(applyModuleEnabledLocalEffect({ revision: 5, moduleId: 'module-a', enabled: false })).toBe(true)
    demoteClientSession()
    expect(isReaderModuleReadRequired('modules')).toBe(true)
    expect(isReaderModuleReadRequired('enabledModules')).toBe(true)
    expect(getReaderModuleDisplayDatabase()).toMatchObject({
      modules: [{ backgroundEmbedding: 'Before' }],
      enabledModules: ['module-a'],
    })
    expect(applySettingsResource({ revision: 4, settings: { enabledModules: ['stale-module'] } })).toBe(true)
    expect(isReaderModuleReadRequired('enabledModules')).toBe(true)
    expect(getReaderModuleDisplayDatabase().enabledModules).toEqual(['module-a'])
    expect(applyCollectionsResource({ revision: 3, collections: { modules: [] } }, 'modules')).toBe(false)
    expect(
      applyCollectionsResource(
        {
          revision: 5,
          collections: {
            modules: [{ id: 'module-a', name: 'Confirmed', description: '', backgroundEmbedding: 'Accepted' }],
          },
        },
        'modules',
      ),
    ).toBe(true)
    expect(
      applySettingsGroupResource({ revision: 5, group: 'modules', settings: { enabledModules: [] } }, [
        'enabledModules',
      ]),
    ).toBe(true)
    expect(isReaderModuleReadRequired('modules')).toBe(false)
    expect(isReaderModuleReadRequired('enabledModules')).toBe(false)
    expect(getReaderModuleDisplayDatabase()).toMatchObject({
      modules: [{ backgroundEmbedding: 'Accepted' }],
      enabledModules: [],
    })
  })

  it('clears module metadata and required reads on authentication or database identity loss', () => {
    for (const clear of [() => requireClientAuthentication(), () => beginClientSession('replacement-session')]) {
      setManagedWriterForTest()
      replaceResourceDatabase(
        {
          characters: [],
          modules: [{ id: 'module-a', name: 'Module', description: '' }],
          enabledModules: ['module-a'],
        } as never,
        1,
      )
      expect(applyModuleCollectionMutationLocalEffect({ revision: 2, operation: 'update', moduleId: 'module-a' })).toBe(
        true,
      )
      clear()
      expect(getReaderModuleDisplayDatabase()).toEqual({
        modules: [],
        promptPresets: [],
        enabledModules: [],
        moduleIntergration: '',
        agentPresets: [],
        agentPresetDefaultId: null,
      })
      expect(isReaderModuleReadRequired('modules')).toBe(false)
    }
  })

  it('certifies folders, pins, order and visual settings without optimistic or prompt fields', () => {
    setManagedWriterForTest()
    const row = characterRow()
    row.chatFolders = [{ id: 'folder-a', name: 'Confirmed folder', color: 'blue', folded: true }]
    row.chats[0].folderId = 'folder-a'
    row.chats[0].pinned = true
    row.backgroundHTML = '<p>Confirmed background</p>'
    applyRows([row], 1)
    const order = [{ id: 'characters', name: 'Confirmed group', data: ['character-a'], color: 'green' }]
    expect(applyCharacterOrderResource({ revision: 2, characterOrder: order })).toBe(true)
    expect(
      applySettingsResource({
        revision: 2,
        settings: {
          theme: 'waifu',
          customFont: 'serif',
          zoomsize: 115,
          desktopSidebarColumns: 4,
          mobileSidebarColumns: 2,
          translatorPrompt: 'private',
        },
      }),
    ).toBe(true)
    order[0].name = 'Changed caller input'
    charactersResourceState.characterOrder = ['optimistic-character']
    charactersResourceState.characters[0].chatFolders[0].name = 'Pending folder'
    charactersResourceState.characters[0].chats[0].pinned = false
    settingsResourceState.value.theme = 'pending-theme'
    demoteClientSession()
    expect(getReaderCharacterOrder()).toMatchObject([{ name: 'Confirmed group', data: ['character-a'] }])
    expect(getReaderTranscriptCharacters()[0]).toMatchObject({
      chatFolders: [{ name: 'Confirmed folder', folded: true }],
      chats: [{ folderId: 'folder-a', pinned: true }],
      backgroundHTML: '<p>Confirmed background</p>',
    })
    expect(getReaderNavigationSettings()).toMatchObject({
      theme: 'waifu',
      customFont: 'serif',
      zoomsize: 115,
      desktopSidebarColumns: 4,
      mobileSidebarColumns: 2,
    })
    expect(getReaderNavigationSettings()).not.toHaveProperty('translatorPrompt')
  })

  it('updates only accepted display fields and order while rejecting older reads and preserving newer drafts', () => {
    applyRows([characterRow()], 1)
    applySettingsResource({ revision: 1, settings: { theme: 'standard', customFont: 'serif' } })
    settingsResourceState.value.theme = 'newer-pending-theme'
    expect(
      applySettingsPatchLocalEffect({
        revision: 3,
        group: 'display',
        attemptedPatch: { theme: 'waifu' },
        settings: { theme: 'waifu' },
      }),
    ).toBe(true)
    expect(applyCharacterOrderLocalEffect({ revision: 3, attemptedOrder: ['character-a'] })).toBe(true)
    expect(applyCharacterOrderResource({ revision: 2, characterOrder: [] })).toBe(false)
    expect(applySettingsResource({ revision: 2, settings: { theme: 'stale' } })).toBe(false)
    expect(getReaderNavigationSettings()).toMatchObject({ theme: 'waifu', customFont: 'serif' })
    expect(settingsResourceState.value.theme).toBe('newer-pending-theme')
    expect(getReaderCharacterOrder()).toEqual(['character-a'])
  })

  it('clears navigation identities and visual values on authentication loss and database replacement', () => {
    setManagedWriterForTest()
    applyRows([characterRow()], 1)
    applySettingsResource({ revision: 1, settings: { theme: 'waifu' } })
    applyCharacterOrderResource({ revision: 1, characterOrder: ['character-a'] })
    requireClientAuthentication()
    expect(getReaderNavigationSettings()).toEqual({})
    expect(getReaderCharacterOrder()).toEqual([])
    setManagedWriterForTest()
    applySettingsResource({ revision: 2, settings: { theme: 'cardboard' } })
    applyCharacterOrderResource({ revision: 2, characterOrder: ['character-a'] })
    const operation = beginClientSession('replacement-reader')
    settleClientReader(operation, { databaseLineage: 'replacement-database', writer: { sessionId: 'other', epoch: 1 } })
    expect(getReaderNavigationSettings()).toEqual({})
    expect(getReaderCharacterOrder()).toEqual([])
    expect(getReaderTranscriptCharacters()).toEqual([])
  })

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
