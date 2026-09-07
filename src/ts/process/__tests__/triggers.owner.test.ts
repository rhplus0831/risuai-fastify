import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression coverage: trigger data effects that mutate durable character,
// persona, chat, and lorebook state must route through explicit owners and
// typed commands instead of an aggregate database.

vi.mock('../../platform', async (importActual) => {
  const actual = await importActual<typeof import('../../platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'trigger-command-token',
}))

vi.mock('../modules', async (importActual) => {
  const actual = await importActual<typeof import('../modules')>()
  return { ...actual, getModuleTriggers: () => [], moduleUpdate: () => {} }
})

const coordinateAcceptedChatSendMock = vi.hoisted(() => vi.fn(async () => ({ status: 'generated' as const })))
vi.mock('../acceptedSendCoordinator.svelte', () => ({
  coordinateAcceptedChatSend: coordinateAcceptedChatSendMock,
}))

vi.mock('src/ts/activeChatGenerationSettings', () => ({
  guardActiveChatGenerationSettingsForSend: vi.fn(() => ({ status: 'ok' })),
}))

import { safeStructuredClone } from '../../polyfill'
import { testDatabaseState } from '../../__tests__/resourceDatabaseState'
import { runTrigger } from '../triggers'
import { clearCachedServerCommandRevision } from '../../server/commands'

import { selectedCharID } from '../../stores.svelte'
import type { character } from '../../storage/database.svelte'
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

function stubCommandFetch(options: { failPersonaPatch?: boolean } = {}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url.startsWith('/api/v1/commands/characters/')) {
        return jsonResponse({
          revision: 11,
          event: { type: 'character.updated', revision: 11, resource: 'character' },
        })
      }
      if (url.startsWith('/api/v1/commands/personas/')) {
        if (options.failPersonaPatch) {
          return jsonResponse({ error: 'persona patch failed' }, 500)
        }
        return jsonResponse({
          revision: 11,
          event: { type: 'persona.updated', revision: 11, resource: 'persona' },
        })
      }
      if (url.includes('/lorebooks')) {
        return jsonResponse({
          revision: 11,
          event: { type: 'lorebook.replaced', revision: 11, resource: 'lorebook' },
        })
      }
      if (url.startsWith('/api/v1/commands/chats/')) {
        return jsonResponse({
          revision: 11,
          event: { type: 'chat.updated', revision: 11, resource: 'chat' },
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function seedDatabase(): void {
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
    selectedPersona: 0,
    selectedPersonaId: 'persona-a',
    personas: [{ id: 'persona-a', name: 'Persona', personaPrompt: '', icon: '', note: '' }],
    personaPrompt: '',
    username: 'Persona',
    userIcon: '',
    userNote: '',
  } as any
}

function characterWithTriggers(triggerscript: unknown[]): character {
  return { ...testDatabaseState.db.characters[0], triggerscript } as unknown as character
}

beforeEach(() => {
  // Re-establish the global the SPA bootstrap installs; afterEach's
  // vi.unstubAllGlobals() clears it between tests.
  ;(globalThis as Record<string, unknown>).safeStructuredClone = safeStructuredClone
  clearCachedServerCommandRevision()
  coordinateAcceptedChatSendMock.mockReset().mockResolvedValue({ status: 'generated' })
  seedDatabase()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('trigger durable writes through explicit owners', () => {
  it('awaits the accepted-send outcome for STScript /multisend', async () => {
    const calls = stubCommandFetch()
    const generation = deferred<{ status: 'generated' }>()
    coordinateAcceptedChatSendMock.mockReturnValueOnce(generation.promise)
    const char = characterWithTriggers([
      {
        comment: 'scripted multisend',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2Command', valueType: 'value', value: '/multisend scripted row' }],
      },
    ])

    let settled = false
    const triggerRun = runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'scripted multisend',
    }).then((result) => {
      settled = true
      return result
    })
    await waitFor(() => coordinateAcceptedChatSendMock.mock.calls.length === 1)

    expect(settled).toBe(false)
    expect(coordinateAcceptedChatSendMock).toHaveBeenCalledWith({
      clientGeneration: expect.any(Number),
      target: expect.objectContaining({ characterId: 'char-a', chatId: 'chat-1' }),
      append: expect.objectContaining({ status: 'ok', messageId: expect.any(String) }),
    })
    expect(
      calls.filter((call) => call.url === '/api/v1/commands/chats/chat-1/messages' && call.method === 'POST'),
    ).toHaveLength(1)

    generation.resolve({ status: 'generated' })
    await expect(triggerRun).resolves.toBeTruthy()
    expect(settled).toBe(true)
  })

  it('keeps readonly display trigger rows immutable while attaching low-level metadata', async () => {
    const trigger = Object.freeze({
      comment: 'readonly display',
      type: 'display',
      conditions: [],
      effect: [],
    })
    const char = characterWithTriggers([trigger])

    await expect(
      runTrigger(char, 'display', {
        chat: char.chats[char.chatPage],
        displayMode: true,
        displayData: 'shown',
      }),
    ).resolves.toMatchObject({ displayData: 'shown' })

    expect('lowLevelAccess' in trigger).toBe(false)
  })

  it('routes v2SetCharacterDesc through its character owner command', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'desc',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2SetCharacterDesc', valueType: 'value', value: 'updated desc' }],
      },
    ])

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'desc' }),
    ).resolves.not.toThrow()

    const patch = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/characters/char-a' && call.method === 'PATCH',
    )
    expect(patch.body.patch.desc).toBe('updated desc')
  })

  it('routes v2SetPersonaDesc through its persona owner command', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'persona',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2SetPersonaDesc', valueType: 'value', value: 'persona prompt' }],
      },
    ])

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'persona' }),
    ).resolves.not.toThrow()

    const patch = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/personas/persona-a' && call.method === 'PATCH',
    )
    expect(patch.body.patch.personaPrompt).toBe('persona prompt')
    expect(patch.body.mirrorLegacyProfile).toBe(false)
  })

  it('rolls back v2SetPersonaDesc optimism when the persona command fails', async () => {
    testDatabaseState.db.personaPrompt = 'legacy prompt before trigger'
    testDatabaseState.db.personas[0].personaPrompt = 'saved prompt before trigger'
    const selectedPersona = testDatabaseState.db.selectedPersona
    const calls = stubCommandFetch({ failPersonaPatch: true })
    const char = characterWithTriggers([
      {
        comment: 'persona-fail',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2SetPersonaDesc', valueType: 'value', value: 'trigger prompt' }],
      },
    ])

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'persona-fail' }),
    ).resolves.not.toThrow()

    const patch = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/personas/persona-a' && call.method === 'PATCH',
    )
    expect(patch.body.patch.personaPrompt).toBe('trigger prompt')
    expect(patch.body.mirrorLegacyProfile).toBe(false)

    await waitFor(
      () =>
        testDatabaseState.db.personaPrompt === 'legacy prompt before trigger' &&
        testDatabaseState.db.personas[selectedPersona]?.personaPrompt === 'saved prompt before trigger',
    )

    expect(testDatabaseState.db.personaPrompt).toBe('legacy prompt before trigger')
    expect(testDatabaseState.db.personas[selectedPersona]?.personaPrompt).toBe('saved prompt before trigger')
  })

  it('routes v2ModifyLorebook through its lorebook owner command', async () => {
    testDatabaseState.db.characters[0].globalLore = [['lore-key', 'old content']] as any
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'lore',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2ModifyLorebook',
            targetType: 'value',
            target: 'lore-key',
            valueType: 'value',
            value: 'new content',
          },
        ],
      },
    ])
    char.globalLore = [['lore-key', 'old content']] as any

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'lore' }),
    ).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/characters/char-a/lorebooks' && call.method === 'PUT',
    )
    expect(cmd.body.entries).toBeDefined()
  })

  it('routes v2CreateLorebook through its lorebook owner command', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'create-lore',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2CreateLorebook',
            nameType: 'value',
            name: 'new-lore',
            keyType: 'value',
            key: 'my-key',
            contentType: 'value',
            content: 'my-content',
            insertOrderType: 'value',
            insertOrder: '100',
          },
        ],
      },
    ])

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'create-lore' }),
    ).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) =>
        /\/api\/v1\/commands\/characters\/char-a\/lorebooks\/entries\/[^/]+$/.test(call.url) && call.method === 'PUT',
    )
    expect(cmd.body.entry).toMatchObject({
      key: 'my-key',
      comment: 'new-lore',
      content: 'my-content',
    })
  })

  it('routes v2DeleteLorebookByIndex through its lorebook owner command', async () => {
    testDatabaseState.db.characters[0].globalLore = [
      { key: 'k', comment: 'entry', content: 'c', mode: 'normal', insertorder: 100 },
    ] as any
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'delete-lore',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2DeleteLorebookByIndex',
            indexType: 'value',
            index: '0',
          },
        ],
      },
    ])
    char.globalLore = [{ key: 'k', comment: 'entry', content: 'c', mode: 'normal', insertorder: 100 }] as any

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'delete-lore' }),
    ).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/characters/char-a/lorebooks' && call.method === 'PUT',
    )
    expect(cmd.body.entries).toBeDefined()
    expect(cmd.body.entries.length).toBe(0)
  })

  it('routes v2SetLorebookAlwaysActive through its lorebook owner command', async () => {
    testDatabaseState.db.characters[0].globalLore = [
      { key: 'k', comment: 'entry', content: 'c', mode: 'normal', insertorder: 100, alwaysActive: false },
    ] as any
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'always-active',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2SetLorebookAlwaysActive',
            indexType: 'value',
            index: '0',
            value: true,
          },
        ],
      },
    ])
    char.globalLore = [
      { key: 'k', comment: 'entry', content: 'c', mode: 'normal', insertorder: 100, alwaysActive: false },
    ] as any

    await expect(
      runTrigger(char, 'manual', {
        chat: char.chats[char.chatPage],
        manualName: 'always-active',
      }),
    ).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/characters/char-a/lorebooks' && call.method === 'PUT',
    )
    expect(cmd.body.entries).toBeDefined()
  })

  it('routes v2SetAuthorNote through its chat owner command', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'note',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2SetAuthorNote', valueType: 'value', value: 'author note text' }],
      },
    ])

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'note' }),
    ).resolves.not.toThrow()

    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1' && call.method === 'PATCH',
    )
    expect(cmd.body.patch.note).toBe('author note text')
  })

  it('routes v2SetVar scriptstate through its chat owner and command', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'set',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2SetVar', var: 'score', operator: '=', valueType: 'value', value: '7' }],
      },
    ])

    // The optimistic live write targets the chat owner before durable dispatch.
    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'set' }),
    ).resolves.not.toThrow()

    // The optimistic write landed on the live active chat's scriptstate.
    expect((testDatabaseState.db.characters[0].chats[0].scriptstate as any).$score).toBe('7')

    // ...and the scriptstate patch was dispatched to the chat scriptstate command.
    const cmd = await waitForCommand(
      calls,
      (call) => call.url === '/api/v1/commands/chats/chat-1/scriptstate' && call.method === 'PATCH',
    )
    expect(cmd.body.patch.$score).toBe('7')
  })

  it('skips an identical v2SetVar without dispatching a scriptstate command', async () => {
    const calls = stubCommandFetch()
    testDatabaseState.db.characters[0].chats[0].scriptstate = { $score: '7' }
    const char = characterWithTriggers([
      {
        comment: 'set-same',
        type: 'manual',
        conditions: [],
        effect: [{ type: 'v2SetVar', var: 'score', operator: '=', valueType: 'value', value: '7' }],
      },
    ])

    const result = await runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'set-same',
    })

    expect((result?.chat.scriptstate as Record<string, string>).$score).toBe('7')
    expect(calls.filter((call) => call.url.endsWith('/scriptstate'))).toHaveLength(0)
  })

  it('keeps guarded deferred var and author-note side effects on the returned chat', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'deferred',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2SetVar', var: 'score', operator: '=', valueType: 'value', value: '7' },
          { type: 'v2SetAuthorNote', valueType: 'value', value: 'deferred note' },
        ],
      },
    ])

    const result = await runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'deferred',
      isFresh: () => true,
      deferLiveChatSideEffects: true,
    })

    expect((result?.chat.scriptstate as any).$score).toBe('7')
    expect(result?.chat.note).toBe('deferred note')
    expect((testDatabaseState.db.characters[0].chats[0].scriptstate as any).$score).toBeUndefined()
    expect(testDatabaseState.db.characters[0].chats[0].note).toBe('')
    expect(calls.filter((call) => call.url.startsWith('/api/v1/commands/chats/'))).toHaveLength(0)
  })

  it('stops guarded trigger effects once the target is stale', async () => {
    const calls = stubCommandFetch()
    const char = characterWithTriggers([
      {
        comment: 'stale',
        type: 'manual',
        conditions: [],
        effect: [
          { type: 'v2SetVar', var: 'score', operator: '=', valueType: 'value', value: '7' },
          { type: 'v2SetCharacterDesc', valueType: 'value', value: 'stale desc' },
        ],
      },
    ])

    const result = await runTrigger(char, 'manual', {
      chat: char.chats[char.chatPage],
      manualName: 'stale',
      isFresh: () => false,
      deferLiveChatSideEffects: true,
    })

    expect(result?.chat.scriptstate).toEqual({})
    expect(testDatabaseState.db.characters[0].desc).toBe('')
    expect(calls.filter((call) => call.url.startsWith('/api/v1/commands/'))).toHaveLength(0)
  })
})

describe('trigger lorebook scoped rollback', () => {
  it('restores only the one character globalLore when the lorebook command fails', async () => {
    // two characters with distinct globalLore; a whole-array rollback would clone
    // and re-write both, the scoped rollback touches only the edited character.
    selectedCharID.set(0)
    testDatabaseState.db = {
      characters: [
        {
          chaId: 'char-a',
          name: 'A',
          chatPage: 0,
          chats: [{ id: 'chat-1', message: [], note: '', name: 'main', localLore: [], scriptstate: {} }],
          triggerscript: [],
          globalLore: [['k', 'old content']],
          type: 'character',
        },
        {
          chaId: 'char-b',
          name: 'B',
          chatPage: 0,
          chats: [],
          triggerscript: [],
          globalLore: [['sib', 'sibling content']],
          type: 'character',
        },
      ],
      characterOrder: [],
    } as any

    const calls: CapturedFetch[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
          url,
          method: init.method ?? 'GET',
          body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
        if (url.includes('/lorebooks')) return jsonResponse({ error: 'nope' }, 500)
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )
    const char = characterWithTriggers([
      {
        comment: 'lore',
        type: 'manual',
        conditions: [],
        effect: [
          {
            type: 'v2ModifyLorebook',
            targetType: 'value',
            target: 'k',
            valueType: 'value',
            value: 'new content',
          },
        ],
      },
    ])
    char.globalLore = [['k', 'old content']] as any

    await expect(
      runTrigger(char, 'manual', { chat: char.chats[char.chatPage], manualName: 'lore' }),
    ).resolves.not.toThrow()

    // the optimistic edit is applied to the selected character's row
    expect((testDatabaseState.db.characters[0].globalLore as any)[0][1]).toBe('new content')

    // the lorebook PUT fires then fails, restoring only char-a's globalLore
    await waitForCommand(calls, (c) => c.url.includes('/lorebooks') && c.method === 'PUT')
    await waitFor(() => (testDatabaseState.db.characters[0].globalLore as any)?.[0]?.[1] === 'old content')

    expect((testDatabaseState.db.characters[0].globalLore as any)[0][1]).toBe('old content')
    // the sibling character's lorebook was never part of the scoped rollback
    expect((testDatabaseState.db.characters[1].globalLore as any)[0][1]).toBe('sibling content')
  })
})
