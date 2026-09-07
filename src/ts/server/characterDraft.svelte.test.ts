import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => ({
  results: [] as Array<Promise<{ status: string; error?: string }>>,
  stages: [] as Array<{ key: string; intent: Record<string, unknown>; handle: Record<string, any> }>,
  updates: [] as Array<{
    characterId: string
    patch: Record<string, unknown>
    keepalive?: boolean
    mutationId?: string
  }>,
  nextMutationId: 0,
}))

vi.mock('./commands', async (importActual) => ({
  ...(await importActual<typeof import('./commands')>()),
  canUseServerCommands: () => true,
}))

vi.mock('./pendingMutationOutbox', () => ({
  acknowledgePendingMutation: vi.fn(async () => 'deleted'),
  stagePendingMutation: (key: string, intent: Record<string, unknown>, previous?: Record<string, any>) => {
    const handle = {
      key,
      mutationId: previous?.mutationId ?? `character-draft-${++recorded.nextMutationId}`,
      phase: 'staged',
    }
    recorded.stages.push({ key, intent: structuredClone(intent), handle })
    return handle
  },
}))

vi.mock('./durableMutationDispatch', () => ({
  dispatchDurableMutation: async (
    handle: Record<string, any>,
    _intent: Record<string, unknown>,
    dispatch: (transport: { mutationId: string; databaseLineage: string }) => Promise<unknown>,
  ) => dispatch({ mutationId: handle.mutationId, databaseLineage: 'draft-test-lineage' }),
}))

vi.mock('../characterCommands', async (importActual) => {
  const actual = await importActual<typeof import('../characterCommands')>()
  return {
    ...actual,
    dispatchUpdateCharacter: (
      characterId: string,
      patch: Record<string, unknown>,
      previous: unknown,
      rollback: (snapshot: unknown) => void,
      options?: { keepalive?: boolean; mutationId?: string },
    ) => {
      recorded.updates.push({
        characterId,
        patch: structuredClone(patch),
        ...(options?.keepalive ? { keepalive: true } : {}),
        mutationId: options?.mutationId,
      })
      const result = recorded.results.shift() ?? Promise.resolve({ status: 'ok' })
      return result.then((outcome) => {
        if (outcome.status !== 'ok') rollback(previous)
        return outcome
      })
    },
  }
})

import { selectedCharID } from '../stores.svelte'
import { mergeServerResourceCharacterRow, setDatabaseLite, type Database } from '../storage/database.svelte'
import { charactersResourceState } from './resourceState.svelte'
import {
  createCharacterOwnerDraft,
  flushPendingCharacterDraftPatches,
  type CharacterOwnerDraft,
} from './characterDraft.svelte'
import { getResourceDatabase } from 'src/ts/__tests__/resourceDatabaseState'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function characterRow(id: string, name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chaId: id,
    name,
    desc: `${name} description`,
    chats: [{ id: `${id}-chat`, name: 'Chat', message: [] }],
    globalLore: [],
    ...fields,
  }
}

function seed(rows: Array<Record<string, unknown>>, selected = 0): void {
  setDatabaseLite({ currentChar: selected, characters: rows } as unknown as Database)
  selectedCharID.set(selected)
}

async function mountDraft(keys: readonly string[]): Promise<{ draft: CharacterOwnerDraft; stop: () => void }> {
  let draft: CharacterOwnerDraft | undefined
  const stop = $effect.root(() => {
    draft = createCharacterOwnerDraft(keys, { delayMs: 50 })
  })
  flushSync()
  await Promise.resolve()
  if (!draft) throw new Error('draft did not initialize')
  return { draft, stop }
}

async function settleEffects(): Promise<void> {
  flushSync()
  await Promise.resolve()
  flushSync()
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.useFakeTimers()
  recorded.results.length = 0
  recorded.stages.length = 0
  recorded.updates.length = 0
  recorded.nextMutationId = 0
})

afterEach(() => {
  resetClientSessionForTests()
  flushPendingCharacterDraftPatches()
  vi.useRealTimers()
  selectedCharID.set(-1)
  setDatabaseLite({} as Database)
})

describe('character owner draft', () => {
  it('fails closed until a unique ready character owner exists', async () => {
    seed([characterRow('duplicate', 'First'), characterRow('duplicate', 'Second')])
    const duplicate = await mountDraft(['name'])

    expect(duplicate.draft.characterId).toBeNull()
    expect(duplicate.draft.value.name).toBe('')
    duplicate.draft.value.name = 'Ambiguous edit'
    await settleEffects()
    expect(getResourceDatabase().characters.map((row) => row.name)).toEqual(['First', 'Second'])
    duplicate.stop()

    seed([characterRow('ready', 'Loading')])
    charactersResourceState.status = 'loading'
    const loading = await mountDraft(['name'])
    expect(loading.draft.characterId).toBeNull()
    expect(loading.draft.value.name).toBe('')
    loading.stop()
  })

  it('applies and persists a sanitized stable-id owner patch', async () => {
    seed([characterRow('char-a', 'Initial')])
    const { draft, stop } = await mountDraft(['chaId', 'name', 'desc'])

    draft.value.chaId = 'malicious-id'
    draft.value.name = 'Edited'
    draft.value.desc = 'Edited description'
    await settleEffects()

    expect(getResourceDatabase().characters[0]).toMatchObject({
      chaId: 'char-a',
      name: 'Edited',
      desc: 'Edited description',
    })
    expect(recorded.stages).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(50)

    expect(recorded.updates).toEqual([
      {
        characterId: 'char-a',
        patch: { name: 'Edited', desc: 'Edited description' },
        mutationId: 'character-draft-1',
      },
    ])
    stop()
  })

  it('coalesces draft edits and supports an explicit keepalive flush', async () => {
    seed([characterRow('char-a', 'Initial')])
    const { draft, stop } = await mountDraft(['name', 'desc'])

    draft.value.name = 'First name'
    await settleEffects()
    draft.value.name = 'Final name'
    draft.value.desc = 'Final description'
    await settleEffects()

    expect(recorded.stages).toHaveLength(2)
    expect(recorded.stages[1].handle.mutationId).toBe('character-draft-1')

    flushPendingCharacterDraftPatches({ keepalive: true })
    await Promise.resolve()

    expect(recorded.updates).toEqual([
      {
        characterId: 'char-a',
        patch: { name: 'Final name', desc: 'Final description' },
        keepalive: true,
        mutationId: 'character-draft-1',
      },
    ])
    await vi.advanceTimersByTimeAsync(50)
    expect(recorded.updates).toHaveLength(1)
    stop()
  })

  it('rolls back only the rejected attempted field in both owner and mounted draft', async () => {
    const failure = deferred<{ status: string; error?: string }>()
    recorded.results.push(failure.promise)
    seed([characterRow('char-a', 'Server name', { desc: 'Server description' })])
    const { draft, stop } = await mountDraft(['name', 'desc'])

    draft.value.name = 'Rejected name'
    await settleEffects()
    await vi.advanceTimersByTimeAsync(50)
    expect(getResourceDatabase().characters[0].name).toBe('Rejected name')

    getResourceDatabase().characters[0].desc = 'Newer description'
    failure.resolve({ status: 'error', error: 'rejected' })
    await settleEffects()
    await settleEffects()

    expect(getResourceDatabase().characters[0]).toMatchObject({
      name: 'Server name',
      desc: 'Newer description',
    })
    expect(draft.value.name).toBe('Server name')
    stop()
  })

  it('refreshes clean fields from an authoritative row while retaining a dirty field', async () => {
    seed([characterRow('char-a', 'Initial', { desc: 'Initial description' })])
    const { draft, stop } = await mountDraft(['name', 'desc'])

    draft.value.name = 'Pending name'
    await settleEffects()

    expect(
      mergeServerResourceCharacterRow(
        characterRow('char-a', 'Stale server', { desc: 'Fresh server description' }) as any,
      ),
    ).toBe(true)
    await settleEffects()

    expect(draft.value.name).toBe('Pending name')
    expect(draft.value.desc).toBe('Fresh server description')
    expect(getResourceDatabase().characters[0]).toMatchObject({
      name: 'Pending name',
      desc: 'Fresh server description',
    })
    stop()
  })

  it('persists deletion of a deletable profile field', async () => {
    seed([characterRow('char-a', 'Initial', { loreSettings: { scanDepth: 4 } })])
    const { draft, stop } = await mountDraft(['loreSettings'])

    draft.value.loreSettings = null
    draft.value = { ...draft.value }
    await settleEffects()
    await vi.advanceTimersByTimeAsync(50)

    expect(getResourceDatabase().characters[0]).not.toHaveProperty('loreSettings')
    expect(recorded.updates[0].patch).toEqual({ loreSettings: null })
    stop()
  })
})

it.each([false, true])('keeps staged character edits dormant after demotion (repromoted: %s)', async (repromoted) => {
  seed([characterRow('char-a', 'Original')])
  enterClientWriter()
  const mounted = await mountDraft(['name'])
  try {
    mounted.draft.value.name = 'Pending writer edit'
    await settleEffects()
    const staged = [...recorded.stages]
    expect(staged).toHaveLength(1)
    demoteClientSession()
    if (repromoted) repromoteClientWriter()
    await vi.advanceTimersByTimeAsync(100)
    flushPendingCharacterDraftPatches()
    expect(recorded.stages).toEqual(staged)
    expect(recorded.updates).toEqual([])
    expect(mounted.draft.value.name).toBe('Pending writer edit')
  } finally {
    mounted.stop()
  }
})

it('does not apply a draft effect that runs after demotion and re-promotion', async () => {
  seed([characterRow('char-a', 'Original')])
  enterClientWriter()
  const mounted = await mountDraft(['name'])
  try {
    mounted.draft.value.name = 'Unflushed writer draft'
    demoteClientSession()
    repromoteClientWriter()
    await settleEffects()
    expect(getResourceDatabase().characters[0].name).toBe('Original')
    expect(mounted.draft.value.name).toBe('Unflushed writer draft')
    expect(recorded.stages).toEqual([])
    expect(recorded.updates).toEqual([])
  } finally {
    mounted.stop()
  }
})
