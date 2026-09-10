import {
  beginWriterDraftCaptureTest,
  capturedWriterDrafts,
  endWriterDraftCaptureTest,
} from 'src/ts/__tests__/writerDraftCapture'
import { demoteClientSession } from 'src/ts/clientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleProcessSpies = vi.hoisted(() => ({
  exportModule: vi.fn(),
  getModuleAssets: vi.fn(() => []),
  getModuleLorebooks: vi.fn(() => []),
  getModuleMcps: vi.fn(() => []),
  getModuleRegexScripts: vi.fn(() => []),
  getModuleToggles: vi.fn(() => ''),
  getModuleTriggers: vi.fn(() => []),
  getModules: vi.fn(() => []),
  importModule: vi.fn(),
  moduleUpdate: vi.fn(),
  refreshModules: vi.fn(),
}))

const moduleCommandSpies = vi.hoisted(() => ({
  createGlobalModule: vi.fn(async (_module: any): Promise<any> => ({ status: 'accepted', result: null })),
  deleteGlobalModule: vi.fn(),
  saveGlobalModuleDraft: vi.fn(
    async (_moduleId: string, _module: any): Promise<any> => ({
      status: 'accepted',
      result: null,
    }),
  ),
  setGlobalModuleEnabled: vi.fn(),
  createModuleFolder: vi.fn(async (): Promise<any> => ({ status: 'accepted', result: null })),
  renameModuleFolder: vi.fn(async (): Promise<any> => ({ status: 'accepted', result: null })),
  deleteModuleFolder: vi.fn(async (): Promise<any> => ({ status: 'accepted', result: null })),
  reorderModuleFolders: vi.fn(async (): Promise<any> => ({ status: 'accepted', result: null })),
  reorderGlobalModules: vi.fn(async (): Promise<any> => ({ status: 'accepted', result: null })),
}))

const moduleDraftStoreSpies = vi.hoisted(() => {
  const state = { sequence: 0, failureListener: null as (() => void) | null }
  return {
    state,
    deleteModuleEditorDraft: vi.fn(async () => true),
    isModuleEditorDraftGenerationCurrent: vi.fn(async () => true),
    readLatestModuleEditorDraft: vi.fn(async () => null as any),
    registerModuleEditorDraftStorageFailureListener: vi.fn((listener: () => void) => {
      state.failureListener = listener
      return () => {
        if (state.failureListener === listener) state.failureListener = null
      }
    }),
    writeModuleEditorDraft: vi.fn((input: any) => {
      state.sequence += 1
      return {
        generation: {
          key: JSON.stringify([input.mode, input.moduleId]),
          databaseLineage: 'database-a',
          writerSessionId: 'writer-a',
          mode: input.mode,
          moduleId: input.moduleId,
          sequence: state.sequence,
          updatedAt: state.sequence,
        },
        ready: Promise.resolve('persisted'),
      }
    }),
  }
})

const lorebookOwnerSpies = vi.hoisted(() => ({
  applyLorebookEntryDraftEdit: vi.fn(() => false),
  flushPendingLorebookEntryDraftEdit: vi.fn(),
  replaceModuleLorebookCollectionDraft: vi.fn(() => false),
}))

const scriptDefinitionOwnerSpies = vi.hoisted(() => ({
  applyModuleScriptDefinitionDraft: vi.fn(() => false),
}))

const alertSpies = vi.hoisted(() => ({
  alertConfirm: vi.fn(async () => false),
  alertError: vi.fn(),
  alertInput: vi.fn(async () => null as string | null),
  alertMd: vi.fn(),
  alertNormal: vi.fn(),
}))

const globalApiSpies = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  getFileSrc: vi.fn(async () => ''),
  openURL: vi.fn(),
  saveAsset: vi.fn(async () => ''),
}))

const mcpSpies = vi.hoisted(() => ({
  importMCPModule: vi.fn(async () => {}),
}))

vi.mock('src/ts/process/modules', () => moduleProcessSpies)
vi.mock('src/ts/moduleCommands', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/moduleCommands')>()),
  ...moduleCommandSpies,
  createGlobalModuleWithOutcome: moduleCommandSpies.createGlobalModule,
  saveGlobalModuleDraftWithOutcome: moduleCommandSpies.saveGlobalModuleDraft,
}))
vi.mock('src/ts/server/moduleEditorDraftStore', () => moduleDraftStoreSpies)
vi.mock('src/ts/server/lorebookOwner.svelte', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/server/lorebookOwner.svelte')>()),
  ...lorebookOwnerSpies,
}))
vi.mock('src/ts/server/scriptDefinitionOwner.svelte', async (importActual) => ({
  ...(await importActual<typeof import('src/ts/server/scriptDefinitionOwner.svelte')>()),
  ...scriptDefinitionOwnerSpies,
}))
vi.mock('src/ts/alert', () => alertSpies)
vi.mock('src/ts/globalApi.svelte', () => globalApiSpies)
vi.mock('src/ts/process/mcp/mcp', () => mcpSpies)
vi.mock('src/ts/gui/tooltip', () => ({
  tooltip: () => ({
    destroy: vi.fn(),
    update: vi.fn(),
  }),
}))
vi.mock('src/ts/server/commands', async (importActual) => {
  const actual = await importActual<typeof import('src/ts/server/commands')>()
  return {
    ...actual,
    canUseServerCommands: vi.fn(() => false),
  }
})

import ModuleSettings from './ModuleSettings.svelte'
import { language } from 'src/lang'
import type { RisuModule } from 'src/ts/process/modules'
import {
  collectionsResourceState,
  replaceResourceDatabase as setDatabaseLite,
  settingsResourceState,
} from 'src/ts/server/resourceState.svelte'
import { selectedCharID } from 'src/ts/stores.svelte'
import { requestActiveModuleEditorLeave } from 'src/ts/moduleEditorLeaveGuard'
import { getResourceDatabase as getDatabase } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

interface NameReadCounter {
  count: number
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

interface ModuleFixtureOptions {
  id: string
  name: string
  description?: string
  namespace?: string
  mcp?: RisuModule['mcp']
  folderId?: string
  readCounter?: NameReadCounter
}

let target: HTMLElement
let component: MountedComponent | undefined
const confirmLeave = vi.fn(() => false)

function makeModule(options: ModuleFixtureOptions): RisuModule {
  let currentName = options.name
  const module: Record<string, unknown> = {
    id: options.id,
    description: options.description ?? `${options.name} description`,
    namespace: options.namespace,
    mcp: options.mcp,
    folderId: options.folderId,
  }

  Object.defineProperty(module, 'name', {
    configurable: true,
    enumerable: true,
    get() {
      options.readCounter && (options.readCounter.count += 1)
      return currentName
    },
    set(value: string) {
      currentName = value
    },
  })

  return module as unknown as RisuModule
}

function seedModules(readCounter?: NameReadCounter, moduleCount = 4) {
  const modules = [
    makeModule({
      id: 'zulu-id',
      name: 'zulu module',
      readCounter,
    }),
    makeModule({
      id: 'alpha-id',
      name: 'Alpha Module',
      readCounter,
    }),
    makeModule({
      id: 'beta-id',
      name: 'beta Module',
      namespace: 'shared',
      readCounter,
    }),
    makeModule({
      id: 'mcp-id',
      name: 'MCP Tools',
      mcp: { url: 'https://example.test/mcp' },
      readCounter,
    }),
  ]
  for (let index = modules.length; index < moduleCount; index += 1) {
    modules.push(
      makeModule({
        id: `generated-${index}`,
        name: `Generated Module ${index}`,
        readCounter,
      }),
    )
  }
  setDatabaseLite({
    characters: [],
    enabledModules: ['alpha-id'],
    language: 'en',
    loreBook: [],
    moduleIntergration: 'shared, trimmed',
    modules: [],
    moduleFolders: [],
    showDeprecatedTriggerV1: false,
    useAdditionalAssetsPreview: false,
  } as any)
  collectionsResourceState.values.modules = modules
  collectionsResourceState.statuses.modules = 'ready'
}

function mountSettings() {
  component = mount(ModuleSettings, { target })
}

function moduleRows() {
  return Array.from(target.querySelectorAll<HTMLElement>('[data-risu-module-row]'))
}

function moduleRowNames() {
  return moduleRows().map((row) => row.querySelector('[data-risu-module-name]')?.textContent?.trim())
}

function rowForModuleId(moduleId: string) {
  const row = moduleRows().find((candidate) => candidate.getAttribute('data-risu-row-id') === moduleId)
  expect(row, `module row ${moduleId}`).toBeTruthy()
  return row!
}

function moduleAction(moduleId: string, actionKind: string) {
  const action = rowForModuleId(moduleId).querySelector<HTMLButtonElement>(
    `button[data-risu-module-action="${actionKind}"]`,
  )
  expect(action, `module ${moduleId} action ${actionKind}`).toBeTruthy()
  return action!
}

function moduleSurfaceAction(actionKind: string) {
  const actionRoot = target.querySelector<HTMLElement>(`[data-risu-module-action="${actionKind}"]`)
  expect(actionRoot, `module surface action ${actionKind}`).toBeTruthy()
  if (actionRoot instanceof HTMLButtonElement) return actionRoot

  const button = actionRoot!.querySelector<HTMLButtonElement>('button')
  expect(button, `module surface action ${actionKind} button`).toBeTruthy()
  return button!
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text,
  )
  expect(button, `button ${text}`).toBeTruthy()
  return button!
}

function buttonByAriaLabel(label: string): HTMLButtonElement {
  const button = target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button, `button labelled ${label}`).toBeTruthy()
  return button!
}

async function addNestedModuleDraftRows() {
  buttonByText(language.loreBook).click()
  await tick()
  buttonByAriaLabel(`${language.add}: ${language.loreBook}`).click()
  await tick()

  buttonByText(language.regexScript).click()
  await tick()
  buttonByAriaLabel(`${language.add}: ${language.regexScript}`).click()
  await tick()

  buttonByText(language.triggerScript).click()
  await tick()
  buttonByText('Lua').click()
  await tick()
}

async function updateSearch(value: string) {
  const input = target.querySelector(`input[placeholder="${language.search}"]`) as HTMLInputElement | null
  expect(input).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}

async function updateModuleName(value: string) {
  const input = target.querySelector<HTMLInputElement>('input[type="text"]')
  expect(input, 'module name input').toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}

async function clickModuleSurfaceAction(actionKind: string) {
  moduleSurfaceAction(actionKind).click()
  await tick()
}

beforeEach(() => {
  selectedCharID.set(-1)
  target = document.createElement('div')
  document.body.appendChild(target)
  vi.clearAllMocks()
  confirmLeave.mockReturnValue(false)
  vi.stubGlobal('confirm', confirmLeave)
  moduleDraftStoreSpies.state.sequence = 0
  moduleDraftStoreSpies.state.failureListener = null
  moduleDraftStoreSpies.readLatestModuleEditorDraft.mockResolvedValue(null)
  moduleDraftStoreSpies.isModuleEditorDraftGenerationCurrent.mockResolvedValue(true)
  moduleDraftStoreSpies.deleteModuleEditorDraft.mockResolvedValue(true)
  moduleCommandSpies.createGlobalModule.mockResolvedValue({ status: 'accepted', result: null })
  moduleCommandSpies.saveGlobalModuleDraft.mockResolvedValue({ status: 'accepted', result: null })
  moduleCommandSpies.deleteGlobalModule.mockResolvedValue({ status: 'accepted', result: null })
  moduleCommandSpies.setGlobalModuleEnabled.mockResolvedValue({ status: 'accepted', result: null })
  alertSpies.alertConfirm.mockResolvedValue(false)
  seedModules()
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('ModuleSettings unsaved-change safeguards', () => {
  it('leaves an unchanged editor without prompting', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()

    expect(requestActiveModuleEditorLeave()).toBe(true)
    expect(confirmLeave).not.toHaveBeenCalled()
  })

  it('keeps a dirty editor open when leaving is canceled', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Unsaved Alpha')

    expect(requestActiveModuleEditorLeave()).toBe(false)
    expect(confirmLeave).toHaveBeenCalledWith(language.moduleSave.leaveEditorConfirm)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Unsaved Alpha')
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).not.toHaveBeenCalled()
  })

  it('warns for a changed create draft but not a newly opened blank draft', async () => {
    mountSettings()
    await clickModuleSurfaceAction('create')

    expect(requestActiveModuleEditorLeave()).toBe(true)
    expect(confirmLeave).not.toHaveBeenCalled()

    await updateModuleName('Unsaved New Module')

    expect(requestActiveModuleEditorLeave()).toBe(false)
    expect(confirmLeave).toHaveBeenCalledWith(language.moduleSave.leaveEditorConfirm)
  })

  it('allows leaving a dirty editor while retaining its recovery draft', async () => {
    confirmLeave.mockReturnValue(true)
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Recoverable Alpha')

    expect(requestActiveModuleEditorLeave()).toBe(true)
    expect(confirmLeave).toHaveBeenCalledWith(language.moduleSave.leaveEditorConfirm)
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).not.toHaveBeenCalled()
  })

  it('confirms before explicitly discarding a dirty draft', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Maybe discard Alpha')

    await clickModuleSurfaceAction('discard-draft')

    expect(confirmLeave).toHaveBeenCalledWith(language.moduleSave.discardChangesConfirm)
    expect(target.querySelector('[data-risu-module-action="submit-edit"]')).toBeTruthy()
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).not.toHaveBeenCalled()

    confirmLeave.mockReturnValue(true)
    await clickModuleSurfaceAction('discard-draft')

    expect(target.querySelector('[data-risu-module-action="submit-edit"]')).toBeNull()
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).toHaveBeenCalledOnce()
  })

  it('requests the native browser warning only for a dirty editor', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()

    const unchangedUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unchangedUnload)
    expect(unchangedUnload.defaultPrevented).toBe(false)

    await updateModuleName('Unsaved before unload')
    const dirtyUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyUnload)
    expect(dirtyUnload.defaultPrevented).toBe(true)
  })
})

describe('ModuleSettings derived module rows', () => {
  it('names module actions and exposes their enabled state', () => {
    mountSettings()

    expect(moduleAction('alpha-id', 'toggle-enabled').getAttribute('aria-label')).toBe(
      `${language.enableGlobal}: Alpha Module`,
    )
    expect(moduleAction('alpha-id', 'toggle-enabled').getAttribute('aria-pressed')).toBe('true')
    expect(moduleAction('beta-id', 'toggle-enabled').getAttribute('aria-pressed')).toBe('false')
    expect(moduleAction('beta-id', 'export').getAttribute('aria-label')).toBe(`${language.download}: beta Module`)
    expect(moduleAction('beta-id', 'edit').getAttribute('aria-label')).toBe(`${language.edit}: beta Module`)
    expect(moduleAction('beta-id', 'delete').getAttribute('aria-label')).toBe(`${language.remove}: beta Module`)
    expect(moduleAction('mcp-id', 'export').disabled).toBe(true)
    expect(moduleAction('mcp-id', 'edit').disabled).toBe(true)
    expect(moduleSurfaceAction('create').getAttribute('aria-label')).toBe(language.createModule)
    expect(moduleSurfaceAction('import-mcp').getAttribute('aria-label')).toBe(`${language.import}: MCP`)
    expect(moduleSurfaceAction('import').getAttribute('aria-label')).toBe(`${language.import}: ${language.module}`)
  })

  it('disables MCP import while its persistence outcome is pending', async () => {
    const importing = createDeferred<void>()
    mcpSpies.importMCPModule.mockReturnValue(importing.promise)
    mountSettings()
    const action = moduleSurfaceAction('import-mcp')

    action.click()
    action.click()
    await tick()

    expect(mcpSpies.importMCPModule).toHaveBeenCalledOnce()
    expect(action.disabled).toBe(true)
    expect(action.getAttribute('aria-busy')).toBe('true')

    importing.resolve()
    await tick()
    expect(action.disabled).toBe(false)
    expect(action.getAttribute('aria-busy')).toBe('false')
  })

  it('uses the localized fallback for a module without a description', () => {
    getDatabase().modules[2].description = ''
    mountSettings()

    expect(target.textContent).toContain(language.noModuleDescription)
  })

  it('names module lorebook actions', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    buttonByText(language.loreBook).click()
    await tick()

    const labels = Array.from(target.querySelectorAll<HTMLButtonElement>('button'), (button) =>
      button.getAttribute('aria-label'),
    )
    expect(labels).toContain(`${language.add}: ${language.loreBook}`)
    expect(labels).toContain(`${language.export}: ${language.loreBook}`)
    expect(labels).toContain(`${language.add}: ${language.folderName}`)
    expect(labels).toContain(`${language.import}: ${language.loreBook}`)
  })

  it('ModuleSettings empty search preserves the authoritative module order', () => {
    mountSettings()

    expect(moduleRowNames()).toEqual(['zulu module', 'Alpha Module', 'beta Module', 'MCP Tools'])
  })

  it('groups modules by folder, searches descriptions, and exposes folder management', async () => {
    settingsResourceState.value.moduleFolders = [
      { id: 'folder-b', name: 'Tools' },
      { id: 'folder-a', name: 'Writing' },
    ]
    collectionsResourceState.values.modules = [
      makeModule({ id: 'alpha-id', name: 'Alpha Module', folderId: 'folder-a' }),
      makeModule({ id: 'beta-id', name: 'Beta Module', description: 'special needle', folderId: 'folder-b' }),
      makeModule({ id: 'loose-id', name: 'Loose Module', folderId: 'missing' }),
    ]
    mountSettings()

    expect(
      Array.from(target.querySelectorAll<HTMLElement>('[data-risu-module-folder]'), (section) =>
        section.getAttribute('data-risu-module-folder'),
      ),
    ).toEqual(['folder-b', 'folder-a', 'uncategorized'])
    expect(moduleRowNames()).toEqual(['Beta Module', 'Alpha Module', 'Loose Module'])

    await updateSearch('needle')
    expect(moduleRowNames()).toEqual(['Beta Module'])
    expect(rowForModuleId('beta-id').getAttribute('draggable')).toBe('false')

    alertSpies.alertInput.mockResolvedValueOnce('New Folder')
    moduleSurfaceAction('create-folder').click()
    await vi.waitFor(() => expect(moduleCommandSpies.createModuleFolder).toHaveBeenCalledOnce())
    expect(moduleCommandSpies.createModuleFolder).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Folder' }))
  })

  it('ModuleSettings filtered rows keep action targets by module id', async () => {
    alertSpies.alertConfirm.mockResolvedValueOnce(true)
    mountSettings()
    await updateSearch('BETA')

    expect(moduleRowNames()).toEqual(['beta Module'])

    const betaRow = rowForModuleId('beta-id')
    expect(betaRow.getAttribute('data-risu-enabled')).toBe('false')
    expect(betaRow.getAttribute('data-risu-integration-state')).toBe('integrated')

    moduleAction('beta-id', 'toggle-enabled').click()
    await tick()
    expect(moduleCommandSpies.setGlobalModuleEnabled).toHaveBeenCalledWith('beta-id', true)

    moduleAction('beta-id', 'export').click()
    await tick()
    expect(moduleProcessSpies.exportModule).toHaveBeenCalledWith(getDatabase().modules[2])

    moduleAction('beta-id', 'delete').click()
    await tick()
    await Promise.resolve()
    expect(moduleCommandSpies.deleteGlobalModule).toHaveBeenCalledWith('beta-id')
  })

  it('shows the current chat Prompt Preset namespace integration state', () => {
    getDatabase().moduleIntergration = ''
    getDatabase().promptPresets = [{ id: 'gpt-preset', name: 'GPT', moduleIntergration: 'shared' }]
    getDatabase().characters = [
      {
        chaId: 'character-a',
        chatPage: 0,
        chats: [{ id: 'chat-a', generationSettings: { promptPresetId: 'gpt-preset' } }],
      },
    ] as any
    selectedCharID.set(0)

    mountSettings()

    expect(rowForModuleId('beta-id').getAttribute('data-risu-integration-state')).toBe('integrated')
    expect(moduleAction('beta-id', 'toggle-enabled').getAttribute('aria-pressed')).toBe('false')
  })

  it('fails closed for errored or duplicate module collection owners', () => {
    collectionsResourceState.statuses.modules = 'error'
    mountSettings()

    expect(moduleRows()).toEqual([])
    expect(moduleSurfaceAction('create').disabled).toBe(true)
    expect(moduleSurfaceAction('import').disabled).toBe(true)

    unmount(component!)
    component = undefined
    seedModules()
    getDatabase().modules = [
      makeModule({ id: 'duplicate-id', name: 'First duplicate' }),
      makeModule({ id: 'duplicate-id', name: 'Second duplicate' }),
    ]
    mountSettings()

    expect(moduleRows()).toEqual([])
    expect(moduleSurfaceAction('create').disabled).toBe(true)
    expect(moduleCommandSpies.setGlobalModuleEnabled).not.toHaveBeenCalled()
  })

  it('does not dispatch enable mutations when the enabled-module owner is unavailable', () => {
    settingsResourceState.groupStatuses.modules = 'error'
    mountSettings()

    const toggle = moduleAction('beta-id', 'toggle-enabled')
    expect(toggle.disabled).toBe(true)
    toggle.click()
    expect(moduleCommandSpies.setGlobalModuleEnabled).not.toHaveBeenCalled()
  })

  it('keeps a module toggle busy through its durable outcome and reports queued work', async () => {
    const outcome = createDeferred<any>()
    moduleCommandSpies.setGlobalModuleEnabled.mockReturnValueOnce(outcome.promise)
    mountSettings()

    const toggle = moduleAction('beta-id', 'toggle-enabled')
    toggle.click()
    toggle.click()
    await tick()

    expect(moduleCommandSpies.setGlobalModuleEnabled).toHaveBeenCalledOnce()
    expect(moduleCommandSpies.setGlobalModuleEnabled).toHaveBeenCalledWith('beta-id', true)
    expect(toggle.disabled).toBe(true)
    expect(rowForModuleId('beta-id').getAttribute('aria-busy')).toBe('true')

    outcome.resolve({ status: 'queued', result: { status: 'unavailable' } })
    await vi.waitFor(() => expect(alertSpies.alertNormal).toHaveBeenCalledWith(language.moduleSave.queued))
    expect(toggle.disabled).toBe(false)
    expect(rowForModuleId('beta-id').getAttribute('aria-busy')).toBe('false')
  })

  it('blocks duplicate deletes and exposes a terminal delete failure on its row', async () => {
    const outcome = createDeferred<any>()
    alertSpies.alertConfirm.mockResolvedValue(true)
    moduleCommandSpies.deleteGlobalModule.mockReturnValueOnce(outcome.promise)
    mountSettings()

    const deleteButton = moduleAction('beta-id', 'delete')
    deleteButton.click()
    deleteButton.click()
    await vi.waitFor(() => expect(moduleCommandSpies.deleteGlobalModule).toHaveBeenCalledOnce())

    expect(alertSpies.alertConfirm).toHaveBeenCalledOnce()
    expect(deleteButton.disabled).toBe(true)
    outcome.resolve({ status: 'failed', result: { status: 'unavailable' } })
    await outcome.promise
    await vi.waitFor(() => expect(deleteButton.disabled).toBe(false))

    expect(
      target.querySelector('[data-risu-module-mutation-error][data-risu-row-id="beta-id"]')?.textContent,
    ).toContain(language.moduleSave.commandUnavailable)
    expect(deleteButton.disabled).toBe(false)
  })

  it('ModuleSettings edit after filtering saves the original module id', async () => {
    mountSettings()
    await updateSearch('beta')

    moduleAction('beta-id', 'edit').click()
    await tick()

    await clickModuleSurfaceAction('submit-edit')

    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledOnce()
    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledWith(
      'beta-id',
      expect.objectContaining({
        id: 'beta-id',
        name: 'beta Module',
      }),
    )
  })

  it('rebases an edit onto the latest module without overwriting untouched remote fields', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Locally renamed module')

    getDatabase().modules = getDatabase().modules.map((candidate) =>
      candidate.id === 'alpha-id'
        ? {
            ...candidate,
            description: 'Description changed remotely',
            cjs: 'remote module code',
          }
        : candidate,
    )
    await tick()

    await clickModuleSurfaceAction('submit-edit')

    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledOnce()
    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledWith(
      'alpha-id',
      expect.objectContaining({
        id: 'alpha-id',
        name: 'Locally renamed module',
        description: 'Description changed remotely',
        cjs: 'remote module code',
      }),
    )
  })

  it('saves Background Embedding textarea edits with the module draft', async () => {
    mountSettings()

    moduleAction('alpha-id', 'edit').click()
    await tick()

    buttonByText(language.regexScript).click()
    await tick()

    const textarea = target.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${language.backgroundHTML}"]`)
    expect(textarea).toBeTruthy()
    textarea!.value = '<style>.chattext .name { color: red; }</style>'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    await clickModuleSurfaceAction('submit-edit')

    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledOnce()
    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledWith(
      'alpha-id',
      expect.objectContaining({
        id: 'alpha-id',
        backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
      }),
    )
  })

  it('abandons nested module edits without mutating or dispatching the live module', async () => {
    getDatabase().modules[1] = {
      ...getDatabase().modules[1],
      lorebook: [],
      regex: [],
      trigger: [],
    }
    const liveBeforeEdit = JSON.parse(JSON.stringify(getDatabase().modules[1]))
    mountSettings()

    moduleAction('alpha-id', 'edit').click()
    await tick()
    await addNestedModuleDraftRows()

    expect(getDatabase().modules[1]).toEqual(liveBeforeEdit)
    expect(moduleCommandSpies.saveGlobalModuleDraft).not.toHaveBeenCalled()
    expect(lorebookOwnerSpies.applyLorebookEntryDraftEdit).not.toHaveBeenCalled()
    expect(lorebookOwnerSpies.flushPendingLorebookEntryDraftEdit).not.toHaveBeenCalled()
    expect(lorebookOwnerSpies.replaceModuleLorebookCollectionDraft).not.toHaveBeenCalled()
    expect(scriptDefinitionOwnerSpies.applyModuleScriptDefinitionDraft).not.toHaveBeenCalled()

    unmount(component!)
    component = undefined
    await tick()

    expect(getDatabase().modules[1]).toEqual(liveBeforeEdit)
    expect(moduleCommandSpies.saveGlobalModuleDraft).not.toHaveBeenCalled()
  })

  it('saves lorebook, regex, and trigger draft edits together only on explicit Save', async () => {
    getDatabase().modules[1] = {
      ...getDatabase().modules[1],
      lorebook: [],
      regex: [],
      trigger: [],
    }
    mountSettings()

    moduleAction('alpha-id', 'edit').click()
    await tick()
    await addNestedModuleDraftRows()

    expect(getDatabase().modules[1]).toMatchObject({ lorebook: [], regex: [], trigger: [] })
    expect(moduleCommandSpies.saveGlobalModuleDraft).not.toHaveBeenCalled()

    await clickModuleSurfaceAction('submit-edit')

    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledOnce()
    const [, savedModule] = moduleCommandSpies.saveGlobalModuleDraft.mock.calls[0]
    expect(savedModule.lorebook).toHaveLength(1)
    expect(savedModule.lorebook[0]).toMatchObject({ comment: 'New Lore', content: '' })
    expect(savedModule.regex).toHaveLength(1)
    expect(savedModule.regex[0]).toMatchObject({ type: 'editinput', in: '', out: '' })
    expect(savedModule.trigger).toHaveLength(1)
    expect(savedModule.trigger[0]).toMatchObject({ type: 'start' })
    expect(lorebookOwnerSpies.replaceModuleLorebookCollectionDraft).not.toHaveBeenCalled()
    expect(scriptDefinitionOwnerSpies.applyModuleScriptDefinitionDraft).not.toHaveBeenCalled()
  })

  it('keeps nested collections in create drafts until the create command', async () => {
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Nested Module')
    await addNestedModuleDraftRows()

    expect(moduleCommandSpies.createGlobalModule).not.toHaveBeenCalled()
    expect(lorebookOwnerSpies.replaceModuleLorebookCollectionDraft).not.toHaveBeenCalled()
    expect(scriptDefinitionOwnerSpies.applyModuleScriptDefinitionDraft).not.toHaveBeenCalled()

    await clickModuleSurfaceAction('submit-create')

    expect(moduleCommandSpies.createGlobalModule).toHaveBeenCalledOnce()
    expect(moduleCommandSpies.createGlobalModule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nested Module',
        lorebook: [expect.objectContaining({ comment: 'New Lore' })],
        regex: [expect.objectContaining({ type: 'editinput' })],
        trigger: expect.any(Array),
      }),
    )
    expect(moduleCommandSpies.createGlobalModule.mock.calls[0][0].trigger).toHaveLength(1)
  })

  it.each([4, 40])(
    'ModuleSettings search stays within a linear read bound for %i rows and reuses results across view switches',
    async (moduleCount) => {
      const readCounter = { count: 0 }
      seedModules(readCounter, moduleCount)
      mountSettings()

      readCounter.count = 0
      await updateSearch('ALPHA')
      expect(readCounter.count).toBeLessThanOrEqual(moduleCount + 2)
      expect(moduleRowNames()).toEqual(['Alpha Module'])

      readCounter.count = 0
      moduleAction('alpha-id', 'edit').click()
      await tick()
      await clickModuleSurfaceAction('discard-draft')

      expect(moduleRowNames()).toEqual(['Alpha Module'])
      expect(readCounter.count).toBeLessThanOrEqual(3)
    },
  )

  it.each([
    ['empty', ''],
    ['whitespace-only', '  \t  '],
  ])('rejects a %s module name during creation', async (_case, name) => {
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName(name)

    await clickModuleSurfaceAction('submit-create')

    expect(moduleCommandSpies.createGlobalModule).not.toHaveBeenCalled()
    expect(alertSpies.alertError).toHaveBeenCalledOnce()
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.errors.emptyText)
    expect(target.textContent).toContain(language.createModule)
  })

  it('keeps and unlocks a create draft when the server rejects the save', async () => {
    const save = createDeferred<any>()
    moduleCommandSpies.createGlobalModule.mockReturnValueOnce(save.promise)
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Unsaved module')

    moduleSurfaceAction('submit-create').click()
    await tick()

    const fieldset = target.querySelector<HTMLFieldSetElement>('fieldset')
    const nameInput = target.querySelector<HTMLInputElement>('input[type="text"]')
    expect(fieldset?.disabled).toBe(true)
    expect(nameInput?.closest<HTMLFieldSetElement>('fieldset')?.disabled).toBe(true)
    expect(moduleSurfaceAction('submit-create').disabled).toBe(true)
    expect(target.textContent).not.toContain(language.moduleSave.saving)
    expect(target.textContent).toContain(language.createModule)

    save.resolve({ status: 'failed', result: { status: 'error', error: 'disk full' } })
    await save.promise
    await tick()

    expect(target.textContent).toContain(language.createModule)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Unsaved module')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('disk full')
    expect(target.querySelector<HTMLFieldSetElement>('fieldset')?.disabled).toBe(false)
    expect(moduleSurfaceAction('submit-create').disabled).toBe(false)
  })

  it('keeps an edit draft open when the server reports a revision conflict', async () => {
    const save = createDeferred<any>()
    moduleCommandSpies.saveGlobalModuleDraft.mockReturnValueOnce(save.promise)
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Draft rename')

    moduleSurfaceAction('submit-edit').click()
    await tick()
    expect(target.textContent).toContain(language.editModule)
    expect(moduleSurfaceAction('submit-edit').disabled).toBe(true)

    save.resolve({ status: 'failed', result: { status: 'conflict', currentRevision: 42 } })
    await save.promise
    await tick()

    expect(target.textContent).toContain(language.editModule)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Draft rename')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.moduleSave.commandConflict)
    expect(moduleSurfaceAction('submit-edit').disabled).toBe(false)
  })

  it('keeps an edit draft when its source module disappeared before save', async () => {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Recovered draft')
    getDatabase().modules = getDatabase().modules.filter((candidate) => candidate.id !== 'alpha-id')

    await clickModuleSurfaceAction('submit-edit')

    expect(moduleCommandSpies.saveGlobalModuleDraft).not.toHaveBeenCalled()
    expect(target.textContent).toContain(language.editModule)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Recovered draft')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.moduleSave.editTargetMissing)
  })

  it('keeps a create draft when module commands are unavailable', async () => {
    moduleCommandSpies.createGlobalModule.mockResolvedValueOnce({
      status: 'failed',
      result: { status: 'unavailable' },
    })
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Offline draft')

    await clickModuleSurfaceAction('submit-create')

    expect(target.textContent).toContain(language.createModule)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Offline draft')
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.moduleSave.commandUnavailable)
  })

  it('closes the editor only after a module save succeeds', async () => {
    const save = createDeferred<any>()
    moduleCommandSpies.createGlobalModule.mockReturnValueOnce(save.promise)
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Saved module')

    moduleSurfaceAction('submit-create').click()
    await tick()
    expect(target.textContent).toContain(language.createModule)

    save.resolve({
      status: 'accepted',
      result: {
        status: 'ok',
        revision: 11,
        event: { type: 'module.created', revision: 11, resource: 'module' },
      },
    })
    await save.promise
    await tick()

    expect(target.textContent).toContain(language.modules)
    expect(target.textContent).not.toContain(language.moduleSave.saving)
    expect(target.querySelector('[data-risu-module-action="submit-create"]')).toBeNull()
  })

  it('restores a nested create draft after reload with its original stable client id', async () => {
    moduleDraftStoreSpies.readLatestModuleEditorDraft.mockResolvedValueOnce({
      mode: 'create',
      moduleId: 'stable-create-id',
      editBaseline: null,
      tempModule: {
        id: 'stable-create-id',
        name: 'Recovered Create',
        description: 'Recovered description',
        cjs: 'recovered code',
        assets: [['asset-a', 'asset-ref']],
        lorebook: [{ id: 'lore-a', content: 'recovered lore' }],
        regex: [{ id: 'regex-a', in: 'before', out: 'after' }],
        trigger: [{ id: 'trigger-a', type: 'start', effect: [] }],
      },
      generation: {
        key: 'recovered-create',
        databaseLineage: 'database-a',
        writerSessionId: 'writer-a',
        mode: 'create',
        moduleId: 'stable-create-id',
        sequence: 7,
        updatedAt: 7,
      },
      updatedAt: 7,
    })

    mountSettings()

    await vi.waitFor(() =>
      expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Recovered Create'),
    )
    await clickModuleSurfaceAction('submit-create')
    expect(moduleCommandSpies.createGlobalModule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stable-create-id',
        cjs: 'recovered code',
        assets: [['asset-a', 'asset-ref']],
        lorebook: [expect.objectContaining({ content: 'recovered lore' })],
        regex: [expect.objectContaining({ in: 'before' })],
        trigger: [expect.objectContaining({ id: 'trigger-a' })],
      }),
    )
  })

  it('rebases a recovered edit onto the latest server module before reopening and saving', async () => {
    const latest = getDatabase().modules.find((candidate) => candidate.id === 'alpha-id')!
    latest.description = 'Remote description'
    ;(latest as any).cjs = 'remote code'
    moduleDraftStoreSpies.readLatestModuleEditorDraft.mockResolvedValueOnce({
      mode: 'edit',
      moduleId: 'alpha-id',
      editBaseline: { id: 'alpha-id', name: 'Alpha Module', description: 'Old description' },
      tempModule: { id: 'alpha-id', name: 'Local recovered name', description: 'Old description' },
      generation: {
        key: 'recovered-edit',
        databaseLineage: 'database-a',
        writerSessionId: 'writer-a',
        mode: 'edit',
        moduleId: 'alpha-id',
        sequence: 8,
        updatedAt: 8,
      },
      updatedAt: 8,
    })

    mountSettings()
    await vi.waitFor(() =>
      expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Local recovered name'),
    )
    await clickModuleSurfaceAction('submit-edit')

    expect(moduleCommandSpies.saveGlobalModuleDraft).toHaveBeenCalledWith(
      'alpha-id',
      expect.objectContaining({
        name: 'Local recovered name',
        description: 'Remote description',
        cjs: 'remote code',
      }),
    )
  })

  it('opens Copy/Export/Discard recovery UI when an edited target was deleted', async () => {
    const generation = {
      key: 'deleted-edit',
      databaseLineage: 'database-a',
      writerSessionId: 'writer-a',
      mode: 'edit' as const,
      moduleId: 'deleted-module',
      sequence: 9,
      updatedAt: 9,
    }
    moduleDraftStoreSpies.readLatestModuleEditorDraft.mockResolvedValueOnce({
      mode: 'edit',
      moduleId: 'deleted-module',
      editBaseline: { id: 'deleted-module', name: 'Deleted baseline' },
      tempModule: { id: 'deleted-module', name: 'Recover this module', cjs: 'recoverable code' },
      generation,
      updatedAt: 9,
    })

    mountSettings()

    await vi.waitFor(() =>
      expect(target.querySelector('[data-risu-recovered-module-draft]')?.textContent).toContain('recoverable code'),
    )
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.moduleSave.editTargetMissing)
    moduleSurfaceAction('export-recovered-draft').click()
    expect(moduleProcessSpies.exportModule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deleted-module', cjs: 'recoverable code' }),
    )

    confirmLeave.mockReturnValue(true)
    await clickModuleSurfaceAction('discard-draft')
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).toHaveBeenCalledWith(generation)
    expect(target.querySelector('[data-risu-recovered-module-draft]')).toBeNull()
  })

  it('keeps a queued create open and deletes its exact generation only after final acceptance', async () => {
    const settlement = createDeferred<any>()
    moduleCommandSpies.createGlobalModule.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationIds: ['mutation-a'],
      settlement: settlement.promise,
    })
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Queued module')

    await clickModuleSurfaceAction('submit-create')

    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Queued module')
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).not.toHaveBeenCalled()
    expect(alertSpies.alertNormal).not.toHaveBeenCalledWith(language.moduleSave.queued)

    settlement.resolve({ status: 'accepted' })
    await vi.waitFor(() => expect(target.querySelector('[data-risu-module-action="submit-create"]')).toBeNull())
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).toHaveBeenCalledOnce()
  })

  it('deletes an accepted queued generation even after the editor unmounts', async () => {
    const settlement = createDeferred<any>()
    moduleCommandSpies.createGlobalModule.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationIds: ['mutation-create'],
      settlement: settlement.promise,
    })
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Unmounted queued module')
    await clickModuleSurfaceAction('submit-create')
    const generation = moduleDraftStoreSpies.writeModuleEditorDraft.mock.results.at(-1)?.value.generation

    unmount(component!)
    component = undefined
    settlement.resolve({ status: 'accepted' })

    await vi.waitFor(() => expect(moduleDraftStoreSpies.deleteModuleEditorDraft).toHaveBeenCalledWith(generation))
  })

  it('keeps a queued edit and recovery draft after final failure with persistent loud feedback', async () => {
    const settlement = createDeferred<any>()
    moduleCommandSpies.saveGlobalModuleDraft.mockResolvedValueOnce({
      status: 'queued',
      result: { status: 'unavailable' },
      mutationIds: ['mutation-edit'],
      settlement: settlement.promise,
    })
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    await updateModuleName('Queued edit')
    await clickModuleSurfaceAction('submit-edit')

    settlement.resolve({ status: 'failed', result: { status: 'error', error: 'replay rejected' } })
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('replay rejected'))

    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Queued edit')
    expect(moduleDraftStoreSpies.deleteModuleEditorDraft).not.toHaveBeenCalled()
    expect(alertSpies.alertError).toHaveBeenCalledWith(expect.stringContaining('replay rejected'))
  })

  it('surfaces local encrypted-draft storage failure without disabling the editor', async () => {
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Keep editing')

    moduleDraftStoreSpies.state.failureListener?.()
    await tick()

    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.moduleSave.draftStorageFailed)
    expect(alertSpies.alertError).toHaveBeenCalledWith(language.moduleSave.draftStorageFailed)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.disabled).toBe(false)
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe('Keep editing')
  })

  it('explicitly disables contenteditable descendants only during an explicit Save', async () => {
    const save = createDeferred<any>()
    moduleCommandSpies.createGlobalModule.mockReturnValueOnce(save.promise)
    mountSettings()
    await clickModuleSurfaceAction('create')
    await updateModuleName('Contenteditable lock')
    const fieldset = target.querySelector('fieldset')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    fieldset?.append(editable)
    expect(editable.getAttribute('contenteditable')).toBe('true')

    moduleSurfaceAction('submit-create').click()
    await tick()
    expect(editable.getAttribute('contenteditable')).toBe('false')
    expect(editable.getAttribute('aria-disabled')).toBe('true')

    save.resolve({ status: 'failed', result: { status: 'unavailable' } })
    await save.promise
    await tick()
    expect(editable.getAttribute('contenteditable')).toBe('true')
  })
})

it('hands the newest module field to its existing recovery store synchronously on demotion', async () => {
  await beginWriterDraftCaptureTest()
  try {
    mountSettings()
    moduleAction('alpha-id', 'edit').click()
    await tick()
    const input = target.querySelector<HTMLInputElement>('input[type="text"]')!
    expect(input).toBeTruthy()
    input.value = 'newest module draft'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    demoteClientSession()
    expect(moduleDraftStoreSpies.writeModuleEditorDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ tempModule: expect.objectContaining({ name: 'newest module draft' }) }),
    )
    expect(capturedWriterDrafts()).toHaveLength(0)
  } finally {
    if (component) {
      await unmount(component)
      component = undefined
    }
    await endWriterDraftCaptureTest()
  }
})
