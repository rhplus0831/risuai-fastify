import { demoteClientSession, resetClientSessionForTests } from '../clientSession'
import { enterClientWriter, repromoteClientWriter } from '../__tests__/clientSession'
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recorded = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; input: Record<string, any>; keepalive?: boolean }>,
  nextMutationId: 0,
  results: [] as Array<Promise<Record<string, any>> | Record<string, any>>,
  staged: [] as Array<{ key: string; intent: Record<string, unknown>; mutationId: string }>,
}))

vi.mock('./pendingMutationOutbox', () => ({
  acknowledgePendingMutation: vi.fn(async () => 'deleted'),
  stagePendingMutation: (key: string, intent: Record<string, unknown>, previous?: Record<string, any>) => {
    const mutationId = previous?.mutationId ?? `script-owner-${++recorded.nextMutationId}`
    const handle = { key, mutationId, phase: 'staged' }
    recorded.staged.push({ key, intent: structuredClone(intent), mutationId })
    return handle
  },
}))

vi.mock('./durableMutationDispatch', () => ({
  registerDurableMutationSettlementListener: () => () => {},
  dispatchDurableMutation: async (
    handle: Record<string, any>,
    _intent: Record<string, unknown>,
    dispatch: (transport: Record<string, unknown>) => Promise<unknown>,
  ) => dispatch({ mutationId: handle.mutationId, databaseLineage: 'script-test-lineage' }),
}))

vi.mock('./commands', () => {
  const run = async (command: string, input: Record<string, any>, keepalive?: boolean) => {
    recorded.calls.push({ command, input: structuredClone(input), ...(keepalive ? { keepalive: true } : {}) })
    return (await (recorded.results.shift() ?? { status: 'ok', revision: recorded.calls.length })) as any
  }
  return {
    canUseServerCommands: () => true,
    mutateCharacterScriptsCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('mutateCharacterScripts', input, keepalive),
    mutateCharacterTriggersCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('mutateCharacterTriggers', input, keepalive),
    mutateGlobalScriptsCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('mutateGlobalScripts', input, keepalive),
    mutateModuleScriptsCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('mutateModuleScripts', input, keepalive),
    mutateModuleTriggersCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('mutateModuleTriggers', input, keepalive),
    patchSettingsGroup: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('patchSettingsGroup', input, keepalive),
    replaceCharacterScriptsCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('replaceCharacterScripts', input, keepalive),
    replaceCharacterTriggersCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('replaceCharacterTriggers', input, keepalive),
    replaceModuleScriptsCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('replaceModuleScripts', input, keepalive),
    replaceModuleTriggersCommand: (input: Record<string, any>, _signal: unknown, keepalive?: boolean) =>
      run('replaceModuleTriggers', input, keepalive),
    runServerCommand: async (input: {
      command: (baseRevision: number) => Promise<Record<string, any>>
      rollback?: () => void
    }) => {
      const result = await input.command(1)
      if (result.status !== 'ok') input.rollback?.()
      return result
    },
  }
})

import { setDatabaseLite, type Database } from '../storage/database.svelte'
import {
  applyCharacterScriptDefinitionDraft,
  applyModuleScriptDefinitionDraft,
  ensureClientScriptDefinitionIds,
  flushPendingScriptDefinitionMutations,
  scheduleCharacterScriptDefinitionDraft,
  waitForPendingCharacterScriptDefinitionSave,
  watchGlobalScriptOwnerDraft,
} from './scriptDefinitionOwner.svelte'
import { charactersResourceState, collectionsResourceState, settingsResourceState } from './resourceState.svelte'

function script(id: string, input: string): Record<string, any> {
  return { id, comment: id, in: input, out: `${input}-out`, type: 'editinput' }
}

function trigger(id: string): Record<string, any> {
  return { id, comment: id, type: 'output', code: `${id}()` }
}

function seed(): void {
  setDatabaseLite({
    currentChar: 0,
    globalscript: [script('global-a', 'global')],
    characters: [
      {
        chaId: 'char-a',
        name: 'Character',
        chats: [{ id: 'chat-a', name: 'Chat', message: [] }],
        customscript: [script('char-script-a', 'character')],
        triggerscript: [trigger('char-trigger-a')],
      },
    ],
    modules: [
      {
        id: 'module-a',
        name: 'Module',
        regex: [script('module-script-a', 'module')],
        trigger: [trigger('module-trigger-a')],
      },
    ],
  } as unknown as Database)
}

async function settle(): Promise<void> {
  flushSync()
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  flushSync()
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.useFakeTimers()
  recorded.calls.length = 0
  recorded.results.length = 0
  recorded.staged.length = 0
  recorded.nextMutationId = 0
  seed()
})

afterEach(() => {
  resetClientSessionForTests()
  flushPendingScriptDefinitionMutations()
  vi.useRealTimers()
  setDatabaseLite({} as Database)
})

describe('script definition owners', () => {
  it('assigns stable unique ids to client definitions', () => {
    const definitions = ensureClientScriptDefinitionIds([
      script('duplicate', 'a'),
      script('duplicate', 'b'),
      { comment: 'missing', in: '', out: '', type: 'editinput' },
    ] as any)

    expect(definitions.map((definition) => definition.id).every(Boolean)).toBe(true)
    expect(new Set(definitions.map((definition) => definition.id)).size).toBe(3)
  })

  it('applies and persists character script and trigger owner drafts', async () => {
    const scripts = [script('char-script-a', 'edited'), script('char-script-b', 'added')]
    const triggers = [trigger('char-trigger-a'), trigger('char-trigger-b')]

    expect(applyCharacterScriptDefinitionDraft('char-a', scripts as any, triggers as any, 50)).toBe(true)
    expect(charactersResourceState.characters[0]).toMatchObject({ customscript: scripts, triggerscript: triggers })

    await vi.advanceTimersByTimeAsync(50)

    expect(recorded.calls.map((call) => call.command).sort()).toEqual([
      'mutateCharacterTriggers',
      'replaceCharacterScripts',
    ])
    expect(recorded.staged.map((entry) => entry.key).sort()).toEqual([
      'character-owner:char-a',
      'character-owner:char-a',
    ])
  })

  it('applies and persists module definition drafts without an aggregate watcher', async () => {
    const module = collectionsResourceState.values.modules?.[0] as any
    const scripts = [script('module-script-a', 'edited')]
    const triggers = [trigger('module-trigger-a'), trigger('module-trigger-b')]

    expect(applyModuleScriptDefinitionDraft('module-a', module, scripts as any, triggers as any, 50)).toBe(true)
    expect(module).toMatchObject({ regex: scripts, trigger: triggers })

    await vi.advanceTimersByTimeAsync(50)

    expect(recorded.calls.map((call) => call.command).sort()).toEqual(['mutateModuleScripts', 'mutateModuleTriggers'])
  })

  it('coalesces a character editor draft before cloning and dispatch', async () => {
    const first = [script('char-script-a', 'first')]
    const final = [script('char-script-a', 'final')]

    expect(scheduleCharacterScriptDefinitionDraft('char-a', first as any, [] as any, 50)).toBe(true)
    expect(scheduleCharacterScriptDefinitionDraft('char-a', final as any, [] as any, 50)).toBe(true)
    expect(recorded.staged).toEqual([])

    await vi.advanceTimersByTimeAsync(50)
    flushPendingScriptDefinitionMutations()
    await settle()

    expect(charactersResourceState.characters[0].customscript).toEqual(final)
    expect(recorded.calls.map((call) => call.command)).toContain('mutateCharacterScripts')
  })

  it('reports the immediate final save outcome for pending character definitions', async () => {
    scheduleCharacterScriptDefinitionDraft('char-a', [script('char-script-a', 'saved')] as any, [] as any, 60_000)

    await expect(waitForPendingCharacterScriptDefinitionSave('char-a')).resolves.toBe('saved')
    expect(recorded.calls.map((call) => call.command)).toContain('mutateCharacterScripts')
  })

  it('watches only the explicit global-script owner draft', async () => {
    const stop = watchGlobalScriptOwnerDraft({ delayMs: 50 })
    flushSync()

    const globals = settingsResourceState.value.globalscript as Array<Record<string, any>>
    globals[0] = script('global-a', 'edited')
    flushSync()
    await vi.advanceTimersByTimeAsync(50)

    expect(recorded.calls).toHaveLength(1)
    expect(recorded.calls[0]).toMatchObject({ command: 'mutateGlobalScripts' })
    stop()
  })

  it('flushes pending owner mutations with keepalive', async () => {
    applyCharacterScriptDefinitionDraft(
      'char-a',
      [script('char-script-a', 'keepalive')] as any,
      [trigger('char-trigger-a')] as any,
      60_000,
    )

    flushPendingScriptDefinitionMutations({ keepalive: true })
    await settle()

    expect(recorded.calls).toHaveLength(1)
    expect(recorded.calls[0]).toMatchObject({ command: 'mutateCharacterScripts', keepalive: true })
  })

  it('rolls back only a terminally rejected attempted definition set', async () => {
    recorded.results.push({ status: 'error', error: 'rejected' })
    const previous = JSON.parse(JSON.stringify(charactersResourceState.characters[0].customscript))

    applyCharacterScriptDefinitionDraft(
      'char-a',
      [script('char-script-a', 'rejected')] as any,
      charactersResourceState.characters[0].triggerscript ?? [],
      0,
    )
    await settle()

    expect(charactersResourceState.characters[0].customscript).toEqual(previous)
  })
})

it.each([false, true])(
  'retains scheduled script drafts without applying them after demotion (repromoted: %s)',
  async (repromoted) => {
    enterClientWriter()
    expect(
      scheduleCharacterScriptDefinitionDraft(
        'char-a',
        [script('char-script-a', 'deferred')] as any,
        [trigger('char-trigger-a')] as any,
        50,
      ),
    ).toBe(true)
    demoteClientSession()
    if (repromoted) repromoteClientWriter()
    await vi.advanceTimersByTimeAsync(100)
    flushPendingScriptDefinitionMutations()
    expect(charactersResourceState.characters[0].customscript[0].in).toBe('character')
    expect(recorded.staged).toEqual([])
    expect(recorded.calls).toEqual([])
  },
)

it.each([false, true])(
  'retains staged script replacement intent without dispatch after demotion (repromoted: %s)',
  async (repromoted) => {
    enterClientWriter()
    expect(
      applyCharacterScriptDefinitionDraft(
        'char-a',
        [script('char-script-a', 'pending')] as any,
        [trigger('char-trigger-a')] as any,
        50,
      ),
    ).toBe(true)
    const staged = structuredClone(recorded.staged)
    expect(staged).toHaveLength(1)
    demoteClientSession()
    if (repromoted) repromoteClientWriter()
    await vi.advanceTimersByTimeAsync(100)
    flushPendingScriptDefinitionMutations()
    expect(recorded.staged).toEqual(staged)
    expect(recorded.calls).toEqual([])
    expect(charactersResourceState.characters[0].customscript[0].in).toBe('pending')
  },
)
