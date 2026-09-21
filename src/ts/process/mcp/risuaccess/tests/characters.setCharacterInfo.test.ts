import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// MCP character writes apply an immediate owner projection and keep rollback.

const alertConfirmSpy = vi.hoisted(() => vi.fn(async () => true))

vi.mock('src/ts/platform', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/platform')>()
  return { ...actual, isFastifyServer: true }
})

vi.mock('src/ts/storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'mcp-character-token',
}))

vi.mock('src/ts/alert', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/alert')>()
  return { ...actual, alertConfirm: alertConfirmSpy }
})

import { clearCachedServerCommandRevision } from 'src/ts/server/commands'

import { replaceResourceDatabase as setDatabaseLite } from 'src/ts/server/resourceState.svelte'
import { resetLorebookHydration } from 'src/ts/server/lorebookOwner.svelte'
import { SERVER_CHARACTER_SHELL_MARKER, type character } from 'src/ts/storage/database.svelte'
import { selectedCharID } from 'src/ts/stores.svelte'
import { seedCloneCostDb } from 'src/ts/__tests__/cloneCostHarness'
import { CharacterHandler } from '../characters'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

interface CapturedFetch {
  url: string
  method: string
  body: any
}

interface StubCommandFetchOptions {
  characterDetail?: character
  characterLorebook?: unknown[]
  failureStatusByUrl?: Record<string, number>
  holdUrls?: string[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubCommandFetch(options: StubCommandFetchOptions = {}): {
  calls: CapturedFetch[]
  releaseHeldResponses: () => void
} {
  const calls: CapturedFetch[] = []
  const heldResponses: Array<() => void> = []
  const holdUrls = new Set(options.holdUrls ?? [])
  let revision = 10
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
      if (url === '/api/v1/characters/char-1' && options.characterDetail) {
        return jsonResponse({ revision: 10, character: options.characterDetail })
      }
      if (url === '/api/v1/characters/char-1/lorebook' && options.characterLorebook) {
        return jsonResponse({
          revision: 10,
          characterId: 'char-1',
          globalLore: options.characterLorebook,
        })
      }
      if (url.startsWith('/api/v1/commands/characters/char-1')) {
        const buildResponse = () => {
          const failureStatus = options.failureStatusByUrl?.[url]
          if (failureStatus) return jsonResponse({ error: 'nope' }, failureStatus)
          revision += 1
          return jsonResponse({
            revision,
            event: { type: 'character.updated', revision, resource: 'character' },
          })
        }
        if (holdUrls.has(url)) {
          return await new Promise<Response>((resolve) => {
            heldResponses.push(() => {
              resolve(buildResponse())
            })
          })
        }
        return buildResponse()
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return {
    calls,
    releaseHeldResponses: () => {
      for (const release of heldResponses.splice(0)) {
        release()
      }
    },
  }
}

function toolText(result: Awaited<ReturnType<CharacterHandler['handle']>>): string {
  const content = result?.[0]
  expect(content).toMatchObject({ type: 'text' })
  return (content as { text: string }).text
}

function parseToolJson<T>(result: Awaited<ReturnType<CharacterHandler['handle']>>): T {
  return JSON.parse(toolText(result)) as T
}

function makeLorebook(name: string, content = `${name} content`) {
  return {
    id: `${name}-id`,
    alwaysActive: false,
    comment: name,
    content,
    insertorder: 100,
    key: `${name}-key`,
    mode: 'normal' as const,
    secondkey: '',
    selective: false,
  }
}

function makeRegexScript(comment: string, regexIn = `${comment}-in`, regexOut = `${comment}-out`) {
  return {
    id: `${comment.toLowerCase().replace(/\s+/g, '-')}-id`,
    comment,
    in: regexIn,
    out: regexOut,
    type: 'editdisplay',
    flag: 'g',
    ableFlag: true,
  }
}

function makeLuaTrigger(code: string, id = 'lua-trigger-id') {
  return {
    id,
    comment: 'Lua trigger',
    conditions: [],
    effect: [
      {
        code,
        type: 'triggerlua',
      },
    ],
    type: 'manual',
  }
}

function firstTriggerCode(characterIndex: number): string {
  return (getDatabase().characters[characterIndex].triggerscript[0].effect[0] as { code: string }).code
}

function seedSiblingAndModuleScripts() {
  getDatabase().characters[0].customscript = [makeRegexScript('Sibling regex', 'sibling-old-in', 'sibling-old-out')]
  getDatabase().characters[0].triggerscript = [makeLuaTrigger('print("sibling old")', 'sibling-trigger-id') as any]
  getDatabase().modules = [
    {
      id: 'module-1',
      name: 'Module 1',
      description: 'Module fixture',
      regex: [makeRegexScript('Module regex', 'module-old-in', 'module-old-out')],
      trigger: [makeLuaTrigger('print("module old")', 'module-trigger-id') as any],
    },
  ] as any
}

async function waitForCallCount(calls: CapturedFetch[], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && calls.length < expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  expect(calls).toHaveLength(expected)
}

async function waitForSettledCommands(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  alertConfirmSpy.mockReset()
  alertConfirmSpy.mockResolvedValue(true)
  clearCachedServerCommandRevision()
  resetLorebookHydration()
  setDatabaseLite(seedCloneCostDb() as any) // char-0 large (40 messages), siblings small
  selectedCharID.set(0)
})

afterEach(() => {
  resetLorebookHydration()
  selectedCharID.set(-1)
  vi.unstubAllGlobals()
})

describe('MCP character writes optimistic projection', () => {
  it('does not mutate after its owner aborts while access confirmation is pending', { tags: 'core' }, async () => {
    const { calls } = stubCommandFetch()
    const controller = new AbortController()
    const handler = new CharacterHandler(controller.signal)
    let acceptPrompt!: (accepted: boolean) => void
    alertConfirmSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acceptPrompt = resolve
        }),
    )
    const previousName = getDatabase().characters[1].name

    const pending = handler.handle('risu-set-character-info', {
      id: 'char-1',
      data: { name: 'Invisible aborted mutation' },
    })
    expect(alertConfirmSpy).toHaveBeenCalledTimes(1)

    controller.abort()
    acceptPrompt(true)

    expect(toolText(await pending)).toBe('Access denied by user.')
    expect(getDatabase().characters[1].name).toBe(previousName)
    expect(calls).toEqual([])
  })

  it('rejects setCharacterInfo when the character is deleted while access is pending', async () => {
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()
    let acceptPrompt!: (accepted: boolean) => void
    alertConfirmSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acceptPrompt = resolve
        }),
    )

    const pending = handler.handle('risu-set-character-info', {
      id: 'char-1',
      data: { name: 'Deleted target' },
    })

    expect(alertConfirmSpy).toHaveBeenCalledTimes(1)
    withTestDatabaseWrite(() => {
      getDatabase().characters = getDatabase().characters.filter((candidate) => candidate.chaId !== 'char-1')
    })
    acceptPrompt(true)

    expect(toolText(await pending)).toBe('Error: Character with ID char-1 not found.')
    expect(getDatabase().characters.map((candidate) => candidate.chaId)).toEqual(['char-0', 'char-2'])
    expect(calls).toEqual([])
  })

  it(
    'rejects setCharacterInfo when the character row is replaced while access is pending',
    { tags: 'core' },
    async () => {
      const { calls } = stubCommandFetch()
      const handler = new CharacterHandler()
      const replacement = { ...getDatabase().characters[1], name: 'Replacement character' }
      let acceptPrompt!: (accepted: boolean) => void
      alertConfirmSpy.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            acceptPrompt = resolve
          }),
      )

      const pending = handler.handle('risu-set-character-info', {
        id: 'char-1',
        data: { name: 'Stale patch' },
      })

      expect(alertConfirmSpy).toHaveBeenCalledTimes(1)
      withTestDatabaseWrite(() => {
        getDatabase().characters[1] = replacement
      })
      acceptPrompt(true)

      expect(toolText(await pending)).toBe(
        'Error: Character with ID char-1 changed before access was accepted. Please retry.',
      )
      expect(getDatabase().characters[1].name).toBe('Replacement character')
      expect(calls).toEqual([])
    },
  )

  it.each([
    {
      args: { id: 'char-1', name: 'Stale lore', content: 'stale content' },
      family: 'lorebook',
      prepare: () => {
        getDatabase().characters[1].globalLore = []
      },
      tool: 'risu-set-character-lorebook',
    },
    {
      args: { id: 'char-1', name: 'Stale regex', in: 'stale-in', out: 'stale-out' },
      family: 'regex',
      prepare: () => {
        getDatabase().characters[1].customscript = []
      },
      tool: 'risu-set-character-regex-scripts',
    },
    {
      args: { id: 'char-1', code: 'print("stale")' },
      family: 'Lua',
      prepare: () => {
        getDatabase().characters[1].triggerscript = [makeLuaTrigger('print("original")') as any]
      },
      tool: 'risu-set-character-lua-script',
    },
  ])('rejects a $family write when the character row is replaced while access is pending', async (testCase) => {
    testCase.prepare()
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()
    const replacement = JSON.parse(JSON.stringify(getDatabase().characters[1])) as character
    replacement.name = 'Replacement character'
    const replacementSnapshot = JSON.parse(JSON.stringify(replacement))
    let acceptPrompt!: (accepted: boolean) => void
    alertConfirmSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acceptPrompt = resolve
        }),
    )

    const pending = handler.handle(testCase.tool, testCase.args)

    expect(alertConfirmSpy).toHaveBeenCalledTimes(1)
    withTestDatabaseWrite(() => {
      getDatabase().characters[1] = replacement
    })
    acceptPrompt(true)

    expect(toolText(await pending)).toBe(
      'Error: Character with ID char-1 changed before access was accepted. Please retry.',
    )
    expect(getDatabase().characters[1]).toEqual(replacementSnapshot)
    expect(calls).toEqual([])
  })

  it('setCharacterInfo patches resource state and read-tool output before the command resolves', async () => {
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()

    const result = await handler.handle('risu-set-character-info', {
      id: 'char-1',
      data: { name: 'Renamed via MCP' },
    })

    expect(toolText(result)).toContain('Successfully updated')
    expect(getDatabase().characters[1].name).toBe('Renamed via MCP')
    expect(
      parseToolJson<{ name: string }>(
        await handler.handle('risu-get-character-info', {
          id: 'char-1',
          fields: ['name'],
        }),
      ),
    ).toEqual({ name: 'Renamed via MCP' })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/characters/char-1',
      method: 'PATCH',
      body: { baseRevision: 10, patch: { name: 'Renamed via MCP' } },
    })
  })

  it('setCharacterInfo patches displayName and uses it for visible MCP text', async () => {
    getDatabase().characters[1].displayName = '표시 캐릭터'
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()

    const result = await handler.handle('risu-set-character-info', {
      id: 'char-1',
      data: { displayName: '새 표시 이름' },
    })

    expect(alertConfirmSpy).toHaveBeenCalledWith(expect.stringContaining('표시 캐릭터'))
    expect(toolText(result)).toContain('새 표시 이름')
    expect(getDatabase().characters[1]).toMatchObject({
      name: 'Character 1',
      displayName: '새 표시 이름',
    })
    expect(
      parseToolJson<{ name: string; displayName: string }>(
        await handler.handle('risu-get-character-info', {
          id: 'char-1',
          fields: ['name', 'displayName'],
        }),
      ),
    ).toEqual({ name: 'Character 1', displayName: '새 표시 이름' })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/characters/char-1',
      method: 'PATCH',
      body: { baseRevision: 10, patch: { displayName: '새 표시 이름' } },
    })
  })

  it('a failed patch rolls back only the target row, preserving sibling edits', async () => {
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failureStatusByUrl: { '/api/v1/commands/characters/char-1': 500 },
      holdUrls: ['/api/v1/commands/characters/char-1'],
    })
    const handler = new CharacterHandler()

    await handler.handle('risu-set-character-info', {
      id: 'char-1',
      data: { name: 'Renamed via MCP' },
    })

    expect(getDatabase().characters[1].name).toBe('Renamed via MCP')
    withTestDatabaseWrite(() => {
      getDatabase().characters[0].name = 'Concurrent sibling edit'
    })

    await waitForCallCount(calls, 2)
    releaseHeldResponses()
    await waitForSettledCommands()

    expect(getDatabase().characters[1].name).toBe('Character 1')
    expect(getDatabase().characters[0].name).toBe('Concurrent sibling edit')
  })

  it('set and delete character lorebooks are immediately visible through resource state and MCP reads', async () => {
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()
    getDatabase().characters[1].globalLore = []
    await handler.handle('risu-set-character-lorebook', {
      id: 'char-1',
      name: 'Created',
      content: 'created content',
      keys: ['alpha'],
    })

    expect(getDatabase().characters[1].globalLore[0]).toMatchObject({
      comment: 'Created',
      content: 'created content',
      key: 'alpha',
    })
    expect(
      parseToolJson<Array<{ name: string; content: string }>>(
        await handler.handle('risu-get-character-lorebook', {
          id: 'char-1',
          names: ['Created'],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        content: 'created content',
        name: 'Created',
      }),
    ])
    await waitForCallCount(calls, 2)

    await handler.handle('risu-set-character-lorebook', {
      id: 'char-1',
      name: 'Created',
      content: 'updated content',
      keys: ['alpha', 'beta'],
    })

    expect(getDatabase().characters[1].globalLore[0]).toMatchObject({
      comment: 'Created',
      content: 'updated content',
      key: 'alpha,beta',
    })
    await waitForCallCount(calls, 3)

    await handler.handle('risu-delete-character-lorebook', {
      id: 'char-1',
      name: 'Created',
    })

    expect(getDatabase().characters[1].globalLore).toEqual([])
    expect(
      toolText(
        await handler.handle('risu-get-character-lorebook', {
          id: 'char-1',
          names: ['Created'],
        }),
      ),
    ).toContain('not found')
    await waitForCallCount(calls, 4)
  })

  it('attempts target-scoped hydration and rejects character lorebook writes when hydration fails', async () => {
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()
    const existing = makeLorebook('Existing', 'old content')
    getDatabase().characters[1].globalLore = [existing]
    ;(getDatabase() as { enableLorebookStubs?: boolean }).enableLorebookStubs = true
    const updateResult = await handler.handle('risu-set-character-lorebook', {
      id: 'char-1',
      name: 'Existing',
      content: 'local-only update',
      keys: ['changed'],
    })

    expect(toolText(updateResult)).toContain('not hydrated')
    expect(getDatabase().characters[1].globalLore).toEqual([existing])
    expect(calls).toEqual([
      {
        url: '/api/v1/characters/char-1/lorebook',
        method: 'GET',
        body: null,
      },
    ])

    const deleteResult = await handler.handle('risu-delete-character-lorebook', {
      id: 'char-1',
      name: 'Existing',
    })

    expect(toolText(deleteResult)).toContain('not hydrated')
    expect(getDatabase().characters[1].globalLore).toEqual([existing])
    expect(calls).toEqual([
      {
        url: '/api/v1/characters/char-1/lorebook',
        method: 'GET',
        body: null,
      },
      {
        url: '/api/v1/characters/char-1/lorebook',
        method: 'GET',
        body: null,
      },
    ])
  })

  it('hydrates one stubbed lorebook by stable character id before returning MCP JSON', async () => {
    const hydratedLorebook = [makeLorebook('Hydrated', 'authoritative content')]
    const { calls } = stubCommandFetch({ characterLorebook: hydratedLorebook })
    const handler = new CharacterHandler()
    getDatabase().characters[1].globalLore = []
    ;(getDatabase() as { enableLorebookStubs?: boolean }).enableLorebookStubs = true

    expect(
      parseToolJson<Array<{ name: string; content: string }>>(
        await handler.handle('risu-get-character-lorebook', {
          id: 'char-1',
          names: ['Hydrated'],
        }),
      ),
    ).toEqual([
      {
        alwaysActive: false,
        content: 'authoritative content',
        keys: 'Hydrated-key',
        name: 'Hydrated',
      },
    ])
    expect(calls).toEqual([
      {
        url: '/api/v1/characters/char-1/lorebook',
        method: 'GET',
        body: null,
      },
    ])
    expect(getDatabase().characters[1].globalLore).toEqual(hydratedLorebook)
  })

  it('hydrates one nonselected character detail owner before returning script JSON', async () => {
    const hydratedCharacter = JSON.parse(JSON.stringify(getDatabase().characters[1])) as character
    hydratedCharacter.customscript = [makeRegexScript('Hydrated script', 'hydrated-in', 'hydrated-out')]
    for (const chat of hydratedCharacter.chats ?? []) {
      chat.message = []
      const chatRecord = chat as unknown as Record<string, unknown>
      delete chatRecord.hypaV3Data
      delete chatRecord.alternatives
      delete chatRecord.alternateMessages
    }
    const shell = {
      ...(JSON.parse(JSON.stringify(getDatabase().characters[1])) as character),
      customscript: [],
      [SERVER_CHARACTER_SHELL_MARKER]: true,
    }
    getDatabase().characters[1] = shell
    const { calls } = stubCommandFetch({ characterDetail: hydratedCharacter })
    const handler = new CharacterHandler()

    expect(
      parseToolJson<Array<{ comment: string; in: string; out: string }>>(
        await handler.handle('risu-get-character-regex-scripts', { id: 'char-1' }),
      ),
    ).toEqual([
      expect.objectContaining({
        comment: 'Hydrated script',
        in: 'hydrated-in',
        out: 'hydrated-out',
      }),
    ])
    expect(calls).toEqual([
      {
        url: '/api/v1/characters/char-1',
        method: 'GET',
        body: null,
      },
    ])
    expect(getDatabase().characters[1]).toMatchObject({
      chaId: 'char-1',
      customscript: [expect.objectContaining({ comment: 'Hydrated script' })],
    })
    expect(getDatabase().characters[1]).not.toHaveProperty(SERVER_CHARACTER_SHELL_MARKER)
  })

  it('set and delete character regex scripts are immediately visible through resource state and MCP reads', async () => {
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()
    getDatabase().characters[1].customscript = []
    await handler.handle('risu-set-character-regex-scripts', {
      id: 'char-1',
      name: 'Created script',
      in: 'created-in',
      out: 'created-out',
      type: 'editdisplay',
      flag: 'g',
      ableFlag: true,
    })

    expect(getDatabase().characters[1].customscript[0]).toMatchObject({
      comment: 'Created script',
      flag: 'g',
      in: 'created-in',
      out: 'created-out',
      type: 'editdisplay',
    })
    expect(
      parseToolJson<Array<{ comment: string; in: string; out: string }>>(
        await handler.handle('risu-get-character-regex-scripts', { id: 'char-1' }),
      ),
    ).toEqual([
      expect.objectContaining({
        comment: 'Created script',
        in: 'created-in',
        out: 'created-out',
      }),
    ])
    await waitForCallCount(calls, 2)

    await handler.handle('risu-set-character-regex-scripts', {
      id: 'char-1',
      name: 'Created script',
      in: 'updated-in',
      out: 'updated-out',
      type: 'editinput',
      flag: 'im',
      ableFlag: true,
    })

    expect(getDatabase().characters[1].customscript[0]).toMatchObject({
      comment: 'Created script',
      flag: 'im',
      in: 'updated-in',
      out: 'updated-out',
      type: 'editinput',
    })
    expect(
      parseToolJson<Array<{ comment: string; in: string; out: string }>>(
        await handler.handle('risu-get-character-regex-scripts', { id: 'char-1' }),
      ),
    ).toEqual([
      expect.objectContaining({
        comment: 'Created script',
        in: 'updated-in',
        out: 'updated-out',
      }),
    ])
    await waitForCallCount(calls, 3)

    await handler.handle('risu-delete-character-regex-scripts', {
      id: 'char-1',
      name: 'Created script',
    })

    expect(getDatabase().characters[1].customscript).toEqual([])
    expect(
      parseToolJson<unknown[]>(await handler.handle('risu-get-character-regex-scripts', { id: 'char-1' })),
    ).toEqual([])
    await waitForCallCount(calls, 4)
  })

  it('failed character regex creation rolls back only target scripts and preserves other script domains', async () => {
    const failureUrl = '/api/v1/commands/characters/char-1/scripts'
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failureStatusByUrl: { [failureUrl]: 500 },
      holdUrls: [failureUrl],
    })
    const handler = new CharacterHandler()
    seedSiblingAndModuleScripts()
    delete (getDatabase().characters[1] as { customscript?: unknown }).customscript
    getDatabase().characters[1].triggerscript = [makeLuaTrigger('print("target trigger old")') as any]
    await handler.handle('risu-set-character-regex-scripts', {
      id: 'char-1',
      name: 'Created script',
      in: 'created-in',
      out: 'created-out',
      type: 'editdisplay',
    })

    expect(getDatabase().characters[1].customscript[0]).toMatchObject({
      comment: 'Created script',
      in: 'created-in',
      out: 'created-out',
    })
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().characters[1].triggerscript = [
        makeLuaTrigger('print("target trigger concurrent")', 'target-trigger-concurrent-id') as any,
      ]
      getDatabase().characters[0].customscript = [
        makeRegexScript('Sibling regex concurrent', 'sibling-new-in', 'sibling-new-out'),
      ]
      getDatabase().characters[0].triggerscript = [
        makeLuaTrigger('print("sibling concurrent")', 'sibling-trigger-concurrent-id') as any,
      ]
      ;(getDatabase().modules[0] as any).regex = [
        makeRegexScript('Module regex concurrent', 'module-new-in', 'module-new-out'),
      ]
      ;(getDatabase().modules[0] as any).trigger = [
        makeLuaTrigger('print("module concurrent")', 'module-trigger-concurrent-id') as any,
      ]
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(getDatabase().characters[1]).not.toHaveProperty('customscript')
    expect(firstTriggerCode(1)).toBe('print("target trigger concurrent")')
    expect(getDatabase().characters[0].customscript[0]).toMatchObject({ in: 'sibling-new-in', out: 'sibling-new-out' })
    expect(firstTriggerCode(0)).toBe('print("sibling concurrent")')
    expect((getDatabase().modules[0] as any).regex[0]).toMatchObject({ in: 'module-new-in', out: 'module-new-out' })
    expect(((getDatabase().modules[0] as any).trigger[0].effect[0] as { code: string }).code).toBe(
      'print("module concurrent")',
    )
  })

  it('failed character regex deletion skips rollback after a newer target script edit', async () => {
    const failureUrl = '/api/v1/commands/characters/char-1/scripts'
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failureStatusByUrl: { [failureUrl]: 500 },
      holdUrls: [failureUrl],
    })
    const handler = new CharacterHandler()
    seedSiblingAndModuleScripts()
    getDatabase().characters[1].customscript = [makeRegexScript('Delete me', 'delete-old-in', 'delete-old-out')]
    getDatabase().characters[1].triggerscript = [makeLuaTrigger('print("target trigger old")') as any]
    await handler.handle('risu-delete-character-regex-scripts', {
      id: 'char-1',
      name: 'Delete me',
    })

    expect(getDatabase().characters[1].customscript).toEqual([])
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().characters[1].customscript = [
        makeRegexScript('Concurrent target regex', 'target-new-in', 'target-new-out'),
      ]
      getDatabase().characters[1].triggerscript = [
        makeLuaTrigger('print("target trigger concurrent")', 'target-trigger-concurrent-id') as any,
      ]
      getDatabase().characters[0].customscript = [
        makeRegexScript('Sibling regex concurrent', 'sibling-new-in', 'sibling-new-out'),
      ]
      getDatabase().characters[0].triggerscript = [
        makeLuaTrigger('print("sibling concurrent")', 'sibling-trigger-concurrent-id') as any,
      ]
      ;(getDatabase().modules[0] as any).regex = [
        makeRegexScript('Module regex concurrent', 'module-new-in', 'module-new-out'),
      ]
      ;(getDatabase().modules[0] as any).trigger = [
        makeLuaTrigger('print("module concurrent")', 'module-trigger-concurrent-id') as any,
      ]
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(getDatabase().characters[1].customscript).toEqual([
      expect.objectContaining({ comment: 'Concurrent target regex', in: 'target-new-in', out: 'target-new-out' }),
    ])
    expect(firstTriggerCode(1)).toBe('print("target trigger concurrent")')
    expect(getDatabase().characters[0].customscript[0]).toMatchObject({ in: 'sibling-new-in', out: 'sibling-new-out' })
    expect(firstTriggerCode(0)).toBe('print("sibling concurrent")')
    expect((getDatabase().modules[0] as any).regex[0]).toMatchObject({ in: 'module-new-in', out: 'module-new-out' })
    expect(((getDatabase().modules[0] as any).trigger[0].effect[0] as { code: string }).code).toBe(
      'print("module concurrent")',
    )
  })

  it('setCharacterLuaScript is immediately visible through resource state and the Lua read tool', async () => {
    const { calls } = stubCommandFetch()
    const handler = new CharacterHandler()
    getDatabase().characters[1].triggerscript = [makeLuaTrigger('print("old")') as any]
    await handler.handle('risu-set-character-lua-script', {
      id: 'char-1',
      code: 'print("new")',
    })

    expect((getDatabase().characters[1].triggerscript[0].effect[0] as { code: string }).code).toBe('print("new")')
    expect(toolText(await handler.handle('risu-get-character-lua-script', { id: 'char-1' }))).toBe('print("new")')
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/characters/char-1/triggers',
      method: 'PATCH',
      body: {
        mutation: {
          op: 'update',
          id: 'lua-trigger-id',
          patch: {
            effect: [{ type: 'triggerlua', code: 'print("new")' }],
          },
          deleteKeys: [],
        },
      },
    })
    expect(calls[1].body).not.toHaveProperty('triggers')
  })

  it('failed Lua trigger writes roll back only target triggers and preserve other script domains', async () => {
    const failureUrl = '/api/v1/commands/characters/char-1/triggers'
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failureStatusByUrl: { [failureUrl]: 500 },
      holdUrls: [failureUrl],
    })
    const handler = new CharacterHandler()
    seedSiblingAndModuleScripts()
    getDatabase().characters[1].customscript = [makeRegexScript('Target regex', 'target-old-in', 'target-old-out')]
    getDatabase().characters[1].triggerscript = [makeLuaTrigger('print("target old")') as any]
    await handler.handle('risu-set-character-lua-script', {
      id: 'char-1',
      code: 'print("target attempted")',
    })

    expect(firstTriggerCode(1)).toBe('print("target attempted")')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().characters[1].customscript = [
        makeRegexScript('Target regex concurrent', 'target-new-in', 'target-new-out'),
      ]
      getDatabase().characters[0].customscript = [
        makeRegexScript('Sibling regex concurrent', 'sibling-new-in', 'sibling-new-out'),
      ]
      getDatabase().characters[0].triggerscript = [
        makeLuaTrigger('print("sibling concurrent")', 'sibling-trigger-concurrent-id') as any,
      ]
      ;(getDatabase().modules[0] as any).regex = [
        makeRegexScript('Module regex concurrent', 'module-new-in', 'module-new-out'),
      ]
      ;(getDatabase().modules[0] as any).trigger = [
        makeLuaTrigger('print("module concurrent")', 'module-trigger-concurrent-id') as any,
      ]
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(firstTriggerCode(1)).toBe('print("target old")')
    expect(getDatabase().characters[1].customscript[0]).toMatchObject({ in: 'target-new-in', out: 'target-new-out' })
    expect(getDatabase().characters[0].customscript[0]).toMatchObject({ in: 'sibling-new-in', out: 'sibling-new-out' })
    expect(firstTriggerCode(0)).toBe('print("sibling concurrent")')
    expect((getDatabase().modules[0] as any).regex[0]).toMatchObject({ in: 'module-new-in', out: 'module-new-out' })
    expect(((getDatabase().modules[0] as any).trigger[0].effect[0] as { code: string }).code).toBe(
      'print("module concurrent")',
    )
  })

  it('failed Lua trigger writes skip rollback after a newer target trigger edit', async () => {
    const failureUrl = '/api/v1/commands/characters/char-1/triggers'
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failureStatusByUrl: { [failureUrl]: 500 },
      holdUrls: [failureUrl],
    })
    const handler = new CharacterHandler()
    seedSiblingAndModuleScripts()
    getDatabase().characters[1].customscript = [makeRegexScript('Target regex', 'target-old-in', 'target-old-out')]
    getDatabase().characters[1].triggerscript = [makeLuaTrigger('print("target old")') as any]
    await handler.handle('risu-set-character-lua-script', {
      id: 'char-1',
      code: 'print("target attempted")',
    })

    expect(firstTriggerCode(1)).toBe('print("target attempted")')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().characters[1].triggerscript = [
        makeLuaTrigger('print("target concurrent")', 'target-trigger-concurrent-id') as any,
      ]
      getDatabase().characters[1].customscript = [
        makeRegexScript('Target regex concurrent', 'target-new-in', 'target-new-out'),
      ]
      getDatabase().characters[0].customscript = [
        makeRegexScript('Sibling regex concurrent', 'sibling-new-in', 'sibling-new-out'),
      ]
      getDatabase().characters[0].triggerscript = [
        makeLuaTrigger('print("sibling concurrent")', 'sibling-trigger-concurrent-id') as any,
      ]
      ;(getDatabase().modules[0] as any).regex = [
        makeRegexScript('Module regex concurrent', 'module-new-in', 'module-new-out'),
      ]
      ;(getDatabase().modules[0] as any).trigger = [
        makeLuaTrigger('print("module concurrent")', 'module-trigger-concurrent-id') as any,
      ]
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(firstTriggerCode(1)).toBe('print("target concurrent")')
    expect(getDatabase().characters[1].customscript[0]).toMatchObject({ in: 'target-new-in', out: 'target-new-out' })
    expect(getDatabase().characters[0].customscript[0]).toMatchObject({ in: 'sibling-new-in', out: 'sibling-new-out' })
    expect(firstTriggerCode(0)).toBe('print("sibling concurrent")')
    expect((getDatabase().modules[0] as any).regex[0]).toMatchObject({ in: 'module-new-in', out: 'module-new-out' })
    expect(((getDatabase().modules[0] as any).trigger[0].effect[0] as { code: string }).code).toBe(
      'print("module concurrent")',
    )
  })
})
