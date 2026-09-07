import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => ({
  commands: [] as Array<Record<string, unknown> & { rollback?: () => void }>,
  commandResults: [] as Array<
    Promise<{ status: string; error?: string; reason?: string; revision?: number; currentRevision?: number }>
  >,
}))
const durableRecorded = vi.hoisted(() => ({
  nextId: 0,
  stageError: null as Error | null,
  staged: [] as Array<{ key: string; intent: Record<string, unknown>; mutationId: string }>,
  dispatched: [] as Array<{ intent: Record<string, unknown>; mutationId: string }>,
  acknowledged: [] as string[],
  settlementListeners: new Map<string, Set<(settlement: 'accepted' | 'discarded') => void>>(),
}))

vi.mock('./pendingMutationOutbox', () => ({
  stagePendingMutation: (
    key: string,
    intent: Record<string, unknown>,
    previous?: { phase: string; mutationId: string },
  ) => {
    if (durableRecorded.stageError) throw durableRecorded.stageError
    const mutationId = previous?.phase === 'staged' ? previous.mutationId : `lore-mutation-${++durableRecorded.nextId}`
    if (previous?.phase === 'staged') previous.phase = 'superseded'
    const handle = { key, mutationId, phase: 'staged' }
    durableRecorded.staged.push({ key, intent, mutationId })
    return handle
  },
  acknowledgePendingMutation: async (handle: { mutationId: string }) => {
    durableRecorded.acknowledged.push(handle.mutationId)
    return 'deleted'
  },
  isPendingMutationCurrent: async (handle: { phase: string }) => handle.phase !== 'superseded',
}))

vi.mock('./durableMutationDispatch', () => ({
  registerDurableMutationSettlementListener: (
    mutationId: string,
    listener: (settlement: 'accepted' | 'discarded') => void,
  ) => {
    const listeners = durableRecorded.settlementListeners.get(mutationId) ?? new Set()
    listeners.add(listener)
    durableRecorded.settlementListeners.set(mutationId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) durableRecorded.settlementListeners.delete(mutationId)
    }
  },
  dispatchDurableMutation: async (
    handle: { mutationId: string; phase: string },
    intent: Record<string, unknown>,
    dispatch: (options: Record<string, unknown>) => Promise<unknown>,
  ) => {
    handle.phase = 'dispatching'
    durableRecorded.dispatched.push({ intent, mutationId: handle.mutationId })
    const result = dispatch({ mutationId: handle.mutationId, databaseLineage: 'test-lineage' }) as Promise<{
      status?: string
      reason?: string
    }>
    void result.then((settlement) => {
      if (
        settlement.status !== 'ok' &&
        ['database-lineage', 'invalid-request', 'mutation-id-conflict', 'not-found', 'stale-writer'].includes(
          settlement.reason ?? '',
        )
      ) {
        handle.phase = 'superseded'
      }
    })
    return result
  },
}))

vi.mock('./commands', () => ({
  canUseServerCommands: () => true,
  runServerCommand: vi.fn(
    async (args: { command: (rev: number) => Promise<unknown>; rollback?: () => void; keepalive?: boolean }) => {
      const { command } = args
      const built = await command(1)
      recorded.commands.push({
        ...(built as Record<string, unknown>),
        ...(args.keepalive ? { keepalive: args.keepalive } : {}),
        ...(args.rollback ? { rollback: args.rollback } : {}),
      })
      const queuedResult = recorded.commandResults.shift()
      const result = queuedResult ? await queuedResult : { status: 'ok', revision: 1 }
      if (result.status !== 'ok') args.rollback?.()
      return result
    },
  ),
  subscribeServerCommandLocalEffectApplied: () => () => {},
  // Builders: identity stubs that tag the command kind so tests can assert which
  // owner mutation was persisted.
  createGlobalLorebookCommand: async (a: unknown) => ({ kind: 'createGlobal', a }),
  deleteCharacterLorebookEntryCommand: async (a: unknown) => ({ kind: 'deleteCharacterEntry', a }),
  deleteChatLorebookEntryCommand: async (a: unknown) => ({ kind: 'deleteChatEntry', a }),
  deleteGlobalLorebookCommand: async (a: unknown) => ({ kind: 'deleteGlobal', a }),
  deleteGlobalLorebookEntryCommand: async (a: unknown) => ({ kind: 'deleteGlobalEntry', a }),
  deleteModuleLorebookEntryCommand: async (a: unknown) => ({ kind: 'deleteModuleEntry', a }),
  reorderCharacterLorebookEntriesCommand: async (a: unknown) => ({ kind: 'reorderCharacterEntries', a }),
  reorderChatLorebookEntriesCommand: async (a: unknown) => ({ kind: 'reorderChatEntries', a }),
  reorderGlobalLorebooksCommand: async (a: unknown) => ({ kind: 'reorderGlobal', a }),
  reorderGlobalLorebookEntriesCommand: async (a: unknown) => ({ kind: 'reorderGlobalEntries', a }),
  reorderModuleLorebookEntriesCommand: async (a: unknown) => ({ kind: 'reorderModuleEntries', a }),
  replaceCharacterLorebooksCommand: async (a: { characterId?: string; entries?: unknown[] }) => ({
    kind: 'replaceCharacter',
    ...a,
  }),
  replaceChatLorebooksCommand: async (a: unknown) => ({ kind: 'replaceChat', a }),
  replaceGlobalLorebookEntriesCommand: async (a: unknown) => ({ kind: 'replaceGlobalEntries', a }),
  replaceModuleLorebooksCommand: async (a: { moduleId?: string; entries?: unknown[] }) => ({
    kind: 'replaceModule',
    ...a,
  }),
  selectGlobalLorebookCommand: async (a: unknown) => ({ kind: 'selectGlobal', a }),
  updateGlobalLorebookCommand: async (a: unknown) => ({ kind: 'updateGlobal', a }),
  upsertCharacterLorebookEntryCommand: async (a: unknown) => ({ kind: 'upsertCharacterEntry', a }),
  upsertChatLorebookEntryCommand: async (a: unknown) => ({ kind: 'upsertChatEntry', a }),
  upsertGlobalLorebookEntryCommand: async (a: unknown) => ({ kind: 'upsertGlobalEntry', a }),
  upsertModuleLorebookEntryCommand: async (a: unknown) => ({ kind: 'upsertModuleEntry', a }),
}))
import { selectedCharID } from '../stores.svelte'
import { GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY } from './lorebookMutationKeys'
import {
  applyCollectionsResource,
  applySettingsResource,
  captureCharacterLorebookProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  captureCollectionProjectionEpoch,
  markCharacterLorebookProjectionApplied,
  replaceResourceDatabase as setDatabaseLite,
} from './resourceState.svelte'
import {
  applyLorebookEntryDraftEdit,
  applyLorebookEntryDraftRollback,
  applyServerCharacterLorebookResource,
  changedLorebookEntryDraftFields,
  clearDirtyLorebookEntryFieldsMatchingProjection,
  createGlobalLorebook,
  currentGlobalLorebookStateSnapshot,
  currentLorebookCollectionScopedSnapshot,
  currentLorebookEntryScopedSnapshot,
  currentLorebookStateSnapshot,
  deleteGlobalLorebook,
  deleteGlobalLorebookById,
  dispatchCreateGlobalLorebook,
  dispatchDeleteGlobalLorebook,
  dispatchReorderGlobalLorebooks,
  dispatchReplaceChatLorebooks,
  dispatchReplaceCharacterLorebooks,
  dispatchReplaceGlobalLorebookEntries,
  dispatchReplaceModuleLorebooks,
  dispatchUpdateGlobalLorebook,
  flushPendingLorebookEntryDraftEdit,
  flushPendingLorebookOwnerMutations,
  mergeLorebookEntryProjectionDraft,
  markCharacterLorebookHydrated,
  normalizeClientLorebookEntryIds,
  recordHydratedCharacterLorebooks,
  replaceCharacterLorebookCollection,
  replaceCharacterLorebookCollectionWithOutcome,
  replaceChatLorebookCollectionWithOutcome,
  replaceModuleLorebookCollectionDraft,
  resetLorebookHydration,
  resetLorebookOwnerForTests,
  restoreLorebookEntryState,
  restoreLorebookState,
  renameGlobalLorebook,
  renameGlobalLorebookById,
  scopedLorebookStateSnapshot,
  setActiveChatLorebookLocalActivation,
  setActiveChatLorebookLocalActivationWithOutcome,
  setChatLorebookLocalActivationWithOutcome,
  subscribeLorebookEntryDraftRollbacks,
} from './lorebookOwner.svelte'
import { withCloneInstrumentation } from '../__tests__/cloneCostHarness'
import { getResourceDatabase as getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type Entry = {
  key?: string
  content?: string
  id?: string
  folder?: string
  comment?: string
  alwaysActive?: boolean
}
type GlobalLorebookFixture = { id: string; name: string; data: Entry[] }

const DELAY = 50

const testDatabaseState = {
  set db(value: unknown) {
    setDatabaseLite(value as any)
  },
}

function setupCharacter(globalLore: unknown): void {
  testDatabaseState.db = {
    characters: [{ chaId: 'c1', chats: [], globalLore }],
    loreBook: [],
    loreBookPage: 0,
    modules: [],
  }
  selectedCharID.set(0)
}

function setupGlobalLorebooks(
  loreBook: GlobalLorebookFixture[] = [{ id: 'g1', name: 'Initial', data: [] }],
  loreBookPage = 0,
): void {
  testDatabaseState.db = {
    characters: [],
    loreBook,
    loreBookPage,
    modules: [],
  }
  selectedCharID.set(-1)
}

function globalLorebookIds(): string[] {
  return (getDatabase().loreBook as unknown as GlobalLorebookFixture[]).map((lorebook) => lorebook.id)
}

function characterReplaceCommands(): Array<Record<string, unknown> & { rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'replaceCharacter')
}

function characterEntryCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'upsertCharacterEntry')
}

function characterEntryDeleteCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'deleteCharacterEntry')
}

function characterEntryReorderCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'reorderCharacterEntries')
}

function globalEntryCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'upsertGlobalEntry')
}

function globalEntryReplaceCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'replaceGlobalEntries')
}

function globalCreateCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'createGlobal')
}

function globalDeleteCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'deleteGlobal')
}

function globalUpdateCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'updateGlobal')
}

function globalReorderCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'reorderGlobal')
}

async function flushServerCommandRecording(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function publishLorebookSettlement(mutationId: string, settlement: 'accepted' | 'discarded'): void {
  const listeners = [...(durableRecorded.settlementListeners.get(mutationId) ?? [])]
  durableRecorded.settlementListeners.delete(mutationId)
  for (const listener of listeners) listener(settlement)
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.useFakeTimers()
  resetLorebookHydration()
  recorded.commands.length = 0
  recorded.commandResults.length = 0
  durableRecorded.nextId = 0
  durableRecorded.stageError = null
  durableRecorded.staged.length = 0
  durableRecorded.dispatched.length = 0
  durableRecorded.acknowledged.length = 0
  durableRecorded.settlementListeners.clear()
})

afterEach(() => {
  resetClientSessionForTests()
  resetLorebookOwnerForTests()
  vi.useRealTimers()
  selectedCharID.set(-1)
  recorded.commands.length = 0
  recorded.commandResults.length = 0
})

describe('lorebook entry dirty projection merge', () => {
  function loreEntry(overrides: Partial<Entry> = {}): Entry {
    return {
      id: 'entry-1',
      key: 'initial key',
      content: 'initial content',
      comment: 'initial comment',
      ...overrides,
    }
  }

  it('preserves dirty entry fields while refreshing clean projection fields', () => {
    const previous = loreEntry({ content: 'initial content', comment: 'initial comment' })
    const draft = loreEntry({ content: 'local newer content', comment: 'initial comment' })
    const projection = loreEntry({
      content: 'older projected content',
      comment: 'projected clean comment',
      key: 'projected clean key',
    })
    const dirtyFields = new Set(changedLorebookEntryDraftFields(previous as any, draft as any))

    clearDirtyLorebookEntryFieldsMatchingProjection(dirtyFields as any, draft as any, projection as any)
    const merged = mergeLorebookEntryProjectionDraft(draft as any, projection as any, dirtyFields as any) as Entry

    expect([...dirtyFields]).toEqual(['content'])
    expect(merged.content).toBe('local newer content')
    expect(merged.comment).toBe('projected clean comment')
    expect(merged.key).toBe('projected clean key')
  })

  it('clears exact catch-up dirty fields so later clean projections can replace them', () => {
    const previous = loreEntry({ content: 'initial content', comment: 'initial comment' })
    let draft = loreEntry({ content: 'local content', comment: 'initial comment' })
    const staleProjection = loreEntry({ content: 'older projected content', comment: 'projected clean comment' })
    const caughtUpProjection = loreEntry({ content: 'local content', comment: 'projected clean comment' })
    const laterCleanProjection = loreEntry({ content: 'server later content', comment: 'projected clean comment' })
    const dirtyFields = new Set(changedLorebookEntryDraftFields(previous as any, draft as any))

    clearDirtyLorebookEntryFieldsMatchingProjection(dirtyFields as any, draft as any, staleProjection as any)
    draft = mergeLorebookEntryProjectionDraft(draft as any, staleProjection as any, dirtyFields as any) as Entry

    expect(dirtyFields).toEqual(new Set(['content']))
    expect(draft).toMatchObject({
      content: 'local content',
      comment: 'projected clean comment',
    })

    clearDirtyLorebookEntryFieldsMatchingProjection(dirtyFields as any, draft as any, caughtUpProjection as any)
    draft = mergeLorebookEntryProjectionDraft(draft as any, laterCleanProjection as any, dirtyFields as any) as Entry

    expect(dirtyFields.size).toBe(0)
    expect(draft.content).toBe('server later content')
  })

  it('applies failed-field rollbacks to a mounted draft without overwriting newer fields', () => {
    const previous = loreEntry({ content: 'server content', comment: 'server comment' })
    const attempted = loreEntry({ content: 'server content', comment: 'failed comment' })
    const draft = loreEntry({ content: 'newer content', comment: 'failed comment' })

    const rollback = applyLorebookEntryDraftRollback(
      draft as any,
      {
        scopeKey: 'character:character-a',
        entryId: 'entry-1',
        previousEntry: previous as any,
        attemptedEntry: attempted as any,
        restoredFields: ['comment'],
      },
      'character:character-a',
    )

    expect(rollback.restoredFields).toEqual(['comment'])
    expect(rollback.draft).toMatchObject({ content: 'newer content', comment: 'server comment' })
  })

  it('ignores a draft rollback from another lorebook scope with the same entry ID', () => {
    const previous = loreEntry({ comment: 'server comment' })
    const attempted = loreEntry({ comment: 'failed comment' })
    const draft = loreEntry({ comment: 'failed comment' })

    const rollback = applyLorebookEntryDraftRollback(
      draft as any,
      {
        scopeKey: 'character:character-a',
        entryId: 'entry-1',
        previousEntry: previous as any,
        attemptedEntry: attempted as any,
        restoredFields: ['comment'],
      },
      'character:character-b',
    )

    expect(rollback).toEqual({ draft, restoredFields: [] })
  })
})

describe('lorebook identity normalization and lazy persistence', () => {
  it('keeps the first stable id, remints duplicates and missing ids, and reports changes', () => {
    const entries = [{ id: 'stable' }, { id: 'stable' }, {}] as any[]

    expect(normalizeClientLorebookEntryIds(entries)).toBe(true)
    expect(entries[0].id).toBe('stable')
    expect(entries[1].id).not.toBe('stable')
    expect(entries[2].id).toEqual(expect.any(String))
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(3)
    expect(normalizeClientLorebookEntryIds(entries)).toBe(false)
  })

  it('uses one full replace for the first id-less entry edit, then returns to sparse entry updates', async () => {
    setupCharacter([{ key: 'a', content: 'A', alwaysActive: false }] as Entry[])
    markCharacterLorebookHydrated('c1')
    const scope = { kind: 'character', characterId: 'c1' } as const
    const firstDraft = { ...(getDatabase().characters[0].globalLore as Entry[])[0], alwaysActive: true }

    expect(applyLorebookEntryDraftEdit(scope, 0, firstDraft as any, DELAY)).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(characterReplaceCommands()).toHaveLength(1)
    expect(characterEntryCommands()).toHaveLength(0)
    const persistedId = (getDatabase().characters[0].globalLore as Entry[])[0].id
    expect(persistedId).toEqual(expect.any(String))

    const secondDraft = { ...(getDatabase().characters[0].globalLore as Entry[])[0], content: 'B' }
    expect(applyLorebookEntryDraftEdit(scope, 0, secondDraft as any, DELAY)).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(characterReplaceCommands()).toHaveLength(1)
    expect(characterEntryCommands()).toHaveLength(1)
    expect(characterEntryCommands()[0].a).toMatchObject({
      characterId: 'c1',
      entryId: persistedId,
      sparseUpdate: { patch: { content: 'B' } },
    })
  })

  it('keeps a reminted duplicate id when the editor submits its stale pre-normalization draft', async () => {
    setupCharacter([
      { id: 'duplicate', key: 'a', content: 'A' },
      { id: 'duplicate', key: 'b', content: 'B' },
    ] as Entry[])
    markCharacterLorebookHydrated('c1')
    const scope = { kind: 'character', characterId: 'c1' } as const
    const staleDraft = { ...(getDatabase().characters[0].globalLore as Entry[])[1], content: 'Edited' }

    expect(applyLorebookEntryDraftEdit(scope, 1, staleDraft as any, DELAY)).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)

    const liveEntries = getDatabase().characters[0].globalLore as Entry[]
    expect(liveEntries[0].id).toBe('duplicate')
    expect(liveEntries[1].id).not.toBe('duplicate')
    expect(characterReplaceCommands()).toHaveLength(1)
    expect(characterReplaceCommands()[0].entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'duplicate', content: 'A' }),
        expect.objectContaining({ id: liveEntries[1].id, content: 'Edited' }),
      ]),
    )
  })

  it('uses a full replace when adding to an identity-dirty collection', async () => {
    setupCharacter([{ key: 'a', content: 'A' }] as Entry[])
    markCharacterLorebookHydrated('c1')
    const scope = { kind: 'character', characterId: 'c1' } as const
    currentLorebookCollectionScopedSnapshot(scope)
    const nextEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    nextEntries.push({ id: 'new-entry', key: 'new', content: 'New' })

    expect(replaceCharacterLorebookCollection('c1', nextEntries as any, DELAY)).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(characterReplaceCommands()).toHaveLength(1)
    expect(characterEntryCommands()).toHaveLength(0)
  })

  it('rolls a failed identity-dirty replace back as a collection and keeps the scope dirty', async () => {
    setupCharacter([
      { key: 'a', content: 'A' },
      { key: 'b', content: 'B' },
    ] as Entry[])
    markCharacterLorebookHydrated('c1')
    recorded.commandResults.push(Promise.resolve({ status: 'error', error: 'rejected' }))
    const scope = { kind: 'character', characterId: 'c1' } as const
    const draft = { ...(getDatabase().characters[0].globalLore as Entry[])[0], content: 'Attempted' }

    expect(applyLorebookEntryDraftEdit(scope, 0, draft as any, DELAY)).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)

    const rolledBack = getDatabase().characters[0].globalLore as Entry[]
    expect(rolledBack.map((entry) => entry.content)).toEqual(['A', 'B'])
    expect(new Set(rolledBack.map((entry) => entry.id)).size).toBe(2)

    const retry = { ...rolledBack[0], content: 'Retry' }
    expect(applyLorebookEntryDraftEdit(scope, 0, retry as any, DELAY)).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(characterReplaceCommands()).toHaveLength(2)
    expect(characterEntryCommands()).toHaveLength(0)
  })
})

describe('lorebook snapshot purity', () => {
  it('state snapshots clone malformed lorebook data as-is without assigning ids or stub arrays', () => {
    testDatabaseState.db = {
      loreBook: [{ name: 'Missing ids' }],
      loreBookPage: 0,
      characters: [
        {
          chaId: 'snapshot-char',
          chats: [{ id: 'snapshot-chat' }],
        },
      ],
      modules: [{ id: 'snapshot-module' }],
    }
    selectedCharID.set(0)

    const broad = currentLorebookStateSnapshot()
    const global = currentGlobalLorebookStateSnapshot()

    expect((getDatabase().loreBook[0] as { id?: string }).id).toBeUndefined()
    expect(getDatabase().loreBook[0]).not.toHaveProperty('data')
    expect(getDatabase().characters[0]).not.toHaveProperty('globalLore')
    expect(getDatabase().characters[0].chats[0]).not.toHaveProperty('localLore')
    expect((getDatabase().modules[0] as { lorebook?: unknown }).lorebook).toBeUndefined()

    expect(broad.loreBook[0]).not.toHaveProperty('id')
    expect(broad.loreBook[0]).not.toHaveProperty('data')
    expect(global.loreBook[0]).not.toHaveProperty('id')
    expect(global.loreBook[0]).not.toHaveProperty('data')
  })
})

describe('global lorebook owner mutations', () => {
  it('creates a global lorebook, dispatches create, and rolls back to the previous list', async () => {
    setupGlobalLorebooks()

    expect(createGlobalLorebook()).toBe(true)
    await flushServerCommandRecording()

    const lorebooks = getDatabase().loreBook as unknown as GlobalLorebookFixture[]
    expect(lorebooks).toHaveLength(2)
    expect(lorebooks[1]).toMatchObject({
      id: expect.any(String),
      name: 'New LoreBook',
      data: [],
    })

    const creates = globalCreateCommands()
    expect(creates).toHaveLength(1)
    expect(creates[0].a).toMatchObject({
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: expect.any(Number),
      lorebook: {
        id: lorebooks[1].id,
        name: 'New LoreBook',
        data: [],
      },
    })

    creates[0].rollback?.()
    expect(globalLorebookIds()).toEqual(['g1'])
  })

  it('failed create removes only the unchanged attempted row and preserves newer siblings', async () => {
    setupGlobalLorebooks([{ id: 'g1', name: 'Initial', data: [] }])

    expect(createGlobalLorebook()).toBe(true)
    await flushServerCommandRecording()

    const createdId = (getDatabase().loreBook as unknown as GlobalLorebookFixture[])[1].id
    getDatabase().loreBook[0].name = 'Sibling Edit'
    ;(getDatabase().loreBook as unknown as GlobalLorebookFixture[]).push({
      id: 'g-later',
      name: 'Later Append',
      data: [],
    })
    getDatabase().loreBookPage = 2

    const creates = globalCreateCommands()
    expect(creates).toHaveLength(1)
    creates[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g-later'])
    expect(globalLorebookIds()).not.toContain(createdId)
    expect(getDatabase().loreBook[0].name).toBe('Sibling Edit')
    expect(getDatabase().loreBook[1].name).toBe('Later Append')
    expect(getDatabase().loreBookPage).toBe(1)
  })

  it('deletes a global lorebook, resets page, dispatches delete, and rolls back list/page', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
      ],
      1,
    )

    expect(deleteGlobalLorebook(1)).toBe(true)
    await flushServerCommandRecording()

    expect(globalLorebookIds()).toEqual(['g1'])
    expect(getDatabase().loreBookPage).toBe(0)

    const deletes = globalDeleteCommands()
    expect(deletes).toHaveLength(1)
    expect(deletes[0].a).toMatchObject({
      lorebookId: 'g2',
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: expect.any(Number),
      optimisticPageEpoch: expect.any(Number),
    })

    deletes[0].rollback?.()
    expect(globalLorebookIds()).toEqual(['g1', 'g2'])
    expect(getDatabase().loreBookPage).toBe(1)
  })

  it('deletes a global lorebook by stable id after the live list reorders', async () => {
    setupGlobalLorebooks([
      { id: 'g1', name: 'Initial', data: [] },
      { id: 'g2', name: 'Second', data: [] },
      { id: 'g3', name: 'Third', data: [] },
    ])
    getDatabase().loreBook = [getDatabase().loreBook[2], getDatabase().loreBook[0], getDatabase().loreBook[1]]

    expect(deleteGlobalLorebookById('g2')).toBe(true)
    await flushServerCommandRecording()

    expect(globalLorebookIds()).toEqual(['g3', 'g1'])
    expect(globalDeleteCommands()).toHaveLength(1)
    expect(globalDeleteCommands()[0].a).toMatchObject({ lorebookId: 'g2' })
  })

  it('aborts a stable-id global lorebook delete when the target vanished', async () => {
    setupGlobalLorebooks([
      { id: 'g1', name: 'Initial', data: [] },
      { id: 'g2', name: 'Second', data: [] },
    ])
    getDatabase().loreBook = [getDatabase().loreBook[0]]

    expect(deleteGlobalLorebookById('g2')).toBe(false)
    await flushServerCommandRecording()

    expect(globalLorebookIds()).toEqual(['g1'])
    expect(globalDeleteCommands()).toHaveLength(0)
  })

  it('aborts stable-id global lorebook mutations when the id is duplicated', async () => {
    setupGlobalLorebooks([
      { id: 'duplicate', name: 'First', data: [] },
      { id: 'duplicate', name: 'Second', data: [] },
      { id: 'g3', name: 'Third', data: [] },
    ])

    expect(renameGlobalLorebookById('duplicate', 'Wrong target')).toBe(false)
    expect(deleteGlobalLorebookById('duplicate')).toBe(false)
    await flushServerCommandRecording()

    expect(getDatabase().loreBook.map((book) => book.name)).toEqual(['First', 'Second', 'Third'])
    expect(globalDeleteCommands()).toHaveLength(0)
  })

  it('renames a global lorebook through an explicit owner mutation', async () => {
    setupGlobalLorebooks()

    expect(renameGlobalLorebook(0, 'Renamed')).toBe(true)
    await flushServerCommandRecording()

    expect(getDatabase().loreBook[0].name).toBe('Renamed')
    const updates = globalUpdateCommands()
    expect(updates).toHaveLength(1)
    expect(updates[0].a).toMatchObject({
      lorebookId: 'g1',
      patch: { name: 'Renamed' },
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: expect.any(Number),
    })

    updates[0].rollback?.()
    expect(getDatabase().loreBook[0].name).toBe('Initial')
  })

  it('failed delete reinserts only a still-missing row and preserves newer rows', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
      ],
      1,
    )

    expect(deleteGlobalLorebook(1)).toBe(true)
    await flushServerCommandRecording()

    getDatabase().loreBook[0].name = 'Sibling Edit'
    ;(getDatabase().loreBook as unknown as GlobalLorebookFixture[]).push({
      id: 'g3',
      name: 'Later Append',
      data: [],
    })

    const deletes = globalDeleteCommands()
    expect(deletes).toHaveLength(1)
    deletes[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g2', 'g3'])
    expect(getDatabase().loreBook[0].name).toBe('Sibling Edit')
    expect(getDatabase().loreBook[1].name).toBe('Second')
    expect(getDatabase().loreBook[2].name).toBe('Later Append')
    expect(getDatabase().loreBookPage).toBe(1)
  })

  it('failed delete does not overwrite a row that already reappeared', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
      ],
      1,
    )

    expect(deleteGlobalLorebook(1)).toBe(true)
    await flushServerCommandRecording()
    ;(getDatabase().loreBook as unknown as GlobalLorebookFixture[]).push({
      id: 'g2',
      name: 'Projected Second',
      data: [{ id: 'server-entry', key: 'server' }],
    })

    const deletes = globalDeleteCommands()
    expect(deletes).toHaveLength(1)
    deletes[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g2'])
    expect(getDatabase().loreBook[1].name).toBe('Projected Second')
    expect(getDatabase().loreBook[1].data).toEqual([{ id: 'server-entry', key: 'server' }])
  })

  it('failed delete preserves a newer selected lorebook id when reinserting shifts indexes', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
        { id: 'g3', name: 'Third', data: [] },
      ],
      0,
    )

    expect(deleteGlobalLorebook(1)).toBe(true)
    await flushServerCommandRecording()

    getDatabase().loreBookPage = 1
    expect((getDatabase().loreBook as unknown as GlobalLorebookFixture[])[getDatabase().loreBookPage].id).toBe('g3')

    const deletes = globalDeleteCommands()
    expect(deletes).toHaveLength(1)
    deletes[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g2', 'g3'])
    expect(getDatabase().loreBookPage).toBe(2)
    expect((getDatabase().loreBook as unknown as GlobalLorebookFixture[])[getDatabase().loreBookPage].id).toBe('g3')
  })

  it('delete rollback restores the row but preserves a newer authoritative page projection', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
        { id: 'g3', name: 'Third', data: [] },
      ],
      2,
    )

    expect(deleteGlobalLorebook(1)).toBe(true)
    await flushServerCommandRecording()
    applySettingsResource({ revision: 1, settings: { loreBookPage: 0 } })

    const deletes = globalDeleteCommands()
    expect(deletes).toHaveLength(1)
    deletes[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g2', 'g3'])
    expect(getDatabase().loreBookPage).toBe(0)
  })

  it('delete rollback preserves a newer authoritative collection while restoring the untouched page slice', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
        { id: 'g3', name: 'Third', data: [] },
      ],
      2,
    )

    expect(deleteGlobalLorebook(1)).toBe(true)
    await flushServerCommandRecording()
    applyCollectionsResource(
      {
        revision: 1,
        collections: {
          loreBook: [
            { id: 'g1', name: 'Projected Initial', data: [] },
            { id: 'g3', name: 'Projected Third', data: [] },
          ] as never,
        },
      },
      'loreBook',
    )

    const deletes = globalDeleteCommands()
    expect(deletes).toHaveLength(1)
    deletes[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g3'])
    expect(getDatabase().loreBook[0].name).toBe('Projected Initial')
    expect(getDatabase().loreBookPage).toBe(1)
  })

  it('does not delete the only global lorebook', async () => {
    setupGlobalLorebooks()

    expect(deleteGlobalLorebook(0)).toBe(false)
    await flushServerCommandRecording()

    expect(globalLorebookIds()).toEqual(['g1'])
    expect(getDatabase().loreBookPage).toBe(0)
    expect(globalDeleteCommands()).toHaveLength(0)
  })

  it('failed rename skips rollback after a newer same-row edit and preserves siblings', async () => {
    setupGlobalLorebooks([
      { id: 'g1', name: 'Initial', data: [] },
      { id: 'g2', name: 'Second', data: [] },
    ])

    const previous = scopedLorebookStateSnapshot('globalMeta:g1', JSON.stringify({ name: 'Initial' }))
    getDatabase().loreBook[0].name = 'Attempted Rename'
    dispatchUpdateGlobalLorebook('g1', { name: 'Attempted Rename' }, previous)
    await flushServerCommandRecording()

    getDatabase().loreBook[0].name = 'Newer Same Row Edit'
    getDatabase().loreBook[1].name = 'Sibling Edit'

    const updates = globalUpdateCommands()
    expect(updates).toHaveLength(1)
    updates[0].rollback?.()

    expect(getDatabase().loreBook[0].name).toBe('Newer Same Row Edit')
    expect(getDatabase().loreBook[1].name).toBe('Sibling Edit')
  })

  it('reorders while preserving the pre-reorder selected lorebook id and opts into local acknowledgement', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
        { id: 'g3', name: 'Third', data: [] },
      ],
      1,
    )
    const previous = currentLorebookStateSnapshot()
    getDatabase().loreBook = [getDatabase().loreBook[1], getDatabase().loreBook[2], getDatabase().loreBook[0]] as never

    dispatchReorderGlobalLorebooks(previous)
    expect(getDatabase().loreBookPage).toBe(0)
    expect((getDatabase().loreBook as unknown as GlobalLorebookFixture[])[getDatabase().loreBookPage].id).toBe('g2')
    await flushServerCommandRecording()

    const reorders = globalReorderCommands()
    expect(reorders).toHaveLength(1)
    expect(reorders[0].a).toMatchObject({
      lorebookIds: ['g2', 'g3', 'g1'],
      acknowledgeOptimistic: true,
      optimisticSelectedLorebookId: 'g2',
      optimisticCollectionEpoch: expect.any(Number),
      optimisticPageEpoch: expect.any(Number),
    })
  })

  it('still dispatches reorder authoritatively when the previous selected lorebook is not stable', async () => {
    setupGlobalLorebooks(
      [
        { id: 'g1', name: 'Initial', data: [] },
        { id: 'g2', name: 'Second', data: [] },
      ],
      0,
    )
    const previous = currentLorebookStateSnapshot()
    previous.loreBookPage = 99
    getDatabase().loreBook = [getDatabase().loreBook[1], getDatabase().loreBook[0]] as never
    getDatabase().loreBookPage = 1

    dispatchReorderGlobalLorebooks(previous)
    expect(getDatabase().loreBookPage).toBe(1)
    await flushServerCommandRecording()

    const reorders = globalReorderCommands()
    expect(reorders).toHaveLength(1)
    expect(reorders[0].a).toMatchObject({
      lorebookIds: ['g2', 'g1'],
      acknowledgeOptimistic: false,
    })
  })

  it('failed reorder restores only the attempted order and preserves row content', async () => {
    setupGlobalLorebooks([
      { id: 'g1', name: 'Initial', data: [] },
      { id: 'g2', name: 'Second', data: [] },
      { id: 'g3', name: 'Third', data: [] },
    ])
    const previous = currentLorebookStateSnapshot()
    getDatabase().loreBook = [getDatabase().loreBook[2], getDatabase().loreBook[0], getDatabase().loreBook[1]] as never

    dispatchReorderGlobalLorebooks(previous)
    await flushServerCommandRecording()

    getDatabase().loreBook[2].name = 'Second Edited After Dispatch'
    const reorders = globalReorderCommands()
    expect(reorders).toHaveLength(1)
    reorders[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g1', 'g2', 'g3'])
    expect(getDatabase().loreBook[1].name).toBe('Second Edited After Dispatch')
  })

  it('failed reorder skips rollback after a newer reorder', async () => {
    setupGlobalLorebooks([
      { id: 'g1', name: 'Initial', data: [] },
      { id: 'g2', name: 'Second', data: [] },
      { id: 'g3', name: 'Third', data: [] },
    ])
    const previous = currentLorebookStateSnapshot()
    getDatabase().loreBook = [getDatabase().loreBook[1], getDatabase().loreBook[0], getDatabase().loreBook[2]] as never

    dispatchReorderGlobalLorebooks(previous)
    await flushServerCommandRecording()

    getDatabase().loreBook = [getDatabase().loreBook[2], getDatabase().loreBook[0], getDatabase().loreBook[1]] as never
    const reorders = globalReorderCommands()
    expect(reorders).toHaveLength(1)
    reorders[0].rollback?.()

    expect(globalLorebookIds()).toEqual(['g3', 'g2', 'g1'])
  })
})

// Multi-owner fixtures exercise scoped operations without cloning sibling resources.

function setupMultiCollectionDb(): void {
  testDatabaseState.db = {
    loreBook: [{ id: 'g1', name: 'Global One', data: [{ key: 'gk', content: 'GC', id: 'ge1' }] }],
    loreBookPage: 0,
    characters: [
      {
        chaId: 'c0',
        globalLore: [{ key: 'c0g', content: 'C0G', id: 'c0g1' }],
        chats: [{ id: 'c0chat', localLore: [{ key: 'c0l', content: 'C0L', id: 'c0l1' }] }],
      },
      {
        chaId: 'c1',
        globalLore: [{ key: 'c1g', content: 'C1G', id: 'c1g1' }],
        chats: [{ id: 'c1chat', localLore: [{ key: 'c1l', content: 'C1L', id: 'c1l1' }] }],
      },
    ],
    modules: [
      { id: 'm0', lorebook: [{ key: 'm0', content: 'M0', id: 'm0e1' }] },
      { id: 'm1', lorebook: [{ key: 'm1', content: 'M1', id: 'm1e1' }] },
    ],
  }
  selectedCharID.set(0)
}

function setupSelectedCharacterLocalLoreCacheDb(): void {
  testDatabaseState.db = {
    loreBook: [],
    loreBookPage: 0,
    characters: [
      {
        chaId: 'cache-char',
        chatPage: 0,
        globalLore: [{ key: 'stubbed-global', content: 'Not hydrated', id: 'stubbed-global-1' }],
        chats: [
          {
            id: 'open-chat',
            name: 'Open Chat',
            localLore: [{ key: 'open', content: 'Open lore', id: 'open-lore-1' }],
          },
          {
            id: 'closed-chat',
            name: 'Closed Chat',
            localLore: [{ key: 'closed', content: 'Closed lore', id: 'closed-lore-1' }],
          },
        ],
      },
    ],
    modules: [],
  }
  selectedCharID.set(0)
}

function setupActiveChatLocalActivationDb(chatId: string | null = 'active-chat'): void {
  const chat: Record<string, unknown> = {
    name: 'Active Chat',
    localLore: [],
  }
  if (chatId !== null) {
    chat.id = chatId
  }

  testDatabaseState.db = {
    loreBook: [],
    loreBookPage: 0,
    characters: [
      {
        chaId: 'activation-char',
        chatPage: 0,
        globalLore: [],
        chats: [chat],
      },
    ],
    modules: [],
  }
  selectedCharID.set(0)
}

function stripIdsForScopedEnsureRegression(): void {
  const db = getDatabase() as any
  delete db.loreBook[0].id
  delete db.loreBook[0].data[0].id
  for (const character of db.characters) {
    delete character.globalLore[0].id
    delete character.chats[0].localLore[0].id
  }
  for (const module of db.modules) {
    delete module.lorebook[0].id
  }
}

function chatReplaceChatIds(): string[] {
  return recorded.commands.filter((c) => c.kind === 'replaceChat').map((c) => (c.a as { chatId?: string }).chatId ?? '')
}

function chatReplaceCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'replaceChat')
}

function chatEntryCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'upsertChatEntry')
}

function chatEntryDeleteCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'deleteChatEntry')
}

function moduleReplaceCommands(): Array<Record<string, unknown> & { entries?: unknown[]; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'replaceModule')
}

function moduleEntryCommands(): Array<Record<string, unknown> & { a?: unknown; rollback?: () => void }> {
  return recorded.commands.filter((c) => c.kind === 'upsertModuleEntry')
}

function setupK4EditorDb(): void {
  const entries = Array.from({ length: 24 }, (_unused, index) => ({
    id: `entry-${index}`,
    key: `key-${index}`,
    secondkey: '',
    insertorder: index,
    comment: `Entry ${index}`,
    content: `${'x'.repeat(240)}-${index}`,
    mode: 'normal',
    alwaysActive: false,
    selective: false,
  }))

  testDatabaseState.db = {
    loreBook: [{ id: 'global-k4', name: 'Global K4', data: entries.slice(0, 6) }],
    loreBookPage: 0,
    characters: [
      {
        chaId: 'c-k4',
        globalLore: entries,
        chats: [
          {
            id: 'chat-k4',
            localLore: [
              {
                id: 'chat-entry-0',
                key: 'chat-key',
                secondkey: '',
                insertorder: 0,
                comment: 'Chat entry',
                content: 'chat content',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
              },
            ],
          },
        ],
      },
      {
        chaId: 'c-k4-sibling',
        globalLore: [
          {
            id: 'sibling-entry',
            key: 'sibling',
            secondkey: '',
            insertorder: 0,
            comment: 'Sibling',
            content: 'sibling content',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
          },
        ],
        chats: [],
      },
    ],
    modules: [],
  }
  selectedCharID.set(0)
  markCharacterLorebookHydrated('c-k4')
  markCharacterLorebookHydrated('c-k4-sibling')
}

function setupK4ModuleDb(): void {
  const entries = Array.from({ length: 18 }, (_unused, index) => ({
    id: `module-entry-${index}`,
    key: `module-key-${index}`,
    secondkey: '',
    insertorder: index,
    comment: `Module Entry ${index}`,
    content: `${'m'.repeat(220)}-${index}`,
    mode: 'normal',
    alwaysActive: false,
    selective: false,
  }))

  testDatabaseState.db = {
    loreBook: [],
    loreBookPage: 0,
    characters: [],
    modules: [
      {
        id: 'module-k4',
        name: 'Module K4',
        description: '',
        lorebook: entries,
      },
    ],
  }
  selectedCharID.set(-1)
}

function cloneEntries(entries: Entry[]): Entry[] {
  return JSON.parse(JSON.stringify(entries)) as Entry[]
}

describe('lorebook editor entry draft scope', () => {
  it('a single typing draft clones only the edited entry before debounce settle', () => {
    setupK4EditorDb()
    const collectionSize = JSON.stringify(getDatabase().characters[0].globalLore).length

    const firstDraft = {
      ...(getDatabase().characters[0].globalLore as Entry[])[7],
      content: 'draft one',
    } as Entry

    const first = withCloneInstrumentation(() =>
      applyLorebookEntryDraftEdit({ kind: 'character', characterId: 'c-k4' }, 7, firstDraft as any, DELAY),
    )

    expect(first.result).toBe(true)
    expect(first.maxClonedSize).toBeLessThan(collectionSize)
    expect(recorded.commands).toHaveLength(0)
  })

  it('the debounced final server write sends only the final edited entry', async () => {
    setupK4EditorDb()

    applyLorebookEntryDraftEdit(
      { kind: 'character', characterId: 'c-k4' },
      5,
      { ...(getDatabase().characters[0].globalLore as Entry[])[5], content: 'intermediate' } as any,
      DELAY,
    )
    applyLorebookEntryDraftEdit(
      { kind: 'character', characterId: 'c-k4' },
      5,
      { ...(getDatabase().characters[0].globalLore as Entry[])[5], content: 'final draft' } as any,
      DELAY,
    )

    expect(characterEntryCommands()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'entry-5',
      entry: { id: 'entry-5', content: 'final draft' },
      sparseUpdate: { patch: { content: 'final draft' } },
    })
    expect(characterReplaceCommands()).toHaveLength(0)
    expect(durableRecorded.dispatched[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks/entries/entry-5',
          body: { patch: { content: 'final draft' } },
        },
      ],
    })
  })

  it('immediately dispatches a full-entry baseline correction when a draft returns to its baseline', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const original = cloneEntries([(getDatabase().characters[0].globalLore as Entry[])[5]])[0]

    applyLorebookEntryDraftEdit(scope, 5, { ...original, content: 'temporary' } as any, DELAY)
    applyLorebookEntryDraftEdit(scope, 5, original as any, DELAY)
    expect(durableRecorded.dispatched).toHaveLength(1)
    await flushServerCommandRecording()

    expect(characterEntryCommands()).toHaveLength(1)
    expect(characterEntryCommands()[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'entry-5',
      entry: original,
    })
    expect((characterEntryCommands()[0].a as Record<string, unknown>).sparseUpdate).toBeUndefined()
    expect(durableRecorded.dispatched[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks/entries/entry-5',
          body: { entry: original },
        },
      ],
    })
    expect(durableRecorded.acknowledged).toEqual([])
  })

  it('immediately dispatches a full-collection correction for a total collection revert', async () => {
    setupK4EditorDb()
    const original = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    const changed = cloneEntries(original)
    changed[1].content = 'temporary collection edit'

    expect(replaceCharacterLorebookCollection('c-k4', changed as any, DELAY)).toBe(true)
    expect(durableRecorded.dispatched).toEqual([])
    expect(replaceCharacterLorebookCollection('c-k4', original as any, DELAY)).toBe(true)

    expect(durableRecorded.staged).toHaveLength(2)
    expect(durableRecorded.staged[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks/entries/entry-1',
          body: { patch: { content: 'temporary collection edit' } },
        },
      ],
    })
    expect(durableRecorded.dispatched).toHaveLength(1)
    expect(durableRecorded.dispatched[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks',
          body: { entries: original },
        },
      ],
    })
    await flushServerCommandRecording()
    expect(characterReplaceCommands()).toHaveLength(1)
    expect(durableRecorded.acknowledged).toEqual([])
  })

  it('preserves a staged entry edit as the predecessor of a same-scope collection delta', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const edited = {
      ...(getDatabase().characters[0].globalLore as Entry[])[5],
      content: 'edited before inline folder add',
    }
    applyLorebookEntryDraftEdit(scope, 5, edited as any, DELAY * 10)

    const inlineEntry = {
      id: 'inline-folder-entry',
      key: '',
      secondkey: '',
      insertorder: 100,
      comment: '',
      content: '',
      mode: 'normal',
      alwaysActive: true,
      selective: false,
      folder: 'folder-k4',
    }
    const nextEntries = [...(getDatabase().characters[0].globalLore as Entry[]), inlineEntry]
    expect(replaceCharacterLorebookCollection('c-k4', nextEntries as any, DELAY)).toBe(true)

    expect(durableRecorded.staged.map(({ mutationId }) => mutationId)).toEqual(['lore-mutation-1', 'lore-mutation-2'])
    expect(durableRecorded.staged.map(({ intent }) => intent)).toEqual([
      {
        version: 1,
        requests: [
          {
            method: 'PUT',
            path: '/characters/c-k4/lorebooks/entries/entry-5',
            body: { patch: { content: 'edited before inline folder add' } },
          },
        ],
      },
      {
        version: 1,
        requests: [
          {
            method: 'PUT',
            path: '/characters/c-k4/lorebooks/entries/inline-folder-entry',
            body: { entry: inlineEntry },
          },
        ],
      },
    ])
    expect(durableRecorded.dispatched.map(({ mutationId }) => mutationId)).toEqual(['lore-mutation-1'])

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(durableRecorded.dispatched.map(({ mutationId }) => mutationId)).toEqual([
      'lore-mutation-1',
      'lore-mutation-2',
    ])
  })

  it('coalesces sparse fields against the original entry and distinguishes deletion from null', async () => {
    setupK4EditorDb()
    const entries = getDatabase().characters[0].globalLore as unknown as Array<Entry & Record<string, unknown>>
    entries[5].activationPercent = 40

    applyLorebookEntryDraftEdit(
      { kind: 'character', characterId: 'c-k4' },
      5,
      { ...entries[5], comment: 'temporary comment', content: 'intermediate' } as any,
      DELAY,
    )
    const finalEntry = {
      ...entries[5],
      comment: 'Entry 5',
      content: 'final content',
      nullableExtension: null,
    } as Entry & Record<string, unknown>
    delete finalEntry.activationPercent
    applyLorebookEntryDraftEdit({ kind: 'character', characterId: 'c-k4' }, 5, finalEntry as any, DELAY)

    await vi.advanceTimersByTimeAsync(DELAY)

    const command = characterEntryCommands()[0].a as Record<string, any>
    expect(command.sparseUpdate).toEqual({
      patch: { content: 'final content', nullableExtension: null },
      deleteKeys: ['activationPercent'],
    })
    expect(command.sparseUpdate.patch).not.toHaveProperty('comment')
    expect(command.sparseUpdate.patch).not.toHaveProperty('id')
    expect(durableRecorded.dispatched[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks/entries/entry-5',
          body: {
            patch: { content: 'final content', nullableExtension: null },
            deleteKeys: ['activationPercent'],
          },
        },
      ],
    })
  })

  it('flushing a draft sends the final entry before the debounce delay', async () => {
    setupK4EditorDb()

    applyLorebookEntryDraftEdit(
      { kind: 'character', characterId: 'c-k4' },
      3,
      { ...(getDatabase().characters[0].globalLore as Entry[])[3], content: 'blur final' } as any,
      DELAY * 10,
    )
    flushPendingLorebookEntryDraftEdit({ kind: 'character', characterId: 'c-k4' })
    await vi.advanceTimersByTimeAsync(0)

    const cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'entry-3',
      entry: { id: 'entry-3', content: 'blur final' },
      sparseUpdate: { patch: { content: 'blur final' } },
    })

    await vi.advanceTimersByTimeAsync(DELAY * 10)
    expect(characterEntryCommands()).toHaveLength(1)
  })

  it('keeps an in-flight save and its durable full-entry successor as separate generations', async () => {
    const firstResult = createDeferred<{ status: string; error?: string }>()
    recorded.commandResults.push(firstResult.promise)
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const original = cloneEntries([(getDatabase().characters[0].globalLore as Entry[])[2]])[0]
    let mountedDraft = cloneEntries([original])[0]
    const stop = subscribeLorebookEntryDraftRollbacks((event) => {
      mountedDraft = applyLorebookEntryDraftRollback(mountedDraft as any, event, 'character:c-k4').draft as Entry
    })

    const firstAttempt = { ...original, comment: 'failed comment' }
    mountedDraft = cloneEntries([firstAttempt])[0]
    applyLorebookEntryDraftEdit(scope, 2, firstAttempt as any, 0)
    flushPendingLorebookEntryDraftEdit(scope)
    await vi.advanceTimersByTimeAsync(0)
    await flushServerCommandRecording()

    const secondAttempt = {
      ...(getDatabase().characters[0].globalLore as Entry[])[2],
      content: 'accepted newer content',
    }
    mountedDraft = cloneEntries([secondAttempt])[0]
    applyLorebookEntryDraftEdit(scope, 2, secondAttempt as any, 0)
    flushPendingLorebookEntryDraftEdit(scope)
    await vi.advanceTimersByTimeAsync(0)
    await flushServerCommandRecording()

    const commands = characterEntryCommands()
    expect(commands).toHaveLength(2)
    expect(commands[1].a).toMatchObject({
      entry: { comment: 'failed comment', content: 'accepted newer content' },
    })
    expect((commands[1].a as Record<string, unknown>).sparseUpdate).toBeUndefined()
    expect(durableRecorded.dispatched.map((dispatch) => dispatch.mutationId)).toEqual([
      'lore-mutation-1',
      'lore-mutation-2',
    ])
    expect(durableRecorded.dispatched[1].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks/entries/entry-2',
          body: { entry: expect.objectContaining({ content: 'accepted newer content' }) },
        },
      ],
    })

    firstResult.resolve({ status: 'error', error: 'first save failed' })
    await flushServerCommandRecording()
    await flushServerCommandRecording()

    expect((getDatabase().characters[0].globalLore as Entry[])[2]).toMatchObject({
      comment: original.comment,
      content: 'accepted newer content',
    })
    expect(mountedDraft).toMatchObject({
      comment: original.comment,
      content: 'accepted newer content',
    })
    stop()
  })

  it('rebases a later same-field rollback after two entry draft saves fail', async () => {
    const firstResult = createDeferred<{ status: string; error?: string }>()
    const secondResult = createDeferred<{ status: string; error?: string }>()
    recorded.commandResults.push(firstResult.promise, secondResult.promise)
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const originalContent = (getDatabase().characters[0].globalLore as Entry[])[2].content

    applyLorebookEntryDraftEdit(
      scope,
      2,
      { ...(getDatabase().characters[0].globalLore as Entry[])[2], content: 'first attempt' } as any,
      0,
    )
    flushPendingLorebookEntryDraftEdit(scope)
    await vi.advanceTimersByTimeAsync(0)
    await flushServerCommandRecording()

    applyLorebookEntryDraftEdit(
      scope,
      2,
      { ...(getDatabase().characters[0].globalLore as Entry[])[2], content: 'second attempt' } as any,
      0,
    )
    flushPendingLorebookEntryDraftEdit(scope)
    await vi.advanceTimersByTimeAsync(0)
    await flushServerCommandRecording()

    firstResult.resolve({ status: 'error', error: 'first save failed' })
    await flushServerCommandRecording()
    await flushServerCommandRecording()
    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toBe('second attempt')

    secondResult.resolve({ status: 'error', error: 'second save failed' })
    await flushServerCommandRecording()
    await flushServerCommandRecording()
    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toBe(originalContent)
  })

  it('owner flush sends pending lorebook replacements with keepalive and clears debounce', async () => {
    setupK4EditorDb()

    applyLorebookEntryDraftEdit(
      { kind: 'character', characterId: 'c-k4' },
      4,
      { ...(getDatabase().characters[0].globalLore as Entry[])[4], content: 'unload final' } as any,
      DELAY * 10,
    )
    expect(recorded.commands).toEqual([])
    expect(durableRecorded.staged).toHaveLength(1)
    expect(durableRecorded.staged[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'PUT',
          path: '/characters/c-k4/lorebooks/entries/entry-4',
          body: { patch: { content: 'unload final' } },
        },
      ],
    })
    flushPendingLorebookOwnerMutations({ keepalive: true })
    await vi.advanceTimersByTimeAsync(0)

    const cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].keepalive).toBe(true)
    expect(cmds[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'entry-4',
      entry: { id: 'entry-4', content: 'unload final' },
      sparseUpdate: { patch: { content: 'unload final' } },
    })
    expect(durableRecorded.dispatched[0].mutationId).toBe(durableRecorded.staged[0].mutationId)

    await vi.advanceTimersByTimeAsync(DELAY * 10)
    expect(characterEntryCommands()).toHaveLength(1)
  })

  it('immediate owner flush sends one replacement only', async () => {
    setupK4EditorDb()

    recorded.commands.length = 0
    applyLorebookEntryDraftEdit(
      { kind: 'character', characterId: 'c-k4' },
      3,
      { ...(getDatabase().characters[0].globalLore as Entry[])[3], content: 'blur final' } as any,
      DELAY * 10,
    )
    flushPendingLorebookEntryDraftEdit({ kind: 'character', characterId: 'c-k4' })
    await vi.advanceTimersByTimeAsync(0)

    const cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'entry-3',
      entry: { id: 'entry-3', content: 'blur final' },
      sparseUpdate: { patch: { content: 'blur final' } },
    })

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(characterEntryCommands()).toHaveLength(1)
  })

  it('module external entry drafts avoid collection clones and flush final module entry', async () => {
    setupK4ModuleDb()
    const module = (getDatabase().modules as any[])[0] as { lorebook: Entry[] }
    const collectionSize = JSON.stringify(module.lorebook).length
    const originalEntries = module.lorebook
    const untouchedSibling = module.lorebook[2]
    const editedEntry = module.lorebook[9]

    const instrumented = withCloneInstrumentation(() =>
      applyLorebookEntryDraftEdit(
        { kind: 'module', moduleId: 'module-k4' },
        9,
        { ...module.lorebook[9], content: 'module draft final' } as any,
        DELAY * 10,
      ),
    )

    expect(instrumented.result).toBe(true)
    expect(instrumented.maxClonedSize).toBeLessThan(collectionSize)
    expect(module.lorebook).toBe(originalEntries)
    expect(module.lorebook[2]).toBe(untouchedSibling)
    expect(module.lorebook[9]).toBe(editedEntry)
    expect(module.lorebook[9].content).toBe('module draft final')
    expect(moduleEntryCommands()).toHaveLength(0)

    flushPendingLorebookEntryDraftEdit({ kind: 'module', moduleId: 'module-k4' })
    await vi.advanceTimersByTimeAsync(0)

    const cmds = moduleEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      moduleId: 'module-k4',
      entryId: 'module-entry-9',
      entry: { id: 'module-entry-9', content: 'module draft final' },
      sparseUpdate: { patch: { content: 'module draft final' } },
    })

    await vi.advanceTimersByTimeAsync(DELAY * 10)
    expect(moduleEntryCommands()).toHaveLength(1)
  })

  it('Batch 5: activating a global lorebook locally assigns an id, creates child lore, and dispatches', async () => {
    setupActiveChatLocalActivationDb()
    const book = {
      key: 'parent-key',
      secondkey: '',
      insertorder: 100,
      comment: 'Parent lore',
      content: 'Parent content',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    } as Entry

    const applied = setActiveChatLorebookLocalActivation(book as any, true, DELAY)

    expect(applied).toBe(true)
    expect(book.id).toEqual(expect.any(String))
    expect(getDatabase().characters[0].chats[0].localLore).toEqual([
      {
        key: '',
        comment: '',
        content: '',
        mode: 'child',
        insertorder: 100,
        alwaysActive: true,
        secondkey: '',
        selective: false,
        id: book.id,
      },
    ])

    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = chatEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      chatId: 'active-chat',
      entryId: book.id,
      entry: {
        id: book.id,
        mode: 'child',
        alwaysActive: true,
      },
    })

    cmds[0].rollback?.()
    expect(getDatabase().characters[0].chats[0].localLore).toEqual([])
  })

  it('Batch 5: local activation dispatch uses the cloned activation snapshot after later live mutations', async () => {
    setupActiveChatLocalActivationDb()
    const book = {
      key: 'parent-key',
      secondkey: '',
      insertorder: 100,
      comment: 'Parent lore',
      content: 'Parent content',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    } as Entry

    const applied = setActiveChatLorebookLocalActivation(book as any, true, DELAY)
    const activatedId = book.id

    expect(applied).toBe(true)
    expect(activatedId).toEqual(expect.any(String))

    getDatabase().characters[0].chats[0].localLore.push({
      key: 'later',
      comment: 'Later mutation',
      content: 'This should not be in the delayed activation command',
      mode: 'normal',
      insertorder: 100,
      alwaysActive: false,
      secondkey: '',
      selective: false,
      id: 'later-live-entry',
    } as never)

    await vi.advanceTimersByTimeAsync(DELAY)

    const upserts = chatEntryCommands()
    expect(upserts).toHaveLength(1)
    expect(upserts[0].a).toMatchObject({
      chatId: 'active-chat',
      entryId: activatedId,
      entry: {
        id: activatedId,
        mode: 'child',
        alwaysActive: true,
      },
    })
    expect((upserts[0].a as { entry?: { id?: string } }).entry?.id).not.toBe('later-live-entry')
    expect(chatReplaceCommands()).toHaveLength(0)
  })

  it('Batch 5: deactivating a local activation removes the child lore and dispatches', async () => {
    setupActiveChatLocalActivationDb()
    getDatabase().characters[0].chats[0].localLore = [
      {
        key: '',
        comment: '',
        content: '',
        mode: 'child',
        insertorder: 100,
        alwaysActive: true,
        secondkey: '',
        selective: false,
        id: 'parent-entry',
      },
    ] as never

    const applied = setActiveChatLorebookLocalActivation({ id: 'parent-entry' } as any, false, DELAY)

    expect(applied).toBe(true)
    expect(getDatabase().characters[0].chats[0].localLore).toEqual([])

    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = chatEntryDeleteCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      chatId: 'active-chat',
      entryId: 'parent-entry',
    })
  })

  it('Batch 5: local activation is a no-op without a current chat id', async () => {
    setupActiveChatLocalActivationDb(null)
    const book = {
      key: 'parent-key',
      secondkey: '',
      insertorder: 100,
      comment: 'Parent lore',
      content: 'Parent content',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    } as Entry

    const applied = setActiveChatLorebookLocalActivation(book as any, true, DELAY)

    expect(applied).toBe(false)
    expect(book.id).toBeUndefined()
    expect(getDatabase().characters[0].chats[0].localLore).toEqual([])

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(recorded.commands).toHaveLength(0)
  })

  it('failed entry-draft rollback restores only the edited entry', () => {
    setupK4EditorDb()
    const previous = currentLorebookEntryScopedSnapshot({ kind: 'character', characterId: 'c-k4' }, 2)

    ;(getDatabase().characters[0].globalLore as Entry[])[2].content = 'failed optimistic edit'
    ;(getDatabase().characters[0].globalLore as Entry[])[4].content = 'same collection sibling edit'
    ;(getDatabase().characters[1].globalLore as Entry[])[0].content = 'other character edit'

    restoreLorebookEntryState(previous)

    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toContain('-2')
    expect((getDatabase().characters[0].globalLore as Entry[])[4].content).toBe('same collection sibling edit')
    expect((getDatabase().characters[1].globalLore as Entry[])[0].content).toBe('other character edit')
  })

  it('coalesced entry-draft rollback restores the first pre-edit collection', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const originalContents = (getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.content)

    applyLorebookEntryDraftEdit(
      scope,
      2,
      {
        ...(getDatabase().characters[0].globalLore as Entry[])[2],
        content: 'draft first entry',
      } as any,
      DELAY,
    )
    applyLorebookEntryDraftEdit(
      scope,
      4,
      {
        ...(getDatabase().characters[0].globalLore as Entry[])[4],
        content: 'draft second entry',
      } as any,
      DELAY,
    )

    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toBe('draft first entry')
    expect((getDatabase().characters[0].globalLore as Entry[])[4].content).toBe('draft second entry')

    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = characterReplaceCommands()
    expect(cmds).toHaveLength(1)
    expect((cmds[0].entries as Entry[])[2].content).toBe('draft first entry')
    expect((cmds[0].entries as Entry[])[4].content).toBe('draft second entry')

    cmds[0].rollback?.()

    expect((getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.content)).toEqual(originalContents)
  })

  it('collection operations still use collection-level replacement rollback', async () => {
    setupK4EditorDb()
    const previous = currentLorebookCollectionScopedSnapshot({
      kind: 'character',
      characterId: 'c-k4',
    })
    const originalIds = (getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.id)
    const reordered = [...(getDatabase().characters[0].globalLore as Entry[])]
    const moved = reordered.shift()
    if (moved) {
      moved.folder = 'folder-k4'
      reordered.push(moved)
    }

    getDatabase().characters[0].globalLore = reordered as any
    dispatchReplaceCharacterLorebooks('c-k4', reordered as any, previous, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = characterReplaceCommands()
    expect(cmds).toHaveLength(1)
    expect((cmds[0].entries as Entry[]).map((entry) => entry.id)).toEqual([...originalIds.slice(1), originalIds[0]])
    ;(getDatabase().characters[0].globalLore as Entry[])[1].content = 'collection failed edit'
    restoreLorebookState(previous)
    expect((getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.id)).toEqual(originalIds)
  })

  it('Batch 4: collection replacement helper owns the optimistic write, clone, dispatch, and rollback', async () => {
    setupK4EditorDb()
    const originalIds = (getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.id)
    const nextEntries = [
      ...(getDatabase().characters[0].globalLore as Entry[]),
      {
        id: 'helper-entry',
        key: 'helper',
        secondkey: '',
        insertorder: 100,
        comment: 'Helper',
        content: 'Helper lore',
        mode: 'normal',
        alwaysActive: false,
        selective: false,
      },
    ]

    const replaced = replaceCharacterLorebookCollection('c-k4', nextEntries as any, DELAY)

    expect(replaced).toBe(true)
    expect(getDatabase().characters[0].globalLore).not.toBe(nextEntries)
    expect((getDatabase().characters[0].globalLore as Entry[]).at(-1)?.content).toBe('Helper lore')

    nextEntries[nextEntries.length - 1].content = 'caller mutation after replace'
    expect((getDatabase().characters[0].globalLore as Entry[]).at(-1)?.content).toBe('Helper lore')

    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'helper-entry',
      entry: { id: 'helper-entry', content: 'Helper lore' },
    })

    cmds[0].rollback?.()
    expect((getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.id)).toEqual(originalIds)
  })

  it('settles every UI operation against the exact durable generation that coalesces it', async () => {
    setupK4EditorDb()
    const firstEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    firstEntries.push({ id: 'coalesced-entry', key: 'first', content: 'first change' })
    const first = replaceCharacterLorebookCollectionWithOutcome('c-k4', firstEntries as any, DELAY)
    expect(first?.scopeKey).toBe('character:c-k4')

    const secondEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    const moved = secondEntries.shift()
    if (moved) secondEntries.push(moved)
    const second = replaceCharacterLorebookCollectionWithOutcome('c-k4', secondEntries as any, DELAY)
    expect(second?.scopeKey).toBe('character:c-k4')

    let firstSettled = false
    void first?.settlement.then(() => {
      firstSettled = true
    })
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(durableRecorded.dispatched).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(DELAY)

    await expect(first?.settlement).resolves.toEqual({ status: 'accepted' })
    await expect(second?.settlement).resolves.toEqual({ status: 'accepted' })
    expect(durableRecorded.dispatched).toHaveLength(1)
    expect(durableRecorded.staged).toHaveLength(2)
    expect(durableRecorded.dispatched[0].intent).toEqual(durableRecorded.staged[1].intent)
  })

  it('classifies retained and terminal character collection generations for their exact UI operations', async () => {
    setupK4EditorDb()
    const retainedEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    retainedEntries[0].content = 'retained edit'
    recorded.commandResults.push(Promise.resolve({ status: 'unavailable' }))
    const retained = replaceCharacterLorebookCollectionWithOutcome('c-k4', retainedEntries as any, DELAY)

    await vi.advanceTimersByTimeAsync(DELAY)
    await expect(retained?.settlement).resolves.toEqual({ status: 'queued' })

    const rejectedEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    rejectedEntries[1].content = 'rejected edit'
    recorded.commandResults.push(
      Promise.resolve({ status: 'error', reason: 'invalid-request', error: 'invalid lorebook entry' }),
    )
    const rejected = replaceCharacterLorebookCollectionWithOutcome('c-k4', rejectedEntries as any, DELAY)

    await vi.advanceTimersByTimeAsync(DELAY)
    await expect(rejected?.settlement).resolves.toEqual({
      status: 'failed',
      error: 'invalid lorebook entry',
    })
  })

  it('rolls back the guarded optimistic collection when durable staging fails', async () => {
    setupK4EditorDb()
    const original = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    const attempted = cloneEntries(original)
    attempted.push({ id: 'unstaged-entry', key: 'unstaged', content: 'must roll back' })
    durableRecorded.stageError = new Error('outbox staging failed')

    const operation = replaceCharacterLorebookCollectionWithOutcome('c-k4', attempted as any, DELAY)

    await expect(operation?.settlement).resolves.toEqual({
      status: 'failed',
      error: 'outbox staging failed',
    })
    expect(getDatabase().characters[0].globalLore).toEqual(original)
    expect(durableRecorded.dispatched).toEqual([])
  })

  it('returns an exact settlement for active-chat local activation', async () => {
    setupCharacter([])
    getDatabase().characters[0].chats = [{ id: 'chat-local-outcome', localLore: [], message: [] }] as any
    getDatabase().characters[0].chatPage = 0
    const book = { id: 'character-lore', key: 'key', content: 'content', alwaysActive: false } as any
    recorded.commandResults.push(Promise.resolve({ status: 'unavailable' }))

    const activation = setActiveChatLorebookLocalActivationWithOutcome(book, true, DELAY)
    expect(activation?.scopeKey).toBe('chat:chat-local-outcome')
    await vi.advanceTimersByTimeAsync(DELAY)

    await expect(activation?.settlement).resolves.toEqual({ status: 'queued' })
    expect(chatEntryCommands()).toHaveLength(1)
  })

  it('targets chat-local cleanup by captured chat id after the active chat changes', async () => {
    setupCharacter([])
    getDatabase().characters[0].chats = [
      {
        id: 'chat-cleanup-captured',
        localLore: [{ id: 'cleanup-entry', mode: 'child', key: '', content: '' }],
        message: [],
      },
      { id: 'chat-cleanup-new-active', localLore: [], message: [] },
    ] as any
    getDatabase().characters[0].chatPage = 1

    const cleanup = setChatLorebookLocalActivationWithOutcome(
      'chat-cleanup-captured',
      { id: 'cleanup-entry', key: 'parent', content: 'parent content' } as any,
      false,
      DELAY,
    )

    expect(cleanup?.scopeKey).toBe('chat:chat-cleanup-captured')
    expect(getDatabase().characters[0].chats[0].localLore).toEqual([])
    expect(getDatabase().characters[0].chats[1].localLore).toEqual([])
    await vi.advanceTimersByTimeAsync(DELAY)
    await expect(cleanup?.settlement).resolves.toEqual({ status: 'accepted' })
    expect(chatEntryDeleteCommands()[0]?.a).toMatchObject({
      chatId: 'chat-cleanup-captured',
      entryId: 'cleanup-entry',
    })
  })

  it('passes queue-time projection epochs through compact and full scoped command paths', async () => {
    setupK4EditorDb()
    const characterRowEpoch = captureCharacterRowProjectionEpoch('c-k4')
    const characterLorebookEpoch = captureCharacterLorebookProjectionEpoch('c-k4')
    const characterEntries = getDatabase().characters[0].globalLore as Entry[]
    const characterPrevious = currentLorebookCollectionScopedSnapshot({ kind: 'character', characterId: 'c-k4' })
    characterEntries.push({
      id: 'character-new',
      key: 'new',
      secondkey: '',
      insertorder: 100,
      comment: 'New',
      content: 'new',
      mode: 'normal',
      alwaysActive: false,
      selective: false,
    } as Entry)
    dispatchReplaceCharacterLorebooks('c-k4', characterEntries as any, characterPrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(characterEntryCommands()[0].a).toMatchObject({
      acknowledgeOptimistic: true,
      optimisticRowEpoch: characterRowEpoch,
      optimisticLorebookEpoch: characterLorebookEpoch,
      optimisticEntries: expect.arrayContaining([expect.objectContaining({ id: 'character-new' })]),
    })

    recorded.commands.length = 0
    const chatEntries = getDatabase().characters[0].chats[0].localLore as Entry[]
    const chatPrevious = currentLorebookCollectionScopedSnapshot({ kind: 'chat', chatId: 'chat-k4' })
    chatEntries[0].content = 'chat edited'
    dispatchReplaceChatLorebooks('chat-k4', chatEntries as any, chatPrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(chatEntryCommands()[0].a).toMatchObject({
      acknowledgeOptimistic: true,
      optimisticCharacterId: 'c-k4',
      optimisticRowEpoch: characterRowEpoch,
      optimisticEntries: [expect.objectContaining({ id: 'chat-entry-0', content: 'chat edited' })],
    })

    recorded.commands.length = 0
    const globalEpoch = captureCollectionProjectionEpoch('loreBook')
    const globalEntries = getDatabase().loreBook[0].data as Entry[]
    const globalPrevious = currentLorebookCollectionScopedSnapshot({ kind: 'global', lorebookId: 'global-k4' })
    globalEntries[0].content = 'global first edit'
    globalEntries[1].content = 'global second edit'
    dispatchReplaceGlobalLorebookEntries('global-k4', globalEntries as any, globalPrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(globalEntryReplaceCommands()[0].a).toMatchObject({
      acknowledgeOptimistic: true,
      optimisticCollectionEpoch: globalEpoch,
      optimisticEntries: expect.arrayContaining([
        expect.objectContaining({ content: 'global first edit' }),
        expect.objectContaining({ content: 'global second edit' }),
      ]),
    })
  })

  it('retains the staged mutation after an authoritative lorebook replacement until exact settlement', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const queuedLorebookEpoch = captureCharacterLorebookProjectionEpoch('c-k4')
    const attemptedEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    attemptedEntries[2].content = 'attempted edit'

    applyLorebookEntryDraftEdit(scope, 2, attemptedEntries[2] as any, DELAY)
    expect(applyServerCharacterLorebookResource('c-k4', attemptedEntries)).toBe(true)
    markCharacterLorebookProjectionApplied('c-k4')
    await vi.advanceTimersByTimeAsync(DELAY)

    expect(queuedLorebookEpoch).toBeGreaterThanOrEqual(0)
    expect(characterEntryCommands()).toEqual([])
    expect(durableRecorded.acknowledged).toEqual([])
    expect(durableRecorded.settlementListeners.has('lore-mutation-1')).toBe(true)
    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toBe('attempted edit')

    publishLorebookSettlement('lore-mutation-1', 'accepted')
    expect(durableRecorded.settlementListeners.has('lore-mutation-1')).toBe(false)
  })

  it('starts a new coalesced rollback baseline after the relevant projection epoch changes', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const first = {
      ...(getDatabase().characters[0].globalLore as Entry[])[2],
      content: 'first queued edit',
    }
    applyLorebookEntryDraftEdit(scope, 2, first as any, DELAY)

    const authoritativeEntries = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    authoritativeEntries[2].content = 'authoritative baseline'
    expect(applyServerCharacterLorebookResource('c-k4', authoritativeEntries)).toBe(true)
    markCharacterLorebookProjectionApplied('c-k4')
    const replacementLorebookEpoch = captureCharacterLorebookProjectionEpoch('c-k4')

    const second = { ...authoritativeEntries[2], content: 'second queued edit' }
    applyLorebookEntryDraftEdit(scope, 2, second as any, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    const command = characterEntryCommands()[0]
    expect(command.a).toMatchObject({ optimisticLorebookEpoch: replacementLorebookEpoch })
    command.rollback?.()
    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toBe('authoritative baseline')
  })

  it('Batch 6: module collection draft helper owns live/draft optimistic write, dispatch, and rollback', async () => {
    setupK4ModuleDb()
    const liveModule = getDatabase().modules[0] as unknown as { id: string; lorebook: Entry[] }
    const draftModule = {
      id: liveModule.id,
      name: 'Draft Module',
      description: '',
      lorebook: cloneEntries(liveModule.lorebook),
    }
    const originalLive = cloneEntries(liveModule.lorebook)
    const nextEntries = cloneEntries(liveModule.lorebook)
    nextEntries[0].content = 'module helper first'
    nextEntries[1].content = 'module helper second'

    const replaced = replaceModuleLorebookCollectionDraft(liveModule.id, draftModule as any, nextEntries as any, DELAY)

    expect(replaced).toBe(true)
    expect(liveModule.lorebook).not.toBe(nextEntries)
    expect(draftModule.lorebook).not.toBe(nextEntries)
    expect(draftModule.lorebook).toEqual(liveModule.lorebook)
    expect(liveModule.lorebook[0].content).toBe('module helper first')
    expect(draftModule.lorebook[1].content).toBe('module helper second')

    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = moduleReplaceCommands()
    expect(cmds).toHaveLength(1)
    expect(cmds[0].moduleId).toBe(liveModule.id)
    expect((cmds[0].entries as Entry[]).slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'module-entry-0', content: 'module helper first' }),
      expect.objectContaining({ id: 'module-entry-1', content: 'module helper second' }),
    ])

    cmds[0].rollback?.()
    expect(liveModule.lorebook).toEqual(originalLive)
  })

  it('Batch 6: module collection draft helper returns false for missing module id without mutation or command', async () => {
    setupK4ModuleDb()
    const liveModule = getDatabase().modules[0] as unknown as { lorebook: Entry[] }
    const originalLive = cloneEntries(liveModule.lorebook)
    const draftModule = {
      id: '',
      name: 'Draft Module',
      description: '',
      lorebook: [{ id: 'draft-entry', content: 'draft original' }] as Entry[],
    }
    const originalDraft = cloneEntries(draftModule.lorebook)

    const replaced = replaceModuleLorebookCollectionDraft(
      '',
      draftModule as any,
      [{ content: 'replacement' }] as any,
      DELAY,
    )

    expect(replaced).toBe(false)
    expect(liveModule.lorebook).toEqual(originalLive)
    expect(draftModule.lorebook).toEqual(originalDraft)

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(moduleReplaceCommands()).toHaveLength(0)
    expect(moduleEntryCommands()).toHaveLength(0)
  })

  it('Batch 6: module collection draft helper normalizes create-mode drafts without dispatching before create', async () => {
    setupK4ModuleDb()
    const draftModule = {
      id: 'module-new',
      name: 'Draft Module',
      description: '',
      lorebook: [{ content: 'draft original' }] as Entry[],
    }

    const replaced = replaceModuleLorebookCollectionDraft(
      draftModule.id,
      draftModule as any,
      [{ content: 'replacement' }] as any,
      DELAY,
    )

    expect(replaced).toBe(true)
    expect(draftModule.lorebook).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        content: 'replacement',
      }),
    ])

    await vi.advanceTimersByTimeAsync(DELAY)
    expect(moduleReplaceCommands()).toHaveLength(0)
    expect(moduleEntryCommands()).toHaveLength(0)
  })

  it('Batch 6: module collection draft helper freezes the delayed command payload', async () => {
    setupK4ModuleDb()
    const liveModule = getDatabase().modules[0] as unknown as { id: string; lorebook: Entry[] }
    const draftModule = {
      id: liveModule.id,
      name: 'Draft Module',
      description: '',
      lorebook: cloneEntries(liveModule.lorebook),
    }
    const nextEntries = cloneEntries(liveModule.lorebook)
    nextEntries[0].content = 'queued first'
    nextEntries[1].content = 'queued second'

    const replaced = replaceModuleLorebookCollectionDraft(liveModule.id, draftModule as any, nextEntries as any, DELAY)

    expect(replaced).toBe(true)
    liveModule.lorebook[0].content = 'late live mutation'
    draftModule.lorebook[1].content = 'late draft mutation'
    liveModule.lorebook.push({
      id: 'late-entry',
      key: 'late',
      content: 'late push',
    })

    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = moduleReplaceCommands()
    expect(cmds).toHaveLength(1)
    expect((cmds[0].entries as Entry[]).map((entry) => entry.content).slice(0, 2)).toEqual([
      'queued first',
      'queued second',
    ])
    expect((cmds[0].entries as Entry[]).some((entry) => entry.id === 'late-entry')).toBe(false)
  })

  it('simple collection delete and pure reorder use compact entry commands', async () => {
    setupK4EditorDb()
    const entries = getDatabase().characters[0].globalLore as Entry[]

    const deletePrevious = currentLorebookCollectionScopedSnapshot({
      kind: 'character',
      characterId: 'c-k4',
    })
    entries.splice(3, 1)
    dispatchReplaceCharacterLorebooks('c-k4', entries as any, deletePrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    const deletes = characterEntryDeleteCommands()
    expect(deletes).toHaveLength(1)
    expect(deletes[0].a).toMatchObject({
      characterId: 'c-k4',
      entryId: 'entry-3',
      acknowledgeOptimistic: true,
      optimisticEntries: expect.not.arrayContaining([expect.objectContaining({ id: 'entry-3' })]),
    })
    expect(durableRecorded.dispatched[0].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'DELETE',
          path: '/characters/c-k4/lorebooks/entries/entry-3',
          body: {},
        },
      ],
    })

    recorded.commands.length = 0
    const reorderPrevious = currentLorebookCollectionScopedSnapshot({
      kind: 'character',
      characterId: 'c-k4',
    })
    const moved = entries.shift()
    if (moved) entries.push(moved)
    dispatchReplaceCharacterLorebooks('c-k4', entries as any, reorderPrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    const reorders = characterEntryReorderCommands()
    expect(reorders).toHaveLength(1)
    expect(reorders[0].a).toMatchObject({
      characterId: 'c-k4',
      entryIds: entries.map((entry) => entry.id),
      acknowledgeOptimistic: true,
      optimisticEntries: entries,
    })
    expect(durableRecorded.dispatched[1].intent).toEqual({
      version: 1,
      requests: [
        {
          method: 'POST',
          path: '/characters/c-k4/lorebooks/entries/reorder',
          body: { entryIds: entries.map((entry) => entry.id) },
        },
      ],
    })
  })

  it('stages every full-collection scope with the exact command method, path, and body', async () => {
    const scenarios: Array<{
      ownerKey: string
      path: string
      setup: () => { entries: Entry[]; dispatch: (previous: ReturnType<typeof currentLorebookStateSnapshot>) => void }
    }> = [
      {
        ownerKey: 'character-owner:c0',
        path: '/characters/c0/lorebooks',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().characters[0].globalLore as Entry[]
          return {
            entries,
            dispatch: (previous) => dispatchReplaceCharacterLorebooks('c0', entries as any, previous, 0),
          }
        },
      },
      {
        ownerKey: 'character-owner:c0',
        path: '/chats/c0chat/lorebooks',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().characters[0].chats[0].localLore as Entry[]
          return {
            entries,
            dispatch: (previous) => dispatchReplaceChatLorebooks('c0chat', entries as any, previous, 0),
          }
        },
      },
      {
        ownerKey: 'lorebook:global:g1',
        path: '/lorebooks/g1/entries',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().loreBook[0].data as Entry[]
          return {
            entries,
            dispatch: (previous) => dispatchReplaceGlobalLorebookEntries('g1', entries as any, previous, 0),
          }
        },
      },
      {
        ownerKey: 'module-owner:m0',
        path: '/modules/m0/lorebooks',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().modules[0].lorebook as Entry[]
          return { entries, dispatch: (previous) => dispatchReplaceModuleLorebooks('m0', entries as any, previous, 0) }
        },
      },
    ]

    for (const scenario of scenarios) {
      const { entries, dispatch } = scenario.setup()
      const previous = currentLorebookCollectionScopedSnapshot(
        scenario.path.startsWith('/characters/')
          ? { kind: 'character', characterId: 'c0' }
          : scenario.path.startsWith('/chats/')
            ? { kind: 'chat', chatId: 'c0chat' }
            : scenario.path.startsWith('/lorebooks/')
              ? { kind: 'global', lorebookId: 'g1' }
              : { kind: 'module', moduleId: 'm0' },
      )
      entries[0].content = 'compound update'
      entries.push({ id: `${scenario.path.replace(/\W/g, '')}-new`, key: 'new', content: 'compound create' })
      dispatch(previous)
      expect(durableRecorded.staged.at(-1)?.key).toBe(scenario.ownerKey)
      await vi.advanceTimersByTimeAsync(0)

      expect(durableRecorded.dispatched.at(-1)?.intent).toEqual({
        version: 1,
        ...(scenario.path.startsWith('/lorebooks/')
          ? { dependencyKeys: [GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY] }
          : {}),
        requests: [{ method: 'PUT', path: scenario.path, body: { entries: cloneEntries(entries) } }],
      })
    }
  })

  it('stale failed creates remove only unchanged attempted entries across scoped collections', async () => {
    const cases: Array<{
      label: string
      path: string
      setup: () => {
        entries: Entry[]
        attemptedId: string
        command: () => { rollback?: () => void } | undefined
      }
    }> = [
      {
        label: 'character',
        path: '/characters/c0/lorebooks/entries/character-created-entry',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().characters[0].globalLore as Entry[]
          const attemptedId = 'character-created-entry'
          const previous = currentLorebookCollectionScopedSnapshot({ kind: 'character', characterId: 'c0' })
          entries.push({ id: attemptedId, key: 'created', content: 'attempted character create' })
          dispatchReplaceCharacterLorebooks('c0', entries as any, previous, DELAY)
          return { entries, attemptedId, command: () => characterEntryCommands()[0] }
        },
      },
      {
        label: 'chat',
        path: '/chats/c0chat/lorebooks/entries/chat-created-entry',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().characters[0].chats[0].localLore as Entry[]
          const attemptedId = 'chat-created-entry'
          const previous = currentLorebookCollectionScopedSnapshot({ kind: 'chat', chatId: 'c0chat' })
          entries.push({ id: attemptedId, key: 'created', content: 'attempted chat create' })
          dispatchReplaceChatLorebooks('c0chat', entries as any, previous, DELAY)
          return { entries, attemptedId, command: () => chatEntryCommands()[0] }
        },
      },
      {
        label: 'global',
        path: '/lorebooks/g1/entries/global-created-entry',
        setup: () => {
          setupMultiCollectionDb()
          const entries = getDatabase().loreBook[0].data as Entry[]
          const attemptedId = 'global-created-entry'
          const previous = currentLorebookCollectionScopedSnapshot({ kind: 'global', lorebookId: 'g1' })
          entries.push({ id: attemptedId, key: 'created', content: 'attempted global create' })
          dispatchReplaceGlobalLorebookEntries('g1', entries as any, previous, DELAY)
          return { entries, attemptedId, command: () => globalEntryCommands()[0] }
        },
      },
      {
        label: 'module',
        path: '/modules/m0/lorebooks/entries/module-created-entry',
        setup: () => {
          setupMultiCollectionDb()
          const module = getDatabase().modules[0] as unknown as { lorebook: Entry[] }
          const entries = module.lorebook
          const attemptedId = 'module-created-entry'
          const previous = currentLorebookCollectionScopedSnapshot({ kind: 'module', moduleId: 'm0' })
          entries.push({ id: attemptedId, key: 'created', content: 'attempted module create' })
          dispatchReplaceModuleLorebooks('m0', entries as any, previous, DELAY)
          return { entries, attemptedId, command: () => moduleEntryCommands()[0] }
        },
      },
    ]

    for (const scenario of cases) {
      recorded.commands.length = 0
      const { entries, attemptedId, command } = scenario.setup()

      await vi.advanceTimersByTimeAsync(DELAY)
      const queued = command()
      expect(queued?.rollback).toEqual(expect.any(Function))
      expect(durableRecorded.dispatched.at(-1)?.intent).toEqual({
        version: 1,
        ...(scenario.path.startsWith('/lorebooks/')
          ? { dependencyKeys: [GLOBAL_LOREBOOK_SELECTION_MUTATION_KEY] }
          : {}),
        requests: [
          {
            method: 'PUT',
            path: scenario.path,
            body: { entry: entries.find((entry) => entry.id === attemptedId) },
          },
        ],
      })

      entries[0].content = `${scenario.label} newer sibling edit`
      entries.push({
        id: `${scenario.label}-later-entry`,
        key: 'later',
        content: `${scenario.label} later append`,
      })

      queued?.rollback?.()

      expect(entries.map((entry) => entry.id)).not.toContain(attemptedId)
      expect(entries.map((entry) => entry.id)).toContain(`${scenario.label}-later-entry`)
      expect(entries[0].content).toBe(`${scenario.label} newer sibling edit`)
    }
  })

  it('stale failed updates restore only attempted rows and skip newer same-row edits', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const originalEntry2Content = (getDatabase().characters[0].globalLore as Entry[])[2].content

    const previous = currentLorebookCollectionScopedSnapshot(scope)
    const attempted = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    attempted[2].content = 'attempted update'
    getDatabase().characters[0].globalLore = attempted as any
    dispatchReplaceCharacterLorebooks('c-k4', attempted as any, previous, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    let cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    ;(getDatabase().characters[0].globalLore as Entry[])[4].content = 'newer sibling edit'
    cmds[0].rollback?.()

    expect((getDatabase().characters[0].globalLore as Entry[])[2].content).toBe(originalEntry2Content)
    expect((getDatabase().characters[0].globalLore as Entry[])[4].content).toBe('newer sibling edit')

    recorded.commands.length = 0
    const secondPrevious = currentLorebookCollectionScopedSnapshot(scope)
    const secondAttempted = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    secondAttempted[3].content = 'attempted second update'
    getDatabase().characters[0].globalLore = secondAttempted as any
    dispatchReplaceCharacterLorebooks('c-k4', secondAttempted as any, secondPrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    cmds = characterEntryCommands()
    expect(cmds).toHaveLength(1)
    ;(getDatabase().characters[0].globalLore as Entry[])[3].content = 'newer same-row edit'
    ;(getDatabase().characters[0].globalLore as Entry[])[5].content = 'newer sibling after second'
    cmds[0].rollback?.()

    expect((getDatabase().characters[0].globalLore as Entry[])[3].content).toBe('newer same-row edit')
    expect((getDatabase().characters[0].globalLore as Entry[])[5].content).toBe('newer sibling after second')
  })

  it('stale failed deletes reinsert only still-missing entries and preserve newer entries', async () => {
    setupK4EditorDb()
    const entries = getDatabase().characters[0].globalLore as Entry[]
    const previous = currentLorebookCollectionScopedSnapshot({ kind: 'character', characterId: 'c-k4' })
    const deleted = cloneEntries([entries[3]])[0]

    entries.splice(3, 1)
    dispatchReplaceCharacterLorebooks('c-k4', entries as any, previous, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    const deletes = characterEntryDeleteCommands()
    expect(deletes).toHaveLength(1)
    entries[0].content = 'newer edit before delete rollback'
    entries.push({ id: 'post-delete-entry', key: 'post-delete', content: 'post delete append' })

    deletes[0].rollback?.()

    expect(entries[3]).toMatchObject(deleted)
    expect(entries[0].content).toBe('newer edit before delete rollback')
    expect(entries.at(-1)?.id).toBe('post-delete-entry')
  })

  it('stale failed reorders restore prior order only while live order matches the attempt', async () => {
    setupK4EditorDb()
    const entries = getDatabase().characters[0].globalLore as Entry[]
    const originalIds = entries.map((entry) => entry.id)
    const previous = currentLorebookCollectionScopedSnapshot({ kind: 'character', characterId: 'c-k4' })
    const moved = entries.shift()
    if (moved) entries.push(moved)
    const attemptedIds = entries.map((entry) => entry.id)

    dispatchReplaceCharacterLorebooks('c-k4', entries as any, previous, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    let reorders = characterEntryReorderCommands()
    expect(reorders).toHaveLength(1)
    entries[2].content = 'content changed while order is attempted'
    const changedEntryId = entries[2].id
    reorders[0].rollback?.()

    expect(entries.map((entry) => entry.id)).toEqual(originalIds)
    expect(entries.find((entry) => entry.id === changedEntryId)?.content).toBe(
      'content changed while order is attempted',
    )

    recorded.commands.length = 0
    const secondPrevious = currentLorebookCollectionScopedSnapshot({ kind: 'character', characterId: 'c-k4' })
    const movedAgain = entries.pop()
    if (movedAgain) entries.unshift(movedAgain)
    dispatchReplaceCharacterLorebooks('c-k4', entries as any, secondPrevious, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    reorders = characterEntryReorderCommands()
    expect(reorders).toHaveLength(1)
    entries.reverse()
    const newerOrder = entries.map((entry) => entry.id)
    expect(newerOrder).not.toEqual(attemptedIds)

    reorders[0].rollback?.()

    expect(entries.map((entry) => entry.id)).toEqual(newerOrder)
  })

  it('module lorebook helper rollback preserves newer sibling edits and appended entries', async () => {
    setupK4ModuleDb()
    const liveModule = getDatabase().modules[0] as unknown as { id: string; lorebook: Entry[] }
    const draftModule = {
      id: liveModule.id,
      name: 'Draft Module',
      description: '',
      lorebook: cloneEntries(liveModule.lorebook),
    }
    const originalFirstContent = liveModule.lorebook[0].content
    const nextEntries = cloneEntries(liveModule.lorebook)
    nextEntries[0].content = 'attempted module helper update'

    const replaced = replaceModuleLorebookCollectionDraft(liveModule.id, draftModule as any, nextEntries as any, DELAY)
    expect(replaced).toBe(true)
    await vi.advanceTimersByTimeAsync(DELAY)

    const cmds = moduleEntryCommands()
    expect(cmds).toHaveLength(1)
    liveModule.lorebook[1].content = 'newer module sibling edit'
    liveModule.lorebook.push({ id: 'module-later-entry', key: 'later', content: 'module later append' })

    cmds[0].rollback?.()

    expect(liveModule.lorebook[0].content).toBe(originalFirstContent)
    expect(liveModule.lorebook[1].content).toBe('newer module sibling edit')
    expect(liveModule.lorebook.map((entry) => entry.id)).toContain('module-later-entry')
  })

  it('does not dispatch a pending module draft after an authoritative module projection', async () => {
    setupK4ModuleDb()
    const scope = { kind: 'module', moduleId: 'module-k4' } as const
    const attempted = {
      ...(getDatabase().modules[0].lorebook as Entry[])[0],
      content: 'stale pending module draft',
    }

    expect(applyLorebookEntryDraftEdit(scope, 0, attempted as any, DELAY)).toBe(true)
    expect((getDatabase().modules[0].lorebook as Entry[])[0].content).toBe('stale pending module draft')

    const projectedEntries = cloneEntries(getDatabase().modules[0].lorebook as Entry[])
    projectedEntries[0].content = 'authoritative module projection'
    expect(
      applyCollectionsResource(
        {
          revision: 7,
          collections: {
            modules: [
              {
                id: 'module-k4',
                name: 'Projected Module',
                description: '',
                lorebook: projectedEntries,
              },
            ] as never,
          },
        },
        'modules',
      ),
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(DELAY)

    expect(moduleEntryCommands()).toHaveLength(0)
    expect(moduleReplaceCommands()).toHaveLength(0)
    expect((getDatabase().modules[0].lorebook as Entry[])[0].content).toBe('authoritative module projection')
  })

  it('full-replace fallback skips rollback after live collection diverges from the attempt', async () => {
    setupK4EditorDb()
    const scope = { kind: 'character', characterId: 'c-k4' } as const
    const previous = currentLorebookCollectionScopedSnapshot(scope)
    const attempted = cloneEntries(getDatabase().characters[0].globalLore as Entry[])
    attempted[0].content = 'attempted complex update'
    attempted[1] = {
      id: 'complex-replacement-entry',
      key: 'complex',
      content: 'attempted complex replacement',
    }

    getDatabase().characters[0].globalLore = attempted as any
    dispatchReplaceCharacterLorebooks('c-k4', attempted as any, previous, DELAY)
    await vi.advanceTimersByTimeAsync(DELAY)

    const replaces = characterReplaceCommands()
    expect(replaces).toHaveLength(1)
    ;(getDatabase().characters[0].globalLore as Entry[])[0].content = 'newer divergence'
    ;(getDatabase().characters[0].globalLore as Entry[]).push({
      id: 'complex-later-entry',
      key: 'later',
      content: 'newer append',
    })

    replaces[0].rollback?.()

    expect((getDatabase().characters[0].globalLore as Entry[])[0].content).toBe('newer divergence')
    expect((getDatabase().characters[0].globalLore as Entry[])[1].id).toBe('complex-replacement-entry')
    expect((getDatabase().characters[0].globalLore as Entry[]).map((entry) => entry.id)).toContain(
      'complex-later-entry',
    )
  })
})

it.each([false, true])(
  'retains lorebook intent without dispatch after demotion (repromoted: %s)',
  async (repromoted) => {
    setupCharacter([{ id: 'entry-1', key: 'a', content: 'Original' }] as Entry[])
    markCharacterLorebookHydrated('c1')
    enterClientWriter()
    expect(
      applyLorebookEntryDraftEdit(
        { kind: 'character', characterId: 'c1' },
        0,
        { id: 'entry-1', key: 'a', content: 'Pending' } as any,
        DELAY,
      ),
    ).toBe(true)
    const staged = [...durableRecorded.staged]
    expect(staged).toHaveLength(1)
    demoteClientSession()
    if (repromoted) repromoteClientWriter()
    await vi.advanceTimersByTimeAsync(DELAY * 2)
    flushPendingLorebookOwnerMutations()
    expect(durableRecorded.staged).toEqual(staged)
    expect(durableRecorded.dispatched).toEqual([])
    expect(durableRecorded.acknowledged).toEqual([])
    expect(recorded.commands).toEqual([])
  },
)
