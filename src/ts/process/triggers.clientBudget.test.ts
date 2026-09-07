import {
  beginClientSession,
  settleClientReader,
  authorizeClientWriterRecovery,
  setClientConnectionState,
  setClientProjectionReady,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
} from '../clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

vi.mock('./modules', async (importActual) => {
  const actual = await importActual<typeof import('./modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

import '../stores.svelte'
import { safeStructuredClone } from '../polyfill'

import { CurrentTriggerIdStore, selectedCharID } from '../stores.svelte'
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import type { character } from '../storage/database.svelte'
import { createTriggerExecutionBudget, runTrigger } from './triggers'
function seedDb(): void {
  selectedCharID.set(0)
  testDatabaseState.db = {
    characters: [
      {
        chaId: 'char-a',
        name: 'Character',
        desc: '',
        chatPage: 0,
        chats: [{ id: 'chat-1', message: [], note: '', name: 'main', localLore: [], scriptstate: {} }],
        triggerscript: [],
        defaultVariables: '',
        globalLore: [],
        type: 'character',
      },
    ],
    characterOrder: [],
    templateDefaultVariables: '',
  } as any
}

function characterWithTriggers(triggerscript: unknown[]): character {
  return { ...testDatabaseState.db.characters[0], triggerscript } as unknown as character
}

beforeEach(() => {
  resetClientSessionForTests()
  ;(globalThis as Record<string, unknown>).safeStructuredClone = safeStructuredClone
  CurrentTriggerIdStore.set(null)
  seedDb()
})

afterEach(() => {
  resetClientSessionForTests()
  CurrentTriggerIdStore.set(null)
  selectedCharID.set(-1)
})

describe('client trigger execution budget', () => {
  it('manual v2Loop stops at the shared client trigger budget', async () => {
    const char = characterWithTriggers([
      {
        comment: 'spin',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2Loop', indent: 0 },
          {
            type: 'v2SetVar',
            var: 'loopCount',
            operator: '+=',
            valueType: 'value',
            value: '1',
            indent: 1,
          },
          { type: 'v2EndIndent', endOfLoop: true, indent: 1 },
        ],
      },
    ])
    const budget = createTriggerExecutionBudget({
      wallClockMs: Number.POSITIVE_INFINITY,
      maxEffectSteps: 1000,
      maxLoopBackEdges: 3,
    })

    const result = await runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'spin',
      triggerBudget: budget,
      deferLiveChatSideEffects: true,
    })

    expect(result?.triggerStoppedReason).toBe('loopBackEdges')
    expect(budget.stoppedReason).toBe('loopBackEdges')
    expect(Number(result?.chat.scriptstate?.$loopCount)).toBeGreaterThan(0)
  })

  it('manual trigger abort signal interrupts v2Wait before later effects', async () => {
    const char = characterWithTriggers([
      {
        comment: 'wait',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2Wait', valueType: 'value', value: '1', indent: 0 },
          {
            type: 'v2SetVar',
            var: 'afterWait',
            operator: '=',
            valueType: 'value',
            value: 'ran',
            indent: 0,
          },
        ],
      },
    ])
    const budget = createTriggerExecutionBudget({
      wallClockMs: Number.POSITIVE_INFINITY,
      maxEffectSteps: 1000,
      maxLoopBackEdges: 1000,
    })
    const controller = new AbortController()

    const run = runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'wait',
      signal: controller.signal,
      triggerBudget: budget,
      deferLiveChatSideEffects: true,
    })
    setTimeout(() => controller.abort(), 0)

    const result = await run

    expect(result?.triggerStoppedReason).toBe('aborted')
    expect(budget.stoppedReason).toBe('aborted')
    expect(result?.chat.scriptstate?.$afterWait).toBeUndefined()
  })

  it('manual v2Wait wakes at the wall-clock budget without an abort signal', async () => {
    const char = characterWithTriggers([
      {
        comment: 'wait-budget',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2Wait', valueType: 'value', value: '1', indent: 0 },
          {
            type: 'v2SetVar',
            var: 'afterBudgetWait',
            operator: '=',
            valueType: 'value',
            value: 'ran',
            indent: 0,
          },
        ],
      },
    ])
    const budget = createTriggerExecutionBudget({
      wallClockMs: 1,
      maxEffectSteps: 1000,
      maxLoopBackEdges: 1000,
    })

    const result = await runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'wait-budget',
      triggerBudget: budget,
      deferLiveChatSideEffects: true,
    })

    expect(result?.triggerStoppedReason).toBe('wallClock')
    expect(budget.stoppedReason).toBe('wallClock')
    expect(result?.chat.scriptstate?.$afterBudgetWait).toBeUndefined()
  })

  it('completed manual trigger keeps trigger id for post-run display refresh', async () => {
    const char = characterWithTriggers([
      {
        comment: 'show-id',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2SetVar',
            var: 'ran',
            operator: '=',
            valueType: 'value',
            value: 'yes',
            indent: 0,
          },
        ],
      },
    ])
    CurrentTriggerIdStore.set('previous-id')

    const result = await runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'show-id',
      triggerId: 'button-42',
      deferLiveChatSideEffects: true,
    })

    expect(result?.triggerStoppedReason).toBeUndefined()
    expect(result?.chat.scriptstate?.$ran).toBe('yes')
    expect(get(CurrentTriggerIdStore)).toBe('button-42')
  })
})

function enterScriptWriter(epoch = 1): void {
  const operation = beginClientSession('script-writer')
  authorizeClientWriterRecovery(operation, {
    databaseLineage: 'lineage',
    writer: { sessionId: 'script-writer', epoch },
  })
  setClientConnectionState('live')
  setClientProjectionReady(true)
  completeClientWriterRecovery(operation)
}

describe('connected trigger continuation authority', () => {
  it('rejects reader entry before changing current trigger or variables', async () => {
    const char = characterWithTriggers([])
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage', writer: { sessionId: 'other', epoch: 1 } })
    await expect(runTrigger(char, 'manual', { chat: char.chats[0], triggerId: 'must-not-set' })).rejects.toThrow(
      'client_write_access_required',
    )
    expect(get(CurrentTriggerIdStore)).toBe(null)
  })
  it('does not execute the next trigger effect after a wait spans demotion and reacquisition', async () => {
    enterScriptWriter()
    const char = characterWithTriggers([
      {
        comment: 'wait',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2Wait', valueType: 'value', value: '0.01', indent: 0 },
          { type: 'v2SetVar', var: 'late', operator: '=', valueType: 'value', value: 'changed', indent: 0 },
        ],
      },
    ])
    const run = runTrigger(char, 'manual', { chat: char.chats[0], manualName: 'wait' })
    demoteClientSession()
    enterScriptWriter(2)
    await expect(run).rejects.toThrow('client_write_operation_stale')
    expect(char.chats[0].scriptstate).not.toHaveProperty('$late')
  })
})
