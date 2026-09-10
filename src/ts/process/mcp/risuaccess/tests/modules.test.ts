import fc from 'fast-check'
import type { RisuModule } from 'src/ts/process/modules'
import { replaceResourceDatabase as setDatabaseLite } from 'src/ts/server/resourceState.svelte'
import type { customscript, Database, loreBook } from 'src/ts/storage/database.svelte'
import { beforeEach, expect, test, vi } from 'vitest'
import type { RPCToolCallContent, RPCToolCallTextContent } from '../../mcplib'
import { ModuleHandler } from '../modules'
import { getResourceDatabase as getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

//#region module mocks

// Mock browser/UI modules used by module handlers.
vi.mock(import('katex'), () => ({}))
vi.mock(import('src/ts/lite'), () => ({}))

vi.mock(import('src/ts/alert'), () => ({
  alertConfirm: vi.fn(),
}))

vi.mock(import('src/ts/stores.svelte'), () => {
  return {
    selIdState: {
      selId: 0,
    },
  } as typeof import('src/ts/stores.svelte')
})

//#endregion

const makeLorebook = (name: string): loreBook => ({
  alwaysActive: false,
  comment: name,
  content: `${name}Content`,
  insertorder: 100,
  key: `${name}Key`,
  mode: 'normal',
  secondkey: '',
  selective: false,
})

const makeRegex = (name: string): customscript => ({
  ableFlag: true,
  comment: name,
  flag: '',
  in: `${name}In`,
  out: `${name}Out`,
  type: 'editdisplay',
})

const makeModule = (name: string): RisuModule => ({
  backgroundEmbedding: '<style>abc</style>',
  customModuleToggle: 'a=b\nc=d',
  id: name,
  description: `${name}Description`,
  lorebook: [],
  lowLevelAccess: false,
  name,
  regex: [],
  trigger: [],
})

const makeToolResponse = (text: unknown): RPCToolCallTextContent[] => [
  {
    text: typeof text === 'string' ? text : JSON.stringify(text),
    type: 'text',
  },
]

function expectJsonToolResponse(actual: RPCToolCallContent[] | null, expected: unknown): void {
  expect(actual).toEqual([
    {
      text: expect.any(String),
      type: 'text',
    },
  ])
  const entry = actual?.[0]
  if (entry?.type !== 'text') throw new Error('Expected a text tool response')
  expect(JSON.parse(entry.text)).toEqual(expected)
}

beforeEach(() => {
  vi.resetAllMocks()
  setDatabaseLite({ characters: [], enabledModules: [], modules: [] } as unknown as Database)
})

test('lists installed modules with pagination', async () => {
  const instance = new ModuleHandler()

  const modules = Array(10)
    .fill(0)
    .map((_, i) => makeModule(String(i)))
  getDatabase().modules = modules
  getDatabase().enabledModules = [modules[0].id, modules[2].id]

  expectJsonToolResponse(await instance.handle('risu-list-modules', { count: 3 }), [
    { description: '0Description', enabled: true, id: '0', name: '0' },
    { description: '1Description', enabled: false, id: '1', name: '1' },
    { description: '2Description', enabled: true, id: '2', name: '2' },
  ])
  expectJsonToolResponse(await instance.handle('risu-list-modules', { count: 3, offset: 3 }), [
    { description: '3Description', enabled: false, id: '3', name: '3' },
    { description: '4Description', enabled: false, id: '4', name: '4' },
    { description: '5Description', enabled: false, id: '5', name: '5' },
  ])
  expectJsonToolResponse(await instance.handle('risu-list-modules', { count: 3, offset: 10 }), [])

  getDatabase().modules = []
  getDatabase().enabledModules = []

  expect(await instance.handle('risu-list-modules', {})).toEqual(makeToolResponse([]))
})

test('retrieves bgEmbedding, toggles, description, id, enabled, low level access, name fields of a module', async () => {
  const instance = new ModuleHandler()

  const modules = Array(10)
    .fill(0)
    .map((_, i) => makeModule(String(i)))
  getDatabase().modules = modules
  getDatabase().enabledModules = [modules[0].id, modules[2].id, modules[4].id]

  await fc.assert(
    fc.asyncProperty(
      fc.subarray([
        'backgroundEmbedding',
        'customModuleToggle',
        'description',
        'enabled',
        'id',
        'lowLevelAccess',
        'name',
      ]),
      fc.integer({ max: 9, min: 0 }),
      async (fieldsArg, targetIndex) => {
        const target = getDatabase().modules[targetIndex]
        const fields = fieldsArg.length > 0 ? fieldsArg : ['name', 'description', 'id', 'enabled']

        const expected = Object.fromEntries(
          fields.map((field) => {
            if (field === 'enabled') {
              return ['enabled', getDatabase().enabledModules.includes(target.id)]
            }
            return [field, target[field]]
          }),
        )

        expect(await instance.handle('risu-get-module-info', { fields, id: target.id })).toEqual(
          makeToolResponse(expected),
        )
      },
    ),
  )
})

test('lists lorebooks of a module with pagination', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    lorebook: Array(10)
      .fill(0)
      .map((_, i) => makeLorebook(String(i))),
  }
  getDatabase().modules = [module]

  expectJsonToolResponse(await instance.handle('risu-list-module-lorebooks', { count: 3, id: 'A' }), [
    { alwaysActive: false, keys: '0Key', name: '0' },
    { alwaysActive: false, keys: '1Key', name: '1' },
    { alwaysActive: false, keys: '2Key', name: '2' },
  ])
  expectJsonToolResponse(await instance.handle('risu-list-module-lorebooks', { count: 3, offset: 3, id: 'A' }), [
    { alwaysActive: false, keys: '3Key', name: '3' },
    { alwaysActive: false, keys: '4Key', name: '4' },
    { alwaysActive: false, keys: '5Key', name: '5' },
  ])
  expectJsonToolResponse(await instance.handle('risu-list-module-lorebooks', { count: 3, offset: 10, id: 'A' }), [])

  getDatabase().modules[0].lorebook = []

  expect(await instance.handle('risu-list-module-lorebooks', { id: 'A' })).toEqual(makeToolResponse([]))
})

test('retrieves fields of a lorebook', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    lorebook: Array(3)
      .fill(0)
      .map((_, i) => makeLorebook(String(i))),
  }
  getDatabase().modules = [module]

  expectJsonToolResponse(await instance.handle('risu-get-module-lorebook', { id: 'A', names: ['0', '2', '99'] }), [
    { alwaysActive: false, content: '0Content', keys: '0Key', name: '0' },
    { alwaysActive: false, content: '2Content', keys: '2Key', name: '2' },
  ])
})

test('lists all regex scripts of a module', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    regex: Array(10)
      .fill(0)
      .map((_, i) => makeRegex(String(i))),
  }
  getDatabase().modules = [module]

  expectJsonToolResponse(
    await instance.handle('risu-get-module-regex-scripts', { id: 'A' }),
    Array.from({ length: 10 }, (_, i) => ({
      ableFlag: true,
      comment: String(i),
      flag: '',
      in: `${i}In`,
      out: `${i}Out`,
      type: 'editdisplay',
    })),
  )

  getDatabase().modules[0].regex = []

  expect(await instance.handle('risu-get-module-regex-scripts', { id: 'A' })).toEqual(makeToolResponse([]))
})

test('retrieves a module Lua script', async () => {
  const instance = new ModuleHandler()

  const module: RisuModule = {
    ...makeModule('A'),
    trigger: [
      {
        comment: '',
        conditions: [],
        effect: [
          {
            code: 'print("hello")',
            type: 'triggerlua',
          },
        ],
        type: 'manual',
      },
    ],
  }
  getDatabase().modules = [module]

  expect(await instance.handle('risu-get-module-lua-script', { id: 'A' })).toEqual(makeToolResponse('print("hello")'))
})

test('errs retrieving a module Lua script if it is not using one', async () => {
  const instance = new ModuleHandler()

  getDatabase().modules = [makeModule('A')]

  expect(await instance.handle('risu-get-module-lua-script', { id: 'A' })).toEqual(
    makeToolResponse('Error: This module does not contain a Lua trigger.'),
  )
})

test('errs if module not found', async () => {
  const instance = new ModuleHandler()
  const subjects = [
    'risu-get-module-info',
    'risu-set-module-info',
    'risu-list-module-lorebooks',
    'risu-get-module-lorebook',
    'risu-set-module-lorebook',
    'risu-delete-module-lorebook',
    'risu-get-module-regex-scripts',
    'risu-set-module-regex-script',
    'risu-delete-module-regex-script',
    'risu-get-module-lua-script',
    'risu-set-module-lua-script',
  ] as const

  const errors = await Promise.all(subjects.map((tool) => instance.handle(tool, { id: 'zzz' })))

  expect(errors.length).toBe(subjects.length)
  expect(
    errors
      .map((responses) => responses[0])
      .every((response) => (response as RPCToolCallTextContent).text === 'Error: Module with ID zzz not found.'),
  ).toBe(true)
})
