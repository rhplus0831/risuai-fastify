import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RisuModule } from 'src/ts/process/modules'
import type { customscript, Database, loreBook, triggerscript } from 'src/ts/storage/database.svelte'

// MCP module writes apply an immediate trusted projection and sequence multi-command info writes.

const alertConfirmSpy = vi.hoisted(() => vi.fn(async () => true))

vi.mock('src/ts/platform', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/platform')>()
  return { ...actual, isFastifyServer: true }
})

vi.mock('src/ts/storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'mcp-module-token',
}))

vi.mock('src/ts/alert', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/alert')>()
  return { ...actual, alertConfirm: alertConfirmSpy }
})

import { clearCachedServerCommandRevision } from 'src/ts/server/commands'

import { replaceResourceDatabase as setDatabaseLite } from 'src/ts/server/resourceState.svelte'
import { selectedCharID } from 'src/ts/stores.svelte'
import { ModuleHandler } from '../modules'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

interface CapturedFetch {
  url: string
  method: string
  body: any
}

interface StubCommandFetchOptions {
  failUrls?: string[]
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
  const failUrls = new Set(options.failUrls ?? [])
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

      if (url.startsWith('/api/v1/commands/modules')) {
        const buildResponse = () => {
          if (failUrls.has(url)) {
            return jsonResponse({ error: 'forced failure' }, 500)
          }
          revision += 1
          return jsonResponse({
            revision,
            event: { type: 'module.updated', revision, resource: 'module' },
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

function makeLuaTrigger(code: string): triggerscript {
  return {
    id: 'lua-trigger-id',
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

function moduleLuaCode(moduleIndex: number): string {
  return (getDatabase().modules[moduleIndex].trigger?.[0]?.effect?.[0] as { code: string }).code
}

function setModuleLuaCode(moduleIndex: number, code: string): void {
  const effect = getDatabase().modules[moduleIndex].trigger?.[0]?.effect?.[0] as { code: string }
  effect.code = code
}

function makeRegexScript(overrides: Partial<customscript> = {}): customscript {
  return {
    id: 'regex-script-id',
    ableFlag: true,
    comment: 'Regex script',
    flag: 'g',
    in: 'old-in',
    out: 'old-out',
    type: 'editdisplay',
    ...overrides,
  }
}

function makeLorebookEntry(overrides: Partial<loreBook> = {}): loreBook {
  return {
    id: 'lorebook-entry-id',
    alwaysActive: false,
    comment: 'Lore entry',
    content: 'old content',
    insertorder: 100,
    key: '',
    mode: 'normal',
    secondkey: '',
    selective: false,
    ...overrides,
  }
}

function makeModule(overrides: Partial<RisuModule> = {}): RisuModule {
  return {
    backgroundEmbedding: '',
    customModuleToggle: '',
    id: 'module-a',
    description: 'Original description',
    lorebook: [],
    lowLevelAccess: false,
    name: 'Module A',
    regex: [],
    trigger: [],
    ...overrides,
  }
}

function toolText(result: Awaited<ReturnType<ModuleHandler['handle']>>): string {
  const content = result?.[0]
  expect(content).toMatchObject({ type: 'text' })
  return (content as { text: string }).text
}

function parseToolJson<T>(result: Awaited<ReturnType<ModuleHandler['handle']>>): T {
  return JSON.parse(toolText(result)) as T
}

async function waitForCallCount(calls: CapturedFetch[], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && calls.length < expected; attempt += 1) {
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
  setDatabaseLite({
    characters: [],
    enabledModules: [],
    loreBook: [],
    loreBookPage: 0,
    modules: [makeModule()],
  } as unknown as Database)
  selectedCharID.set(-1)
})

afterEach(() => {
  clearCachedServerCommandRevision()
  selectedCharID.set(-1)
  vi.unstubAllGlobals()
})

describe('MCP module writes optimistic projection', () => {
  it('rejects setModuleInfo when the module is deleted while access is pending', async () => {
    const { calls } = stubCommandFetch()
    const handler = new ModuleHandler()
    let acceptPrompt!: (accepted: boolean) => void
    alertConfirmSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acceptPrompt = resolve
        }),
    )

    const pending = handler.handle('risu-set-module-info', {
      id: 'module-a',
      data: { name: 'Deleted target', enabled: true },
    })

    expect(alertConfirmSpy).toHaveBeenCalledTimes(1)
    withTestDatabaseWrite(() => {
      getDatabase().modules = []
    })
    acceptPrompt(true)

    expect(toolText(await pending)).toBe('Error: Module with ID module-a not found.')
    expect(getDatabase().enabledModules).toEqual([])
    expect(calls).toEqual([])
  })

  it('rejects setModuleInfo when the module object is replaced while access is pending', { tags: 'core' }, async () => {
    const { calls } = stubCommandFetch()
    const handler = new ModuleHandler()
    const replacement = makeModule({ id: 'module-a', name: 'Replacement module' })
    let acceptPrompt!: (accepted: boolean) => void
    alertConfirmSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          acceptPrompt = resolve
        }),
    )

    const pending = handler.handle('risu-set-module-info', {
      id: 'module-a',
      data: { name: 'Stale patch', enabled: true },
    })

    expect(alertConfirmSpy).toHaveBeenCalledTimes(1)
    withTestDatabaseWrite(() => {
      getDatabase().modules[0] = replacement
    })
    acceptPrompt(true)

    expect(toolText(await pending)).toBe(
      'Error: Module with ID module-a changed before access was accepted. Please retry.',
    )
    expect(getDatabase().modules[0].name).toBe('Replacement module')
    expect(getDatabase().enabledModules).toEqual([])
    expect(calls).toEqual([])
  })

  it.each([
    {
      args: { id: 'module-a', name: 'Stale lore', content: 'stale content' },
      family: 'lorebook',
      prepare: () => {
        getDatabase().modules[0].lorebook = []
      },
      tool: 'risu-set-module-lorebook',
    },
    {
      args: { id: 'module-a', name: 'Stale regex', in: 'stale-in', out: 'stale-out' },
      family: 'regex',
      prepare: () => {
        getDatabase().modules[0].regex = []
      },
      tool: 'risu-set-module-regex-script',
    },
    {
      args: { id: 'module-a', code: 'print("stale")' },
      family: 'Lua',
      prepare: () => {
        getDatabase().modules[0].trigger = [makeLuaTrigger('print("original")')]
      },
      tool: 'risu-set-module-lua-script',
    },
  ])('rejects a $family write when the module row is replaced while access is pending', async (testCase) => {
    withTestDatabaseWrite(testCase.prepare)
    const { calls } = stubCommandFetch()
    const handler = new ModuleHandler()
    const replacement = JSON.parse(JSON.stringify(getDatabase().modules[0])) as RisuModule
    replacement.name = 'Replacement module'
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
      getDatabase().modules[0] = replacement
    })
    acceptPrompt(true)

    expect(toolText(await pending)).toBe(
      'Error: Module with ID module-a changed before access was accepted. Please retry.',
    )
    expect(getDatabase().modules[0]).toEqual(replacementSnapshot)
    expect(calls).toEqual([])
  })

  it('setModuleInfo patches resource state and read-tool output before sequenced commands resolve', async () => {
    const { calls, releaseHeldResponses } = stubCommandFetch({
      holdUrls: ['/api/v1/commands/modules/module-a'],
    })
    const handler = new ModuleHandler()

    const result = await handler.handle('risu-set-module-info', {
      id: 'module-a',
      data: { name: 'Renamed module', enabled: true },
    })

    expect(toolText(result)).toContain('Successfully updated module Renamed module')
    expect(getDatabase().modules[0].name).toBe('Renamed module')
    expect(getDatabase().enabledModules).toEqual(['module-a'])
    expect(
      parseToolJson<{ name: string; enabled: boolean }>(
        await handler.handle('risu-get-module-info', {
          id: 'module-a',
          fields: ['name', 'enabled'],
        }),
      ),
    ).toEqual({ name: 'Renamed module', enabled: true })

    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/modules/module-a',
      method: 'PATCH',
      body: { baseRevision: 10, patch: { name: 'Renamed module' } },
    })

    releaseHeldResponses()
    await waitForCallCount(calls, 3)
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/modules/enable',
      method: 'POST',
      body: { baseRevision: 11, moduleId: 'module-a', enabled: true },
    })
    await waitForSettledCommands()
  })

  it('projects optional module null sentinels as field deletion', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().modules[0].backgroundEmbedding = 'old background'
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      holdUrls: ['/api/v1/commands/modules/module-a'],
    })
    const handler = new ModuleHandler()

    const result = await handler.handle('risu-set-module-info', {
      id: 'module-a',
      data: { backgroundEmbedding: null },
    })

    expect(toolText(result)).toContain('Successfully updated module')
    expect(getDatabase().modules[0].backgroundEmbedding).toBeUndefined()
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/modules/module-a',
      method: 'PATCH',
      body: { baseRevision: 10, patch: { backgroundEmbedding: null } },
    })

    releaseHeldResponses()
    await waitForSettledCommands()
  })

  it('rolls back only attempted module-info fields and unattempted enable when a held PATCH fails', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().modules = [
        makeModule(),
        makeModule({
          id: 'module-b',
          description: 'Sibling description',
          name: 'Module B',
        }),
      ]
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/module-a'],
      holdUrls: ['/api/v1/commands/modules/module-a'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-info', {
      id: 'module-a',
      data: { name: 'Attempted', enabled: true },
    })

    expect(getDatabase().modules[0]).toMatchObject({
      description: 'Original description',
      name: 'Attempted',
    })
    expect(getDatabase().enabledModules).toEqual(['module-a'])

    await waitForCallCount(calls, 2)
    withTestDatabaseWrite(() => {
      getDatabase().modules[0] = {
        ...getDatabase().modules[0],
        description: 'Newer description',
      }
      getDatabase().modules[1] = {
        ...getDatabase().modules[1],
        name: 'Sibling newer',
      }
      getDatabase().modules.push(makeModule({ id: 'module-c', name: 'Module C' }))
      getDatabase().enabledModules.push('module-b')
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(calls).toHaveLength(2)
    expect(getDatabase().modules.map((module) => module.id)).toEqual(['module-a', 'module-b', 'module-c'])
    expect(getDatabase().modules[0]).toMatchObject({
      description: 'Newer description',
      name: 'Module A',
    })
    expect(getDatabase().modules[1]).toMatchObject({
      description: 'Sibling description',
      name: 'Sibling newer',
    })
    expect(getDatabase().enabledModules).toEqual(['module-b'])
  })

  it('keeps the accepted module-info PATCH when the later enable command fails', async () => {
    const { calls } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/enable'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-info', {
      id: 'module-a',
      data: { name: 'Accepted', enabled: true },
    })

    expect(getDatabase().modules[0].name).toBe('Accepted')
    expect(getDatabase().enabledModules).toEqual(['module-a'])

    await waitForCallCount(calls, 3)
    await waitForSettledCommands()

    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/modules/module-a',
      method: 'PATCH',
      body: { baseRevision: 10, patch: { name: 'Accepted' } },
    })
    expect(calls[2]).toMatchObject({
      url: '/api/v1/commands/modules/enable',
      method: 'POST',
      body: { baseRevision: 11, moduleId: 'module-a', enabled: true },
    })
    expect(getDatabase().modules[0].name).toBe('Accepted')
    expect(getDatabase().enabledModules).toEqual([])
  })

  it('set and delete module lorebooks are immediately visible through resource state and MCP reads', async () => {
    const { calls } = stubCommandFetch()
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-lorebook', {
      id: 'module-a',
      name: 'Created lore',
      content: 'created content',
      keys: ['alpha'],
    })

    expect(getDatabase().modules[0].lorebook?.[0]).toMatchObject({
      comment: 'Created lore',
      content: 'created content',
      key: 'alpha',
    })
    expect(
      parseToolJson<Array<{ name: string; content: string }>>(
        await handler.handle('risu-get-module-lorebook', {
          id: 'module-a',
          names: ['Created lore'],
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        content: 'created content',
        name: 'Created lore',
      }),
    ])
    await waitForCallCount(calls, 2)

    await handler.handle('risu-delete-module-lorebook', {
      id: 'module-a',
      name: 'Created lore',
    })

    expect(getDatabase().modules[0].lorebook).toEqual([])
    expect(
      toolText(
        await handler.handle('risu-get-module-lorebook', {
          id: 'module-a',
          names: ['Created lore'],
        }),
      ),
    ).toContain('not found')
    await waitForCallCount(calls, 3)
    await waitForSettledCommands()
  })

  it('rolls back failed module lorebook replacement without restoring unrelated lorebook state', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().characters = [
        {
          chaId: 'character-a',
          name: 'Character A',
          globalLore: [makeLorebookEntry({ id: 'character-lore', comment: 'Character lore' })],
        },
      ] as any
      getDatabase().loreBook = [
        {
          id: 'global-lorebook',
          name: 'Global lorebook',
          data: [makeLorebookEntry({ id: 'global-entry', comment: 'Global entry' })],
        },
      ] as any
      getDatabase().modules = [
        makeModule({
          lorebook: [makeLorebookEntry({ id: 'module-a-lore', comment: 'Module lore', content: 'old module' })],
        }),
        makeModule({
          id: 'module-b',
          name: 'Module B',
          lorebook: [makeLorebookEntry({ id: 'module-b-lore', comment: 'Sibling lore', content: 'old sibling' })],
        }),
      ]
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/module-a/lorebooks/entries/module-a-lore'],
      holdUrls: ['/api/v1/commands/modules/module-a/lorebooks/entries/module-a-lore'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-lorebook', {
      id: 'module-a',
      name: 'Module lore',
      content: 'attempted module',
    })

    expect(getDatabase().modules[0].lorebook?.[0]?.content).toBe('attempted module')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().modules[1].lorebook![0].content = 'newer sibling'
      const characterLore = (getDatabase().characters[0] as any).globalLore[0] as loreBook
      characterLore.content = 'newer character'
      const globalLore = (getDatabase().loreBook[0] as any).data[0] as loreBook
      globalLore.content = 'newer global'
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(getDatabase().modules[0].lorebook?.[0]?.content).toBe('old module')
    expect(getDatabase().modules[1].lorebook?.[0]?.content).toBe('newer sibling')
    expect((getDatabase().characters[0] as any).globalLore[0].content).toBe('newer character')
    expect((getDatabase().loreBook[0] as any).data[0].content).toBe('newer global')
  })

  it('set and delete module regex scripts are immediately visible through resource state and MCP reads', async () => {
    const { calls } = stubCommandFetch()
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-regex-script', {
      id: 'module-a',
      name: 'Created script',
      in: 'created-in',
      out: 'created-out',
      type: 'editdisplay',
      flag: 'g',
      ableFlag: true,
    })

    expect(getDatabase().modules[0].regex?.[0]).toMatchObject({
      comment: 'Created script',
      flag: 'g',
      in: 'created-in',
      out: 'created-out',
      type: 'editdisplay',
    })
    expect(
      parseToolJson<Array<{ comment: string; in: string; out: string }>>(
        await handler.handle('risu-get-module-regex-scripts', { id: 'module-a' }),
      ),
    ).toEqual([
      expect.objectContaining({
        comment: 'Created script',
        in: 'created-in',
        out: 'created-out',
      }),
    ])
    await waitForCallCount(calls, 2)

    await handler.handle('risu-delete-module-regex-script', {
      id: 'module-a',
      name: 'Created script',
    })

    expect(getDatabase().modules[0].regex).toEqual([])
    expect(parseToolJson<unknown[]>(await handler.handle('risu-get-module-regex-scripts', { id: 'module-a' }))).toEqual(
      [],
    )
    await waitForCallCount(calls, 3)
    await waitForSettledCommands()
  })

  it('rolls back failed held module regex replacement without restoring triggers, sibling modules, or characters', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().characters = [{ chaId: 'character-a', name: 'Character A' }] as any
      getDatabase().modules = [
        makeModule({
          regex: [makeRegexScript({ id: 'module-a-regex', comment: 'Regex script', out: 'old-out' })],
          trigger: [makeLuaTrigger('print("old trigger")')],
        }),
        makeModule({
          id: 'module-b',
          name: 'Module B',
          regex: [makeRegexScript({ id: 'module-b-regex', comment: 'Sibling regex', out: 'old sibling' })],
        }),
      ]
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/module-a/scripts'],
      holdUrls: ['/api/v1/commands/modules/module-a/scripts'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-regex-script', {
      id: 'module-a',
      name: 'Regex script',
      out: 'attempted-out',
    })

    expect(getDatabase().modules[0].regex?.[0]?.out).toBe('attempted-out')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      setModuleLuaCode(0, 'print("newer trigger")')
      getDatabase().modules[1].regex![0].out = 'newer sibling'
      const character = getDatabase().characters[0] as any
      character.name = 'Newer character'
      getDatabase().characters.push({ chaId: 'character-b', name: 'Character B' } as any)
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(getDatabase().modules[0].regex?.[0]?.out).toBe('old-out')
    expect(moduleLuaCode(0)).toBe('print("newer trigger")')
    expect(getDatabase().modules[1].regex?.[0]?.out).toBe('newer sibling')
    expect(getDatabase().characters.map((character: any) => character.name)).toEqual(['Newer character', 'Character B'])
  })

  it('skips failed held module regex rollback when the same module regex changed again', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().modules = [
        makeModule({
          regex: [makeRegexScript({ id: 'module-a-regex', comment: 'Regex script', out: 'old-out' })],
        }),
      ]
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/module-a/scripts'],
      holdUrls: ['/api/v1/commands/modules/module-a/scripts'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-regex-script', {
      id: 'module-a',
      name: 'Regex script',
      out: 'attempted-out',
    })

    expect(getDatabase().modules[0].regex?.[0]?.out).toBe('attempted-out')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().modules[0].regex![0].out = 'newer-out'
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(getDatabase().modules[0].regex?.[0]?.out).toBe('newer-out')
  })

  it('setModuleLuaScript is immediately visible through resource state and the Lua read tool', async () => {
    const { calls } = stubCommandFetch()
    const handler = new ModuleHandler()
    withTestDatabaseWrite(() => {
      getDatabase().modules = [makeModule({ trigger: [makeLuaTrigger('print("old")')] })]
    })

    await handler.handle('risu-set-module-lua-script', {
      id: 'module-a',
      code: 'print("new")',
    })

    expect(moduleLuaCode(0)).toBe('print("new")')
    expect(toolText(await handler.handle('risu-get-module-lua-script', { id: 'module-a' }))).toBe('print("new")')
    await waitForCallCount(calls, 2)
    expect(calls[1]).toMatchObject({
      url: '/api/v1/commands/modules/module-a/triggers',
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
    await waitForSettledCommands()
  })

  it('rolls back failed held module Lua trigger replacement without restoring regex, sibling modules, or characters', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().characters = [{ chaId: 'character-a', name: 'Character A' }] as any
      getDatabase().modules = [
        makeModule({
          regex: [makeRegexScript({ id: 'module-a-regex', comment: 'Regex script', out: 'old regex' })],
          trigger: [makeLuaTrigger('print("old lua")')],
        }),
        makeModule({
          id: 'module-b',
          name: 'Module B',
          trigger: [makeLuaTrigger('print("old sibling lua")')],
        }),
      ]
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/module-a/triggers'],
      holdUrls: ['/api/v1/commands/modules/module-a/triggers'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-lua-script', {
      id: 'module-a',
      code: 'print("attempted lua")',
    })

    expect(moduleLuaCode(0)).toBe('print("attempted lua")')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      getDatabase().modules[0].regex![0].out = 'newer regex'
      setModuleLuaCode(1, 'print("newer sibling lua")')
      const character = getDatabase().characters[0] as any
      character.name = 'Newer character'
      getDatabase().characters.push({ chaId: 'character-b', name: 'Character B' } as any)
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(moduleLuaCode(0)).toBe('print("old lua")')
    expect(getDatabase().modules[0].regex?.[0]?.out).toBe('newer regex')
    expect(moduleLuaCode(1)).toBe('print("newer sibling lua")')
    expect(getDatabase().characters.map((character: any) => character.name)).toEqual(['Newer character', 'Character B'])
  })

  it('skips failed held module Lua trigger rollback when the same trigger changed again', async () => {
    withTestDatabaseWrite(() => {
      getDatabase().modules = [makeModule({ trigger: [makeLuaTrigger('print("old lua")')] })]
    })
    const { calls, releaseHeldResponses } = stubCommandFetch({
      failUrls: ['/api/v1/commands/modules/module-a/triggers'],
      holdUrls: ['/api/v1/commands/modules/module-a/triggers'],
    })
    const handler = new ModuleHandler()

    await handler.handle('risu-set-module-lua-script', {
      id: 'module-a',
      code: 'print("attempted lua")',
    })

    expect(moduleLuaCode(0)).toBe('print("attempted lua")')
    await waitForCallCount(calls, 2)

    withTestDatabaseWrite(() => {
      setModuleLuaCode(0, 'print("newer lua")')
    })

    releaseHeldResponses()
    await waitForSettledCommands()

    expect(moduleLuaCode(0)).toBe('print("newer lua")')
  })
})
