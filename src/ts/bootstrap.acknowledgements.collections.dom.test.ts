import { bootstrapMocks } from './bootstrap.testSupport'
import { describe, expect, it } from 'vitest'
import { loadWebInitialDatabase } from './bootstrap'
import { peekAppliedServerResourceRevision } from './server/commands'
import {
  applyCollectionsResource,
  applySettingsResource,
  applySettingsGroupResource,
  captureCollectionProjectionEpoch,
  captureLorebookPageProjectionEpoch,
  captureCharacterLorebookProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  captureSettingsGroupProjectionEpoch,
  captureSettingsProjectionEpoch,
  collectionsResourceState,
  hasCollectionProjectionEpochChanged,
  hasLorebookPageProjectionEpochChanged,
  markCollectionAcknowledgementTainted,
  markCharacterLorebookProjectionApplied,
  markSettingsAcknowledgementTainted,
  settingsResourceState,
} from './server/resourceState.svelte'
import { getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

const { resourceApi, commandApi } = bootstrapMocks

describe('API-backed client bootstrap', () => {
  it('acknowledges a contiguous persona PATCH without a collection/settings read or apply-epoch bump', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          personas: [
            {
              id: 'persona-a',
              name: 'Attempted name',
              icon: 'attempted-icon',
              personaPrompt: 'Attempted prompt',
              note: 'Attempted note',
            },
          ] as never,
        },
      },
      'personas',
    )
    withTestDatabaseWrite(() => {
      getDatabase().selectedPersona = 0
      getDatabase().selectedPersonaId = 'persona-a'
      getDatabase().username = 'Attempted name'
      getDatabase().userIcon = 'attempted-icon'
      getDatabase().personaPrompt = 'Attempted prompt'
      getDatabase().userNote = 'Attempted note'
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    withTestDatabaseWrite(() => {
      getDatabase().personas[0].name = 'Newer local name'
      getDatabase().username = 'Newer local name'
    })
    const event = {
      type: 'persona.updated',
      revision: 6,
      resource: 'persona',
      id: 'persona-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'personaPatch',
            personaId: 'persona-a',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            attemptedPatch: { personaPrompt: 'Attempted prompt', note: 'Attempted note' },
            attemptedPersona: {
              id: 'persona-a',
              name: 'Attempted name',
              icon: 'attempted-icon',
              personaPrompt: 'Attempted prompt',
              note: 'Attempted note',
            },
            attemptedLegacyProfile: {
              username: 'Attempted name',
              userIcon: 'attempted-icon',
              personaPrompt: 'Attempted prompt',
              userNote: 'Attempted note',
            },
            legacyProfileProjectionApplied: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().personas[0].name).toBe('Newer local name')
    expect(getDatabase().username).toBe('Newer local name')
    expect(collectionsResourceState.revisions.personas).toBe(6)
    expect(peekAppliedServerResourceRevision()).toBe(6)
  })

  it('coalesces an accepted persona PATCH followed by deletion without a resource read', async () => {
    await loadWebInitialDatabase()
    applyCollectionsResource(
      {
        revision: 5,
        collections: {
          personas: [{ id: 'persona-b', name: 'B', icon: '', personaPrompt: 'B', note: '' }] as never,
        },
      },
      'personas',
    )
    withTestDatabaseWrite(() => {
      getDatabase().selectedPersona = 0
      getDatabase().selectedPersonaId = 'persona-b'
      getDatabase().username = 'B'
      getDatabase().userIcon = ''
      getDatabase().personaPrompt = 'B'
      getDatabase().userNote = ''
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
    const settingsProjectionEpoch = captureSettingsProjectionEpoch()
    const patchEvent = {
      type: 'persona.updated',
      revision: 6,
      resource: 'persona',
      id: 'persona-a',
    }
    const deleteEvent = {
      type: 'persona.deleted',
      revision: 7,
      resource: 'persona',
      id: 'persona-a',
    }

    await commandApi.reconciler?.(
      deleteEvent,
      [patchEvent, deleteEvent],
      new Map([
        [
          6,
          {
            kind: 'personaPatch',
            personaId: 'persona-a',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            attemptedPatch: { name: 'Edited A' },
            attemptedPersona: {
              id: 'persona-a',
              name: 'Edited A',
              icon: '',
              personaPrompt: 'A',
              note: '',
            },
            attemptedLegacyProfile: {
              username: 'Edited A',
              userIcon: '',
              personaPrompt: 'A',
              userNote: '',
            },
            legacyProfileProjectionApplied: true,
          },
        ],
        [
          7,
          {
            kind: 'personaMutation',
            operation: 'delete',
            targetPersonaId: 'persona-a',
            collectionProjectionEpoch,
            settingsProjectionEpoch,
            collectionWritten: true,
            settingsWritten: true,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().personas).toEqual([expect.objectContaining({ id: 'persona-b', name: 'B' })])
    expect(getDatabase().username).toBe('B')
    expect(collectionsResourceState.revisions.personas).toBe(7)
    expect(settingsResourceState.fullRevision).toBe(7)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it.each(['collection epoch', 'settings epoch', 'collection taint', 'settings taint'])(
    '%s forces a persona PATCH authoritative fallback',
    async (failure) => {
      await loadWebInitialDatabase()
      const persona = {
        id: 'persona-a',
        name: 'Attempted',
        icon: '',
        personaPrompt: '',
        note: '',
      }
      applyCollectionsResource({ revision: 5, collections: { personas: [persona] as never } }, 'personas')
      withTestDatabaseWrite(() => {
        getDatabase().selectedPersona = 0
        getDatabase().selectedPersonaId = 'persona-a'
        getDatabase().username = 'Attempted'
        getDatabase().userIcon = ''
        getDatabase().personaPrompt = ''
        getDatabase().userNote = ''
      })
      const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
      const settingsProjectionEpoch = captureSettingsProjectionEpoch()
      if (failure === 'collection epoch') {
        applyCollectionsResource({ revision: 5, collections: { personas: [persona] as never } }, 'personas')
      } else if (failure === 'settings epoch') {
        applySettingsResource({ revision: 5, settings: { username: 'Attempted' } })
      } else if (failure === 'collection taint') {
        markCollectionAcknowledgementTainted('personas')
      } else {
        markSettingsAcknowledgementTainted()
      }
      const event = {
        type: 'persona.updated',
        revision: 6,
        resource: 'persona',
        id: 'persona-a',
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'personaPatch',
              personaId: 'persona-a',
              collectionProjectionEpoch,
              settingsProjectionEpoch,
              attemptedPatch: { name: 'Attempted' },
              attemptedPersona: persona,
              attemptedLegacyProfile: {
                username: 'Attempted',
                userIcon: '',
                personaPrompt: '',
                userNote: '',
              },
              legacyProfileProjectionApplied: true,
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

  it.each([
    ['create', 'persona.created', 'persona-b', true, true],
    ['delete', 'persona.deleted', 'persona-a', true, true],
    ['select', 'persona.selected', 'persona-b', false, true],
    ['reorder', 'persona.reordered', undefined, true, true],
  ] as const)(
    'acknowledges a contiguous persona %s without collection/settings reads',
    async (operation, eventType, targetPersonaId, collectionWritten, settingsWritten) => {
      await loadWebInitialDatabase()
      applyCollectionsResource(
        {
          revision: 5,
          collections: {
            personas: [
              { id: 'persona-a', name: 'Newer A', icon: '', personaPrompt: 'A', note: '' },
              { id: 'persona-b', name: 'Newer B', icon: '', personaPrompt: 'B', note: '' },
            ] as never,
          },
        },
        'personas',
      )
      withTestDatabaseWrite(() => {
        getDatabase().selectedPersona = 1
        getDatabase().selectedPersonaId = 'persona-b'
        getDatabase().username = 'Newer B'
        getDatabase().userIcon = ''
        getDatabase().personaPrompt = 'Newer B prompt'
        getDatabase().userNote = 'Newer B note'
      })
      const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
      const settingsProjectionEpoch = captureSettingsProjectionEpoch()
      const event = {
        type: eventType,
        revision: 6,
        resource: 'persona',
        ...(targetPersonaId ? { id: targetPersonaId } : {}),
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'personaMutation',
              operation,
              targetPersonaId: targetPersonaId ?? null,
              collectionProjectionEpoch,
              settingsProjectionEpoch,
              collectionWritten,
              settingsWritten,
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
      expect(collectionsResourceState.revisions.personas).toBe(collectionWritten ? 6 : 5)
      expect(settingsResourceState.fullRevision).toBe(settingsWritten ? 6 : 5)
      expect(getDatabase().personas).toEqual([
        expect.objectContaining({ id: 'persona-a', name: 'Newer A' }),
        expect.objectContaining({ id: 'persona-b', name: 'Newer B' }),
      ])
      expect(getDatabase().username).toBe('Newer B')
      expect(peekAppliedServerResourceRevision()).toBe(6)
    },
  )

  it.each(['collection epoch', 'settings epoch', 'collection taint', 'settings taint', 'event identity'])(
    '%s forces a structural persona acknowledgement fallback',
    async (failure) => {
      await loadWebInitialDatabase()
      const personas = [
        { id: 'persona-a', name: 'A', icon: '', personaPrompt: 'A', note: '' },
        { id: 'persona-b', name: 'B', icon: '', personaPrompt: 'B', note: '' },
      ]
      applyCollectionsResource({ revision: 5, collections: { personas: personas as never } }, 'personas')
      withTestDatabaseWrite(() => {
        getDatabase().selectedPersona = 1
        getDatabase().selectedPersonaId = 'persona-b'
        getDatabase().username = 'B'
        getDatabase().userIcon = ''
        getDatabase().personaPrompt = 'B'
        getDatabase().userNote = ''
      })
      const collectionProjectionEpoch = captureCollectionProjectionEpoch('personas')
      const settingsProjectionEpoch = captureSettingsProjectionEpoch()
      if (failure === 'collection epoch') {
        applyCollectionsResource({ revision: 5, collections: { personas: personas as never } }, 'personas')
      } else if (failure === 'settings epoch') {
        applySettingsResource({
          revision: 5,
          settings: {
            selectedPersona: 1,
            selectedPersonaId: 'persona-b',
            username: 'B',
            userIcon: '',
            personaPrompt: 'B',
            userNote: '',
          },
        })
      } else if (failure === 'collection taint') {
        markCollectionAcknowledgementTainted('personas')
      } else if (failure === 'settings taint') {
        markSettingsAcknowledgementTainted()
      }
      const event = {
        type: 'persona.selected',
        revision: 6,
        resource: failure === 'event identity' ? 'settings' : 'persona',
        id: 'persona-b',
      }

      await commandApi.reconciler?.(
        event,
        [event],
        new Map([
          [
            6,
            {
              kind: 'personaMutation',
              operation: 'select',
              targetPersonaId: 'persona-b',
              collectionProjectionEpoch,
              settingsProjectionEpoch,
              collectionWritten: false,
              settingsWritten: true,
            },
          ],
        ]),
      )

      expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
        appliedRevision: 5,
        hooks: resourceApi.hooks,
      })
    },
  )

  it('acknowledges contiguous scoped lorebook mutations without replacing newer optimistic entries', async () => {
    await loadWebInitialDatabase()
    const entry = (id: string, content: string) => ({
      id,
      key: id,
      secondkey: '',
      insertorder: 100,
      comment: id,
      content,
      mode: 'normal' as const,
      alwaysActive: false,
      selective: false,
    })
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [
        { id: 'book-a', name: 'Book A', data: [entry('global-entry', 'global newer')] },
      ] as never
      getDatabase().characters[0].globalLore = [entry('character-entry', 'character newer')]
      getDatabase().characters[0].chats[0].localLore = [entry('chat-entry', 'chat newer')]
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
    const characterRowProjectionEpoch = captureCharacterRowProjectionEpoch('char-a')
    const characterLorebookProjectionEpoch = captureCharacterLorebookProjectionEpoch('char-a')
    const globalEvent = {
      type: 'lorebook.entries.replaced',
      revision: 6,
      resource: 'globalLorebook',
      id: 'book-a',
    }
    const characterEvent = {
      type: 'lorebook.entries.replaced',
      revision: 7,
      resource: 'characterLorebook',
      id: 'char-a',
    }
    const chatEvent = {
      type: 'lorebook.entries.replaced',
      revision: 8,
      resource: 'characterRow',
      id: 'chat-a',
      parentId: 'char-a',
    }

    await commandApi.reconciler?.(
      chatEvent,
      [globalEvent, characterEvent, chatEvent],
      new Map([
        [
          6,
          {
            kind: 'lorebookMutation',
            scope: 'global',
            operation: 'upsert',
            lorebookId: 'book-a',
            collectionProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'lorebookMutation',
            scope: 'character',
            operation: 'replace',
            characterId: 'char-a',
            characterRowProjectionEpoch,
            characterLorebookProjectionEpoch,
          },
        ],
        [
          8,
          {
            kind: 'lorebookMutation',
            scope: 'chat',
            operation: 'reorder',
            characterId: 'char-a',
            chatId: 'chat-a',
            characterRowProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loreBook[0].data[0].content).toBe('global newer')
    expect(getDatabase().characters[0].globalLore[0].content).toBe('character newer')
    expect(getDatabase().characters[0].chats[0].localLore[0].content).toBe('chat newer')
    expect(peekAppliedServerResourceRevision()).toBe(8)
  })

  it('acknowledges contiguous top-level lorebook mutations without re-reading collection or settings', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [
        { id: 'book-b', name: 'Newer B', data: [] },
        { id: 'book-c', name: 'Newer C', data: [] },
      ] as never
      getDatabase().loreBookPage = 0
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
    const pageProjectionEpoch = captureLorebookPageProjectionEpoch()
    const events = [
      { type: 'lorebook.created', revision: 6, resource: 'globalLorebook', id: 'book-c' },
      { type: 'lorebook.updated', revision: 7, resource: 'globalLorebook', id: 'book-b' },
      { type: 'lorebook.selected', revision: 8, resource: 'globalLorebook', id: 'book-c' },
      { type: 'lorebook.reordered', revision: 9, resource: 'globalLorebook' },
      { type: 'lorebook.deleted', revision: 10, resource: 'globalLorebook', id: 'book-a' },
    ]

    await commandApi.reconciler?.(
      events.at(-1),
      events,
      new Map([
        [
          6,
          {
            kind: 'globalLorebookMutation',
            operation: 'create',
            lorebookId: 'book-c',
            collectionProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'globalLorebookMutation',
            operation: 'update',
            lorebookId: 'book-b',
            collectionProjectionEpoch,
          },
        ],
        [
          8,
          {
            kind: 'globalLorebookMutation',
            operation: 'select',
            lorebookId: 'book-c',
            selectedLorebookId: 'book-c',
            pageProjectionEpoch,
          },
        ],
        [
          9,
          {
            kind: 'globalLorebookMutation',
            operation: 'reorder',
            lorebookIds: ['book-b', 'book-c'],
            selectedLorebookId: 'book-b',
            collectionProjectionEpoch,
            pageProjectionEpoch,
          },
        ],
        [
          10,
          {
            kind: 'globalLorebookMutation',
            operation: 'delete',
            lorebookId: 'book-a',
            collectionProjectionEpoch,
            pageProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loreBook).toEqual([
      { id: 'book-b', name: 'Newer B', data: [] },
      { id: 'book-c', name: 'Newer C', data: [] },
    ])
    expect(getDatabase().loreBookPage).toBe(0)
    expect(hasCollectionProjectionEpochChanged('loreBook', collectionProjectionEpoch)).toBe(false)
    expect(hasLorebookPageProjectionEpochChanged(pageProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(10)
  })

  it('falls back when an authoritative lorebook collection supersedes a top-level local effect', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [{ id: 'book-a', name: 'Book A', data: [] }] as never
      getDatabase().loreBookPage = 0
    })
    const collectionProjectionEpoch = captureCollectionProjectionEpoch('loreBook')
    applyCollectionsResource(
      {
        revision: 6,
        collections: { loreBook: [{ id: 'book-a', name: 'Projected A', data: [] }] as never },
      },
      'loreBook',
    )
    const event = { type: 'lorebook.updated', revision: 6, resource: 'globalLorebook', id: 'book-a' }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'globalLorebookMutation',
            operation: 'update',
            lorebookId: 'book-a',
            collectionProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('falls back when authoritative settings supersede a top-level lorebook page effect', async () => {
    await loadWebInitialDatabase()
    withTestDatabaseWrite(() => {
      getDatabase().loreBook = [
        { id: 'book-a', name: 'Book A', data: [] },
        { id: 'book-b', name: 'Book B', data: [] },
      ] as never
      getDatabase().loreBookPage = 1
    })
    const pageProjectionEpoch = captureLorebookPageProjectionEpoch()
    applySettingsResource({ revision: 6, settings: { loreBookPage: 0 } })
    const event = { type: 'lorebook.selected', revision: 6, resource: 'globalLorebook', id: 'book-b' }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'globalLorebookMutation',
            operation: 'select',
            lorebookId: 'book-b',
            selectedLorebookId: 'book-b',
            pageProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('falls back when a dedicated character-lorebook projection supersedes an optimistic effect', async () => {
    await loadWebInitialDatabase()
    const characterRowProjectionEpoch = captureCharacterRowProjectionEpoch('char-a')
    const characterLorebookProjectionEpoch = captureCharacterLorebookProjectionEpoch('char-a')
    markCharacterLorebookProjectionApplied('char-a')
    const event = {
      type: 'lorebook.entries.replaced',
      revision: 6,
      resource: 'characterLorebook',
      id: 'char-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'lorebookMutation',
            scope: 'character',
            operation: 'upsert',
            characterId: 'char-a',
            characterRowProjectionEpoch,
            characterLorebookProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges contiguous optimistic loadout create and delete without resource reads', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    withTestDatabaseWrite(() => {
      getDatabase().loadouts = [
        {
          ...getDatabase().loadouts[0],
          id: 'loadout-b',
          name: 'Created Loadout',
        },
      ]
    })
    const createEvent = {
      type: 'loadout.created',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-b',
    }
    const deleteEvent = {
      type: 'loadout.deleted',
      revision: 7,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      deleteEvent,
      [createEvent, deleteEvent],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'create',
            loadoutId: 'loadout-b',
            loadoutsProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'loadoutMutation',
            operation: 'delete',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loadouts).toEqual([expect.objectContaining({ id: 'loadout-b', name: 'Created Loadout' })])
    expect(hasCollectionProjectionEpochChanged('loadouts', loadoutsProjectionEpoch)).toBe(false)
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('falls back when the loadout collection epoch changes before a create/delete acknowledgement', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    applyCollectionsResource(
      {
        revision: 6,
        collections: {
          loadouts: [
            {
              ...getDatabase().loadouts[0],
              name: 'Authoritative Loadout',
            },
          ],
        },
      },
      'loadouts',
    )
    const event = {
      type: 'loadout.deleted',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'delete',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })

  it('acknowledges contiguous optimistic loadout favorite and touch without resource reads', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('sidebar')
    withTestDatabaseWrite(() => {
      const loadout = getDatabase().loadouts[0]
      loadout.favorite = false
      loadout.lastUsed = 300
      loadout.characterIds.push('char-b')
      getDatabase().lastLoadedLoadoutName = 'Newer loaded name'
    })
    const favoriteEvent = {
      type: 'loadout.favorited',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-a',
    }
    const touchEvent = {
      type: 'loadout.touched',
      revision: 7,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      touchEvent,
      [favoriteEvent, touchEvent],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'favorite',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
          },
        ],
        [
          7,
          {
            kind: 'loadoutMutation',
            operation: 'touch',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
            settingsProjectionEpoch,
            loadedName: 'Loadout A',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).not.toHaveBeenCalled()
    expect(getDatabase().loadouts[0]).toMatchObject({
      favorite: false,
      lastUsed: 300,
      characterIds: ['char-a', 'char-b'],
    })
    expect(getDatabase().lastLoadedLoadoutName).toBe('Newer loaded name')
    expect(peekAppliedServerResourceRevision()).toBe(7)
  })

  it('falls back when a targeted projection changes before a loadout acknowledgement', async () => {
    await loadWebInitialDatabase()
    const loadoutsProjectionEpoch = captureCollectionProjectionEpoch('loadouts')
    const settingsProjectionEpoch = captureSettingsGroupProjectionEpoch('sidebar')
    applyCollectionsResource(
      {
        revision: 6,
        collections: {
          loadouts: [
            {
              ...getDatabase().loadouts[0],
              favorite: true,
            },
          ],
        },
      },
      'loadouts',
    )
    applySettingsGroupResource(
      { revision: 6, group: 'sidebar', settings: { lastLoadedLoadoutName: 'Authoritative' } },
      ['lastLoadedLoadoutName'],
    )
    const event = {
      type: 'loadout.touched',
      revision: 6,
      resource: 'loadout',
      id: 'loadout-a',
    }

    await commandApi.reconciler?.(
      event,
      [event],
      new Map([
        [
          6,
          {
            kind: 'loadoutMutation',
            operation: 'touch',
            loadoutId: 'loadout-a',
            loadoutsProjectionEpoch,
            settingsProjectionEpoch,
            loadedName: 'Loadout A',
          },
        ],
      ]),
    )

    expect(resourceApi.refreshInvalidated).toHaveBeenCalledWith([event], {
      appliedRevision: 5,
      hooks: resourceApi.hooks,
    })
  })
})
