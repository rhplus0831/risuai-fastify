import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  createGlobalLorebookCommand,
  deleteCharacterLorebookEntryCommand,
  deleteChatLorebookEntryCommand,
  deleteGlobalLorebookCommand,
  deleteGlobalLorebookEntryCommand,
  deleteModuleLorebookEntryCommand,
  reorderGlobalLorebooksCommand,
  reorderCharacterLorebookEntriesCommand,
  reorderChatLorebookEntriesCommand,
  reorderGlobalLorebookEntriesCommand,
  reorderModuleLorebookEntriesCommand,
  replaceCharacterLorebooksCommand,
  replaceChatLorebooksCommand,
  replaceGlobalLorebookEntriesCommand,
  replaceModuleLorebooksCommand,
  selectGlobalLorebookCommand,
  updateGlobalLorebookCommand,
  upsertCharacterLorebookEntryCommand,
  upsertChatLorebookEntryCommand,
  upsertGlobalLorebookEntryCommand,
  upsertModuleLorebookEntryCommand,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'

describe('lorebook command adapters', () => {
  it('dispatches lorebook commands through typed helpers', async () => {
    const commandFetch = makeCommandFetch((url) => {
      if (
        url.includes('/lorebooks') ||
        url.includes('/characters/') ||
        url.includes('/chats/') ||
        url.includes('/modules/')
      ) {
        return {
          revision: 9,
          event: {
            type: 'lorebook.entries.replaced',
            revision: 9,
            resource: 'lorebook',
          },
          lorebookId: 'book-a',
          characterId: 'char-a',
          chatId: 'chat-a',
          moduleId: 'mod-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'body',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }

    await createGlobalLorebookCommand({
      baseRevision: 1,
      lorebook: { id: 'book-a', name: 'A', data: [] },
    })
    await updateGlobalLorebookCommand({
      baseRevision: 2,
      lorebookId: 'book-a',
      patch: { name: 'Renamed' },
    })
    await deleteGlobalLorebookCommand({ baseRevision: 3, lorebookId: 'book-a' })
    await reorderGlobalLorebooksCommand({ baseRevision: 4, lorebookIds: ['book-a'] })
    await selectGlobalLorebookCommand({ baseRevision: 5, lorebookId: 'book-a' })
    await replaceGlobalLorebookEntriesCommand({
      baseRevision: 6,
      lorebookId: 'book-a',
      entries: [entry],
    })
    await replaceCharacterLorebooksCommand({
      baseRevision: 7,
      characterId: 'char-a',
      entries: [entry],
    })
    await replaceChatLorebooksCommand({ baseRevision: 8, chatId: 'chat-a', entries: [entry] })
    await replaceModuleLorebooksCommand({ baseRevision: 9, moduleId: 'mod-a', entries: [entry] })
    await upsertGlobalLorebookEntryCommand({
      baseRevision: 10,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry,
    })
    await upsertCharacterLorebookEntryCommand({
      baseRevision: 11,
      characterId: 'char-a',
      entryId: 'entry-a',
      entry,
    })
    await upsertChatLorebookEntryCommand({
      baseRevision: 12,
      chatId: 'chat-a',
      entryId: 'entry-a',
      entry,
    })
    await upsertModuleLorebookEntryCommand({
      baseRevision: 13,
      moduleId: 'mod-a',
      entryId: 'entry-a',
      entry,
    })
    await deleteGlobalLorebookEntryCommand({ baseRevision: 14, lorebookId: 'book-a', entryId: 'entry-a' })
    await deleteCharacterLorebookEntryCommand({ baseRevision: 15, characterId: 'char-a', entryId: 'entry-a' })
    await deleteChatLorebookEntryCommand({ baseRevision: 16, chatId: 'chat-a', entryId: 'entry-a' })
    await deleteModuleLorebookEntryCommand({ baseRevision: 17, moduleId: 'mod-a', entryId: 'entry-a' })
    await reorderGlobalLorebookEntriesCommand({
      baseRevision: 18,
      lorebookId: 'book-a',
      entryIds: ['entry-b', 'entry-a'],
    })
    await reorderCharacterLorebookEntriesCommand({
      baseRevision: 19,
      characterId: 'char-a',
      entryIds: ['entry-b', 'entry-a'],
    })
    await reorderChatLorebookEntriesCommand({
      baseRevision: 20,
      chatId: 'chat-a',
      entryIds: ['entry-b', 'entry-a'],
    })
    await reorderModuleLorebookEntriesCommand({
      baseRevision: 21,
      moduleId: 'mod-a',
      entryIds: ['entry-b', 'entry-a'],
    })

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/lorebooks',
        method: 'POST',
        body: { baseRevision: 1, lorebook: { id: 'book-a', name: 'A', data: [] } },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a',
        method: 'PATCH',
        body: { baseRevision: 2, patch: { name: 'Renamed' } },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a',
        method: 'DELETE',
        body: { baseRevision: 3 },
      },
      {
        url: '/api/v1/commands/lorebooks/reorder',
        method: 'POST',
        body: { baseRevision: 4, lorebookIds: ['book-a'] },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/select',
        method: 'POST',
        body: { baseRevision: 5 },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries',
        method: 'PUT',
        body: { baseRevision: 6, entries: [entry] },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks',
        method: 'PUT',
        body: { baseRevision: 7, entries: [entry] },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks',
        method: 'PUT',
        body: { baseRevision: 8, entries: [entry] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks',
        method: 'PUT',
        body: { baseRevision: 9, entries: [entry] },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 10, entry },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 11, entry },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 12, entry },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks/entries/entry-a',
        method: 'PUT',
        body: { baseRevision: 13, entry },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 14 },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 15 },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 16 },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks/entries/entry-a',
        method: 'DELETE',
        body: { baseRevision: 17 },
      },
      {
        url: '/api/v1/commands/lorebooks/book-a/entries/reorder',
        method: 'POST',
        body: { baseRevision: 18, entryIds: ['entry-b', 'entry-a'] },
      },
      {
        url: '/api/v1/commands/characters/char-a/lorebooks/entries/reorder',
        method: 'POST',
        body: { baseRevision: 19, entryIds: ['entry-b', 'entry-a'] },
      },
      {
        url: '/api/v1/commands/chats/chat-a/lorebooks/entries/reorder',
        method: 'POST',
        body: { baseRevision: 20, entryIds: ['entry-b', 'entry-a'] },
      },
      {
        url: '/api/v1/commands/modules/mod-a/lorebooks/entries/reorder',
        method: 'POST',
        body: { baseRevision: 21, entryIds: ['entry-b', 'entry-a'] },
      },
    ])
  })

  it('sends sparse lorebook entry patches in every scope and accepts only exact compact receipts', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 30
    const commandFetch = makeCommandFetch((url) => {
      revision += 1
      const scope = url.includes('/characters/')
        ? 'character'
        : url.includes('/chats/')
          ? 'chat'
          : url.includes('/modules/')
            ? 'module'
            : 'global'
      const id =
        scope === 'character' ? 'char-a' : scope === 'chat' ? 'chat-a' : scope === 'module' ? 'mod-a' : 'book-a'
      return {
        revision,
        event: {
          type: 'lorebook.entries.replaced',
          revision,
          resource:
            scope === 'character'
              ? 'characterLorebook'
              : scope === 'chat'
                ? 'characterRow'
                : scope === 'module'
                  ? 'moduleUpdated'
                  : 'globalLorebook',
          id,
          ...(scope === 'chat' ? { parentId: 'char-a' } : {}),
        },
        ...(scope === 'character'
          ? { characterId: id }
          : scope === 'chat'
            ? { chatId: id }
            : scope === 'module'
              ? { moduleId: id }
              : { lorebookId: id }),
        entryId: 'entry-a',
        entryIndex: 0,
        created: false,
        patchedKeys: ['content', 'nullableExtension'],
        deletedKeys: ['activationPercent'],
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'edited',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
      nullableExtension: null,
    }
    const sparseUpdate = {
      patch: { content: 'edited', nullableExtension: null },
      deleteKeys: ['activationPercent'],
    }

    await upsertGlobalLorebookEntryCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertCharacterLorebookEntryCommand({
      baseRevision: 2,
      characterId: 'char-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticRowEpoch: 2,
      optimisticLorebookEpoch: 3,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertChatLorebookEntryCommand({
      baseRevision: 3,
      chatId: 'chat-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticCharacterId: 'char-a',
      optimisticRowEpoch: 4,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertModuleLorebookEntryCommand(
      { baseRevision: 4, moduleId: 'mod-a', entryId: 'entry-a', entry, sparseUpdate },
      null,
      false,
      true,
    )

    expect(commandFetch.calls.map(({ body }) => body)).toEqual([
      { baseRevision: 1, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
      { baseRevision: 2, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
      { baseRevision: 3, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
      { baseRevision: 4, patch: sparseUpdate.patch, deleteKeys: sparseUpdate.deleteKeys },
    ])
    for (const call of commandFetch.calls) {
      expect(call.body).not.toHaveProperty('entry')
      expect(call.body).not.toHaveProperty('optimisticEntries')
    }
    expect(observedEffects).toEqual([
      {
        kind: 'lorebookMutation',
        scope: 'global',
        operation: 'upsert',
        lorebookId: 'book-a',
        collectionProjectionEpoch: 1,
      },
      {
        kind: 'lorebookMutation',
        scope: 'character',
        operation: 'upsert',
        characterId: 'char-a',
        characterRowProjectionEpoch: 2,
        characterLorebookProjectionEpoch: 3,
      },
      {
        kind: 'lorebookMutation',
        scope: 'chat',
        operation: 'upsert',
        characterId: 'char-a',
        chatId: 'chat-a',
        characterRowProjectionEpoch: 4,
      },
      { kind: 'moduleCollectionMutation', operation: 'lorebooks', moduleId: 'mod-a' },
    ])
  })

  it('withholds sparse lorebook local effects for mismatched or create receipts', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let call = 0
    const commandFetch = makeCommandFetch((url) => {
      call += 1
      const module = url.includes('/modules/')
      return {
        revision: 40 + call,
        event: {
          type: 'lorebook.entries.replaced',
          revision: 40 + call,
          resource: module ? 'moduleUpdated' : 'globalLorebook',
          id: module ? 'mod-a' : 'book-a',
        },
        ...(module ? { moduleId: 'mod-a' } : { lorebookId: 'book-a' }),
        entryId: 'entry-a',
        entryIndex: 0,
        created: module,
        patchedKeys: module ? ['content'] : [],
        deletedKeys: [],
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)
    const entry = {
      id: 'entry-a',
      key: 'key',
      secondkey: '',
      insertorder: 100,
      comment: 'Lore',
      content: 'edited',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const sparseUpdate = { patch: { content: 'edited' } }

    await upsertGlobalLorebookEntryCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry,
      sparseUpdate,
      optimisticEntries: [entry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: false,
    })
    await upsertModuleLorebookEntryCommand(
      { baseRevision: 2, moduleId: 'mod-a', entryId: 'entry-a', entry, sparseUpdate },
      null,
      false,
      true,
    )

    expect(observedEffects).toEqual([])
  })

  it('emits strict opt-in local effects for top-level lorebook mutations without sending acknowledgement metadata', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 20
    const commandFetch = makeCommandFetch((url, init) => {
      revision += 1
      if (url.endsWith('/lorebooks/reorder')) {
        return {
          revision,
          event: { type: 'lorebook.reordered', revision, resource: 'globalLorebook' },
          selectedLorebookId: 'book-b',
        }
      }
      if (url.endsWith('/lorebooks/book-b/select')) {
        return {
          revision,
          event: { type: 'lorebook.selected', revision, resource: 'globalLorebook', id: 'book-b' },
          selectedLorebookId: 'book-b',
        }
      }
      const operation = url.endsWith('/lorebooks') ? 'created' : init.method === 'PATCH' ? 'updated' : 'deleted'
      const lorebookId = operation === 'created' ? 'book-c' : 'book-a'
      return {
        revision,
        event: { type: `lorebook.${operation}`, revision, resource: 'globalLorebook', id: lorebookId },
        lorebookId,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const canonicalEntry = {
      id: 'entry-a',
      key: 'a',
      secondkey: '',
      insertorder: 100,
      comment: 'A',
      content: 'A',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await createGlobalLorebookCommand({
      baseRevision: 1,
      lorebook: { id: 'book-c', name: 'Book C', data: [canonicalEntry] },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 11,
    })
    await updateGlobalLorebookCommand({
      baseRevision: 2,
      lorebookId: 'book-a',
      patch: { name: 'Renamed A' },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 12,
    })
    await deleteGlobalLorebookCommand({
      baseRevision: 3,
      lorebookId: 'book-a',
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 13,
      optimisticPageEpoch: 14,
    })
    await reorderGlobalLorebooksCommand({
      baseRevision: 4,
      lorebookIds: ['book-b', 'book-a'],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 15,
      optimisticPageEpoch: 16,
      optimisticSelectedLorebookId: 'book-b',
    })
    await selectGlobalLorebookCommand({
      baseRevision: 5,
      lorebookId: 'book-b',
      acknowledgeOptimistic: true,
      optimisticPageEpoch: 17,
    })

    expect(observedEffects).toEqual([
      {
        kind: 'globalLorebookMutation',
        operation: 'create',
        lorebookId: 'book-c',
        collectionProjectionEpoch: 11,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'update',
        lorebookId: 'book-a',
        collectionProjectionEpoch: 12,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'delete',
        lorebookId: 'book-a',
        collectionProjectionEpoch: 13,
        pageProjectionEpoch: 14,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'reorder',
        lorebookIds: ['book-b', 'book-a'],
        selectedLorebookId: 'book-b',
        collectionProjectionEpoch: 15,
        pageProjectionEpoch: 16,
      },
      {
        kind: 'globalLorebookMutation',
        operation: 'select',
        lorebookId: 'book-b',
        selectedLorebookId: 'book-b',
        pageProjectionEpoch: 17,
      },
    ])
    expect(commandFetch.calls.map((call) => call.body)).toEqual([
      { baseRevision: 1, lorebook: { id: 'book-c', name: 'Book C', data: [canonicalEntry] } },
      { baseRevision: 2, patch: { name: 'Renamed A' } },
      { baseRevision: 3 },
      { baseRevision: 4, lorebookIds: ['book-b', 'book-a'] },
      { baseRevision: 5 },
    ])
  })

  it('keeps noncanonical or mismatched top-level lorebook acknowledgements authoritative', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let call = 0
    const commandFetch = makeCommandFetch((url, init) => {
      call += 1
      if (url.endsWith('/reorder')) {
        return {
          revision: 30 + call,
          event: { type: 'lorebook.reordered', revision: 30 + call, resource: 'globalLorebook' },
          selectedLorebookId: call === 5 ? 'book-a' : 'book-b',
        }
      }
      const operation = url.endsWith('/lorebooks') ? 'created' : init.method === 'PATCH' ? 'updated' : 'selected'
      const id = operation === 'created' ? 'book-c' : 'book-a'
      return {
        revision: 30 + call,
        event: {
          type: `lorebook.${operation}`,
          revision: 30 + call,
          resource: 'globalLorebook',
          id,
          ...(call === 6 ? { parentId: 'unexpected-parent' } : {}),
        },
        lorebookId: id,
        selectedLorebookId: id,
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await createGlobalLorebookCommand({
      baseRevision: 1,
      lorebook: { id: 'book-c', name: 'Book C', data: [] },
    })
    await createGlobalLorebookCommand({
      baseRevision: 2,
      lorebook: { id: 'book-c', name: '', data: [] },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
    })
    await updateGlobalLorebookCommand({
      baseRevision: 3,
      lorebookId: 'book-a',
      patch: { name: '' },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
    })
    await reorderGlobalLorebooksCommand({
      baseRevision: 4,
      lorebookIds: ['book-a', 'book-a'],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticPageEpoch: 2,
      optimisticSelectedLorebookId: 'book-a',
    })
    await reorderGlobalLorebooksCommand({
      baseRevision: 5,
      lorebookIds: ['book-a', 'book-b'],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticPageEpoch: 2,
      optimisticSelectedLorebookId: 'book-b',
    })
    await selectGlobalLorebookCommand({
      baseRevision: 6,
      lorebookId: 'book-a',
      acknowledgeOptimistic: true,
      optimisticPageEpoch: 2,
    })

    expect(observedEffects).toEqual([])
  })

  it('emits strict opt-in local effects for scoped lorebook replace and entry deltas', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    let revision = 30
    const commandFetch = makeCommandFetch((url, init) => {
      revision += 1
      const scope = url.includes('/characters/') ? 'character' : url.includes('/chats/') ? 'chat' : 'global'
      const targetId = scope === 'character' ? 'char-a' : scope === 'chat' ? 'chat-a' : 'book-a'
      const targetKey = scope === 'character' ? 'characterId' : scope === 'chat' ? 'chatId' : 'lorebookId'
      const entryMutation = url.includes('/entries/entry-b') && !url.endsWith('/reorder')
      return {
        revision,
        event: {
          type: 'lorebook.entries.replaced',
          revision,
          resource: scope === 'character' ? 'characterLorebook' : scope === 'chat' ? 'characterRow' : 'globalLorebook',
          id: targetId,
          ...(scope === 'chat' ? { parentId: 'char-a' } : {}),
        },
        [targetKey]: targetId,
        ...(entryMutation
          ? {
              entryId: 'entry-b',
              entryIndex: 1,
              ...(init.method === 'PUT' ? { created: false } : {}),
            }
          : {}),
      }
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    const entryA = {
      id: 'entry-a',
      key: 'a',
      secondkey: '',
      insertorder: 100,
      comment: 'A',
      content: 'A',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    const entryB = { ...entryA, id: 'entry-b', key: 'b', comment: 'B', content: 'B' }
    const scopes = [
      {
        scope: 'global' as const,
        metadata: { acknowledgeOptimistic: true, optimisticCollectionEpoch: 4 },
        replace: (optimisticEntries: (typeof entryA)[]) =>
          replaceGlobalLorebookEntriesCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entries: optimisticEntries,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
          }),
        upsert: (optimisticEntries: (typeof entryA)[]) =>
          upsertGlobalLorebookEntryCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entryId: 'entry-b',
            entry: entryB,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
            optimisticEntryIndex: 1,
            optimisticEntryCreated: false,
          }),
        delete: (optimisticEntries: (typeof entryA)[]) =>
          deleteGlobalLorebookEntryCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entryId: 'entry-b',
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
            optimisticEntryIndex: 1,
          }),
        reorder: (optimisticEntries: (typeof entryA)[]) =>
          reorderGlobalLorebookEntriesCommand({
            baseRevision: 1,
            lorebookId: 'book-a',
            entryIds: optimisticEntries.map((entry) => entry.id),
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCollectionEpoch: 4,
          }),
      },
      {
        scope: 'character' as const,
        metadata: {
          acknowledgeOptimistic: true,
          optimisticRowEpoch: 5,
          optimisticLorebookEpoch: 6,
        },
        replace: (optimisticEntries: (typeof entryA)[]) =>
          replaceCharacterLorebooksCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entries: optimisticEntries,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
          }),
        upsert: (optimisticEntries: (typeof entryA)[]) =>
          upsertCharacterLorebookEntryCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entryId: 'entry-b',
            entry: entryB,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
            optimisticEntryIndex: 1,
            optimisticEntryCreated: false,
          }),
        delete: (optimisticEntries: (typeof entryA)[]) =>
          deleteCharacterLorebookEntryCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entryId: 'entry-b',
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
            optimisticEntryIndex: 1,
          }),
        reorder: (optimisticEntries: (typeof entryA)[]) =>
          reorderCharacterLorebookEntriesCommand({
            baseRevision: 1,
            characterId: 'char-a',
            entryIds: optimisticEntries.map((entry) => entry.id),
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticRowEpoch: 5,
            optimisticLorebookEpoch: 6,
          }),
      },
      {
        scope: 'chat' as const,
        metadata: { acknowledgeOptimistic: true, optimisticCharacterId: 'char-a', optimisticRowEpoch: 7 },
        replace: (optimisticEntries: (typeof entryA)[]) =>
          replaceChatLorebooksCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entries: optimisticEntries,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
          }),
        upsert: (optimisticEntries: (typeof entryA)[]) =>
          upsertChatLorebookEntryCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entryId: 'entry-b',
            entry: entryB,
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
            optimisticEntryIndex: 1,
            optimisticEntryCreated: false,
          }),
        delete: (optimisticEntries: (typeof entryA)[]) =>
          deleteChatLorebookEntryCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entryId: 'entry-b',
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
            optimisticEntryIndex: 1,
          }),
        reorder: (optimisticEntries: (typeof entryA)[]) =>
          reorderChatLorebookEntriesCommand({
            baseRevision: 1,
            chatId: 'chat-a',
            entryIds: optimisticEntries.map((entry) => entry.id),
            optimisticEntries,
            acknowledgeOptimistic: true,
            optimisticCharacterId: 'char-a',
            optimisticRowEpoch: 7,
          }),
      },
    ]

    for (const scope of scopes) {
      await scope.replace([entryA, entryB])
      await scope.upsert([entryA, entryB])
      await scope.delete([entryA])
      await scope.reorder([entryB, entryA])
    }

    expect(observedEffects).toEqual(
      scopes.flatMap(({ scope, metadata }) =>
        (['replace', 'upsert', 'delete', 'reorder'] as const).map((operation) => ({
          kind: 'lorebookMutation',
          scope,
          operation,
          ...(scope === 'global'
            ? { lorebookId: 'book-a', collectionProjectionEpoch: metadata.optimisticCollectionEpoch }
            : scope === 'character'
              ? {
                  characterId: 'char-a',
                  characterRowProjectionEpoch: metadata.optimisticRowEpoch,
                  characterLorebookProjectionEpoch: metadata.optimisticLorebookEpoch,
                }
              : {
                  characterId: 'char-a',
                  chatId: 'chat-a',
                  characterRowProjectionEpoch: metadata.optimisticRowEpoch,
                }),
        })),
      ),
    )
  })

  it('keeps non-opt-in, noncanonical, and mismatched scoped lorebook commands authoritative', async () => {
    const observedEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => ({
      revision: 40,
      event: {
        type: 'lorebook.entries.replaced',
        revision: 40,
        resource: url.includes('/chats/') ? 'characterRow' : 'globalLorebook',
        id: url.includes('/chats/') ? 'chat-a' : 'book-a',
        ...(url.includes('/chats/') ? { parentId: 'wrong-character' } : {}),
      },
      lorebookId: 'book-a',
      chatId: 'chat-a',
      ...(url.endsWith('/entries/entry-a') ? { entryId: 'entry-a', entryIndex: 1, created: false } : {}),
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    const malformedEntry = { id: 'entry-a', key: 'missing canonical fields' }
    const canonicalEntry = {
      id: 'entry-a',
      key: 'entry-a',
      secondkey: '',
      insertorder: 100,
      comment: 'Entry A',
      content: 'A',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    }
    await replaceGlobalLorebookEntriesCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entries: [],
    })
    await replaceGlobalLorebookEntriesCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entries: [malformedEntry],
      optimisticEntries: [malformedEntry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
    })
    await replaceChatLorebooksCommand({
      baseRevision: 1,
      chatId: 'chat-a',
      entries: [],
      optimisticEntries: [],
      acknowledgeOptimistic: true,
      optimisticCharacterId: 'char-a',
      optimisticRowEpoch: 1,
    })
    await upsertGlobalLorebookEntryCommand({
      baseRevision: 1,
      lorebookId: 'book-a',
      entryId: 'entry-a',
      entry: canonicalEntry,
      optimisticEntries: [canonicalEntry],
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: 1,
      optimisticEntryIndex: 0,
      optimisticEntryCreated: true,
    })

    expect(observedEffects).toEqual([])
  })
})
