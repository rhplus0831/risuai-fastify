import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const selectedFileState = vi.hoisted(() => ({
  file: null as null | { name: string; data: Uint8Array },
}))

const alertModuleSelect = vi.hoisted(() => vi.fn())
const alertNormal = vi.hoisted(() => vi.fn())
const alertError = vi.hoisted(() => vi.fn())
const alertConfirm = vi.hoisted(() => vi.fn())
const alertWait = vi.hoisted(() => vi.fn())
const saveAsset = vi.hoisted(() => vi.fn())
const saveAssets = vi.hoisted(() => vi.fn())
const decodeRPack = vi.hoisted(() => vi.fn(async (data: Uint8Array) => data))
const sleep = vi.hoisted(() => vi.fn())
const createGlobalModule = vi.hoisted(() => vi.fn())
const importLocalModuleFileFromServer = vi.hoisted(() => vi.fn())
const getCurrentCharacter = vi.hoisted(() => vi.fn())
const getCurrentChatMock = vi.hoisted(() => vi.fn())
type ModuleDatabaseFixture = {
  agentPresetDefaultId?: string
  agentPresets?: Array<Record<string, unknown>>
  characters?: unknown[]
  enabledModules?: string[]
  enableLorebookStubs?: boolean
  moduleIntergration?: string
  personas?: Array<Record<string, unknown>>
  promptPresets?: Array<Record<string, unknown>>
  selectedPersona?: number
  modules: Array<Record<string, unknown>>
}
const getDatabase = vi.hoisted(() => vi.fn((): ModuleDatabaseFixture => ({ modules: [] })))
const dispatchReplaceCharacterLorebooks = vi.hoisted(() => vi.fn())
const dispatchReplaceCharacterScripts = vi.hoisted(() => vi.fn())
const dispatchReplaceCharacterTriggers = vi.hoisted(() => vi.fn())
const currentLorebookCollectionScopedSnapshot = vi.hoisted(() => vi.fn())
const ensureClientLorebookEntryIds = vi.hoisted(() => vi.fn((entries: unknown) => entries))
const isCharacterLorebookHydrated = vi.hoisted(() => vi.fn(() => true))
const restoreLorebookState = vi.hoisted(() => vi.fn())
const rollbackCharacterLorebookReplacement = vi.hoisted(() => vi.fn())
const ensureClientScriptDefinitionIds = vi.hoisted(() => vi.fn((scripts: unknown) => scripts))
const ensureClientTriggerDefinitionIds = vi.hoisted(() => vi.fn((triggers: unknown) => triggers))
const restoreScriptDefinitionState = vi.hoisted(() => vi.fn())
const rollbackScopedScriptDefinitionReplacement = vi.hoisted(() => vi.fn())
const beginCharacterScriptDefinitionStructuralWrite = vi.hoisted(() =>
  vi.fn((kind: string, characterId: string) => ({ key: `${kind}:${characterId}` })),
)
const acknowledgeCharacterScriptDefinitionStructuralWrite = vi.hoisted(() => vi.fn())
const rejectCharacterScriptDefinitionStructuralWrite = vi.hoisted(() => vi.fn())
const replaceCharacterLorebooksCommand = vi.hoisted(() => vi.fn(async () => ({ status: 'ok', revision: 1, data: {} })))
const replaceCharacterScriptsCommand = vi.hoisted(() => vi.fn(async () => ({ status: 'ok', revision: 2, data: {} })))
const replaceCharacterTriggersCommand = vi.hoisted(() => vi.fn(async () => ({ status: 'ok', revision: 3, data: {} })))
const dispatchCharacterOwnedDurableBatch = vi.hoisted(() => vi.fn())
const characterRowEpochState = vi.hoisted(() => ({ epoch: 0 }))
const characterLorebookEpochState = vi.hoisted(() => ({ epoch: 0 }))
const moduleCollectionEpochState = vi.hoisted(() => ({ epoch: 0 }))
const ensureCharacterLorebookHydrated = vi.hoisted(() => vi.fn(async () => true))
const testDatabaseState: { db: Record<string, any> } = {
  db: { modules: [], characters: [] },
}

vi.mock('../platform', () => ({
  isFastifyServer: true,
}))

vi.mock('../alert', () => ({
  alertClear: vi.fn(),
  alertConfirm,
  alertError,
  alertModuleSelect,
  alertNormal,
  alertStore: { set: vi.fn() },
  alertWait,
}))

vi.mock('../storage/database.svelte', () => ({
  getCurrentCharacter,
  getCurrentChat: getCurrentChatMock,
  getDatabase,
  setCurrentCharacter: vi.fn(),
  setDatabase: vi.fn(),
}))

vi.mock('../server/resourceState.svelte', () => ({
  captureCollectionProjectionEpoch: (name: string) => (name === 'modules' ? moduleCollectionEpochState.epoch : 0),
  captureCharacterLorebookProjectionEpoch: () => characterLorebookEpochState.epoch,
  captureCharacterRowProjectionEpoch: () => characterRowEpochState.epoch,
  hasCharacterLorebookProjectionEpochChanged: (_characterId: string, epoch: number) =>
    characterLorebookEpochState.epoch !== epoch,
  hasCharacterRowProjectionEpochChanged: (_characterId: string, epoch: number) =>
    characterRowEpochState.epoch !== epoch,
  getCharacterResourceOwner: (characterId: string) =>
    (getDatabase().characters ?? []).find((candidate: any) => candidate?.chaId === characterId),
}))

vi.mock('../activeChatGenerationSettings', () => ({
  readActiveModuleDatabase: () => getDatabase(),
  resolveActiveChatGenerationSettings: () => {
    const db = getDatabase()
    const character = getCurrentCharacter()
    return {
      db,
      character,
      chat: getCurrentChatMock() ?? character?.chats?.[character.chatPage],
    }
  },
}))

vi.mock('./moduleReadDatabase.svelte', async () => {
  const { resolveActiveModuleStates } = await import('../moduleActivation')
  return {
    getModuleReadDatabase: () => getDatabase(),
    getActiveModuleReadModules: () =>
      resolveActiveModuleStates(
        getDatabase() as never,
        getCurrentCharacter(),
        getCurrentChatMock() ?? getCurrentCharacter()?.chats?.[getCurrentCharacter()?.chatPage],
      ).map((state) => state.module),
  }
})

vi.mock('../globalApi.svelte', () => ({
  AppendableBuffer: class {
    buffer = new Uint8Array()
    append = vi.fn()
  },
  downloadFile: vi.fn(),
  forageStorage: {},
  readImage: vi.fn(),
  saveAsset,
  saveAssets,
}))

vi.mock('../util', () => ({
  sleep,
}))

vi.mock('../filePicker', () => ({
  selectSingleFile: vi.fn(async () => selectedFileState.file),
  selectFileByDom: vi.fn(async () => (selectedFileState.file ? [selectedFileState.file] : null)),
}))

vi.mock('../server/localFileImport', () => ({ importLocalModuleFileFromServer }))

vi.mock('./lorebook.svelte', () => ({
  convertExternalLorebook: vi.fn(() => []),
}))

vi.mock('../media', () => ({
  compressImage: vi.fn(async (data: Uint8Array) => data),
}))

vi.mock('../rpack/rpack_js', () => ({
  decodeRPack,
  encodeRPack: vi.fn(async (data: Uint8Array) => data),
}))

vi.mock('../stores.svelte', () => ({
  HideIconStore: { set: vi.fn() },
  moduleBackgroundEmbedding: { set: vi.fn() },
  ReloadGUIPointer: { set: vi.fn() },
  reloadGuiAfterDefinitionChange: vi.fn(),
}))

vi.mock('../moduleCommands', () => ({
  createGlobalModule,
}))

vi.mock('../server/lorebookOwner.svelte', () => ({
  currentLorebookStateSnapshot: vi.fn(() => ({ loreBook: [], characters: [], modules: [] })),
  currentLorebookCollectionScopedSnapshot,
  dispatchReplaceCharacterLorebooks,
  ensureClientLorebookEntryIds,
  isCharacterLorebookHydrated,
  restoreLorebookState,
  rollbackCharacterLorebookReplacement,
}))

vi.mock('../server/scriptDefinitionOwner.svelte', () => ({
  acknowledgeCharacterScriptDefinitionStructuralWrite,
  beginCharacterScriptDefinitionStructuralWrite,
  currentScriptDefinitionStateSnapshot: vi.fn(() => ({ characters: [], modules: [] })),
  dispatchReplaceCharacterScripts,
  dispatchReplaceCharacterTriggers,
  ensureClientScriptDefinitionIds,
  ensureClientTriggerDefinitionIds,
  rejectCharacterScriptDefinitionStructuralWrite,
  restoreScriptDefinitionState,
  rollbackScopedScriptDefinitionReplacement,
}))

vi.mock('../chatCommands', () => ({
  dispatchCharacterOwnedDurableBatch,
}))

vi.mock('../server/pendingMutationOutbox', () => ({
  pendingMutationCharacterLorebooksProjectionTarget: (characterId: string) => `character-lorebooks:${characterId}`,
  pendingMutationCharacterScriptsProjectionTarget: (characterId: string) => `character-scripts:${characterId}`,
  pendingMutationCharacterTriggersProjectionTarget: (characterId: string) => `character-triggers:${characterId}`,
}))

vi.mock('../server/chatMessageHydration.svelte', () => ({
  ensureCharacterLorebookHydrated,
}))

vi.mock('../server/commands', () => ({
  replaceCharacterLorebooksCommand,
  replaceCharacterScriptsCommand,
  replaceCharacterTriggersCommand,
}))

import {
  applyModule,
  getModuleAssets,
  getModuleRegexScripts,
  getModuleTriggerOwner,
  getModuleTriggers,
  importModule,
  importRisuModuleData,
  importRisuModuleObject,
  moduleUpdate,
  moduleForSingleItemExport,
  refreshModules,
} from './modules'
import { moduleBackgroundEmbedding, reloadGuiAfterDefinitionChange } from '../stores.svelte'
import type { Chat, character, customscript, loreBook, triggerscript } from '../storage/database.svelte'
import { language } from 'src/lang'

type TestModuleApplyStep = {
  method: 'PUT'
  path: string
  body: Record<string, unknown>
  projectionTargets?: string[]
  command: (
    baseRevision: number,
    body: Readonly<Record<string, unknown>>,
  ) => Promise<{ status: string; revision?: number; error?: string; reason?: string }>
  rollback: () => void
  reapply?: (isProjectionTargetCurrent: (target: string) => boolean) => void
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function buildRisum(module: Record<string, unknown>, assets: readonly Uint8Array[] = []): Uint8Array {
  const main = Buffer.from(
    JSON.stringify({
      type: 'risuModule',
      module,
    }),
  )
  const header = Buffer.alloc(6)
  header.writeUInt8(111, 0)
  header.writeUInt8(0, 1)
  header.writeUInt32LE(main.length, 2)
  const chunks = [header, main]
  for (const asset of assets) {
    const assetLength = Buffer.alloc(4)
    assetLength.writeUInt32LE(asset.length, 0)
    chunks.push(Buffer.from([1]), assetLength, Buffer.from(asset))
  }
  chunks.push(Buffer.from([0]))
  return Buffer.concat(chunks)
}

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function snapshotJson(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

function characterById(characterId: string): Record<string, unknown> | undefined {
  return (testDatabaseState.db.characters as unknown as Array<Record<string, unknown>> | undefined)?.find(
    (candidate) => candidate.chaId === characterId,
  )
}

function installAttemptAwareRollbackMocks(): void {
  currentLorebookCollectionScopedSnapshot.mockImplementation(({ characterId }: { characterId: string }) => {
    const character = characterById(characterId)
    return {
      scopeKey: `character:${characterId}`,
      scopedValue: cloneJsonValue((character?.globalLore as unknown[]) ?? []),
      loreBook: cloneJsonValue(testDatabaseState.db.loreBook ?? []),
      loreBookPage: testDatabaseState.db.loreBookPage ?? 0,
      characters: cloneJsonValue(testDatabaseState.db.characters ?? []),
      modules: cloneJsonValue(testDatabaseState.db.modules ?? []),
      selectedCharID: 0,
    }
  })
  rollbackCharacterLorebookReplacement.mockImplementation(
    (characterId: string, snapshot: { scopedValue?: unknown }, attemptedEntries: unknown[]) => {
      const character = characterById(characterId)
      if (!character || snapshotJson(character.globalLore ?? []) !== snapshotJson(attemptedEntries)) return
      character.globalLore = cloneJsonValue(snapshot.scopedValue ?? [])
    },
  )
  rollbackScopedScriptDefinitionReplacement.mockImplementation(
    (
      rollback:
        | {
            kind: 'characterScripts'
            characterId: string
            scripts: unknown[]
            hadScriptsField?: boolean
          }
        | {
            kind: 'characterTriggers'
            characterId: string
            triggers: unknown[]
            hadTriggersField?: boolean
          },
      attempted:
        | { kind: 'characterScripts'; characterId: string; scripts: unknown[] }
        | { kind: 'characterTriggers'; characterId: string; triggers: unknown[] },
    ) => {
      const character = characterById(rollback.characterId)
      if (!character || rollback.kind !== attempted.kind || rollback.characterId !== attempted.characterId) return
      if (rollback.kind === 'characterScripts') {
        if (attempted.kind !== 'characterScripts') return
        if (snapshotJson(character.customscript) !== snapshotJson(attempted.scripts)) return
        if (rollback.hadScriptsField === false) {
          delete character.customscript
        } else {
          character.customscript = cloneJsonValue(rollback.scripts)
        }
        return
      }
      if (attempted.kind !== 'characterTriggers') return
      if (snapshotJson(character.triggerscript) !== snapshotJson(attempted.triggers)) return
      if (rollback.hadTriggersField === false) {
        delete character.triggerscript
      } else {
        character.triggerscript = cloneJsonValue(rollback.triggers)
      }
    },
  )
}

function installCompleteModuleApplyFixture(): character {
  alertModuleSelect.mockResolvedValue('mod-a')
  const currentCharacter = {
    chaId: 'char-a',
    globalLore: [{ comment: 'Existing lore', content: 'old' }],
    customscript: [{ comment: 'Existing regex', in: 'old', out: 'old' }],
    triggerscript: [{ comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] }],
  } as unknown as character
  testDatabaseState.db.characters = [currentCharacter]
  getCurrentCharacter.mockReturnValue(currentCharacter)
  getDatabase.mockReturnValue({
    characters: [currentCharacter],
    modules: [
      {
        id: 'mod-a',
        name: 'Module A',
        description: '',
        lorebook: [{ comment: 'Module lore', content: 'lore' }],
        regex: [{ comment: 'Module regex', in: 'in', out: 'out' }],
        trigger: [{ comment: 'Module trigger', type: 'manual', conditions: [], effect: [] }],
      },
    ],
  })
  return currentCharacter
}

describe('module imports', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    characterRowEpochState.epoch = 0
    characterLorebookEpochState.epoch = 0
    moduleCollectionEpochState.epoch = 0
    ensureCharacterLorebookHydrated.mockReset()
    ensureCharacterLorebookHydrated.mockResolvedValue(true)
    selectedFileState.file = null
    testDatabaseState.db = { modules: [], characters: [] }
    alertError.mockClear()
    alertWait.mockClear()
    saveAsset.mockClear()
    saveAssets.mockReset()
    saveAssets.mockImplementation(async (assets: readonly unknown[]) => assets.map((_, index) => `asset-${index}`))
    decodeRPack.mockReset()
    decodeRPack.mockImplementation(async (data: Uint8Array) => data)
    sleep.mockReset()
    createGlobalModule.mockReset()
    createGlobalModule.mockResolvedValue(null)
    importLocalModuleFileFromServer.mockReset()
    importLocalModuleFileFromServer.mockResolvedValue({
      status: 'ok',
      revision: 10,
      event: { type: 'module.created', resource: 'moduleCreated', revision: 10 },
      moduleId: 'server-module',
    })
    alertConfirm.mockReset()
    alertConfirm.mockResolvedValue(true)
    alertModuleSelect.mockReset()
    alertNormal.mockClear()
    getCurrentCharacter.mockReset()
    getCurrentChatMock.mockReset()
    getDatabase.mockReset()
    getDatabase.mockReturnValue({ modules: [] })
    dispatchCharacterOwnedDurableBatch.mockReset()
    dispatchCharacterOwnedDurableBatch.mockImplementation(
      async (_characterId: string, steps: TestModuleApplyStep[]) => {
        let revision = 10
        let acceptedCount = 0
        for (let index = 0; index < steps.length; index += 1) {
          const result = await steps[index].command(revision, steps[index].body)
          if (result.status !== 'ok') {
            for (let rollbackIndex = steps.length - 1; rollbackIndex >= index; rollbackIndex -= 1) {
              steps[rollbackIndex].rollback()
            }
            return { status: 'failure', acceptedCount, failure: result }
          }
          revision = result.revision ?? revision
          acceptedCount += 1
        }
        return { status: 'ok', acceptedCount }
      },
    )
    replaceCharacterLorebooksCommand.mockReset()
    replaceCharacterLorebooksCommand.mockResolvedValue({ status: 'ok', revision: 1, data: {} })
    replaceCharacterScriptsCommand.mockReset()
    replaceCharacterScriptsCommand.mockResolvedValue({ status: 'ok', revision: 2, data: {} })
    replaceCharacterTriggersCommand.mockReset()
    replaceCharacterTriggersCommand.mockResolvedValue({ status: 'ok', revision: 3, data: {} })
    currentLorebookCollectionScopedSnapshot.mockReset()
    ensureClientLorebookEntryIds.mockReset()
    ensureClientLorebookEntryIds.mockImplementation((entries: unknown) => entries)
    isCharacterLorebookHydrated.mockReset()
    isCharacterLorebookHydrated.mockReturnValue(true)
    rollbackCharacterLorebookReplacement.mockReset()
    ensureClientScriptDefinitionIds.mockReset()
    ensureClientScriptDefinitionIds.mockImplementation((scripts: unknown) => scripts)
    ensureClientTriggerDefinitionIds.mockReset()
    ensureClientTriggerDefinitionIds.mockImplementation((triggers: unknown) => triggers)
    rollbackScopedScriptDefinitionReplacement.mockReset()
    beginCharacterScriptDefinitionStructuralWrite.mockReset()
    beginCharacterScriptDefinitionStructuralWrite.mockImplementation((kind: string, characterId: string) => ({
      key: `${kind}:${characterId}`,
    }))
    acknowledgeCharacterScriptDefinitionStructuralWrite.mockReset()
    rejectCharacterScriptDefinitionStructuralWrite.mockReset()
    installAttemptAwareRollbackMocks()
    vi.mocked(moduleBackgroundEmbedding.set).mockClear()
    vi.mocked(reloadGuiAfterDefinitionChange).mockClear()
    dispatchReplaceCharacterLorebooks.mockClear()
    dispatchReplaceCharacterScripts.mockClear()
    dispatchReplaceCharacterTriggers.mockClear()
    refreshModules()
  })

  it('keeps script model profile ids local to the installation', async () => {
    const module = {
      id: 'module-local-models',
      name: 'Local models',
      description: '',
      scriptModelOverrides: {
        llmProfileId: 'local-main',
        axLlmProfileId: 'local-aux',
      },
    }

    const organizedModule = { ...module, folderId: 'local-folder' }
    expect(moduleForSingleItemExport(organizedModule)).not.toHaveProperty('scriptModelOverrides')
    expect(moduleForSingleItemExport(organizedModule)).not.toHaveProperty('folderId')
    expect(module).toHaveProperty('scriptModelOverrides.llmProfileId', 'local-main')

    await importRisuModuleObject(module)
    expect(createGlobalModule).toHaveBeenCalledWith(
      expect.not.objectContaining({ scriptModelOverrides: expect.anything() }),
    )
  })

  it('uploads an ordinary .risum once and lets the server process and create it', async () => {
    const assetData = new Uint8Array([7, 8, 9])
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Imported module',
          description: 'Imported',
          assets: [['portrait', '', 'portrait.webp']],
        },
        [assetData],
      ),
    }

    await importModule()

    expect(importLocalModuleFileFromServer).toHaveBeenCalledWith(
      expect.objectContaining({ file: selectedFileState.file, fileName: 'module.risum' }),
    )
    expect(saveAssets).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(alertNormal).toHaveBeenCalled()
  })

  it('reports each module asset only after its upload completes', async () => {
    const assets = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
    const save = createDeferred<string[]>()
    saveAssets.mockReturnValueOnce(save.promise)
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Imported module',
          description: 'Imported',
          assets: assets.map((_, index) => [`asset-${index}`, '', `asset-${index}.png`]),
        },
        assets,
      ),
    }

    const importPromise = importRisuModuleData(selectedFileState.file.data)
    await vi.waitFor(() => expect(saveAssets).toHaveBeenCalledOnce())

    expect(alertWait.mock.calls.map(([message]) => message)).toEqual(['Loading... (Adding Assets 0 / 3)'])
    expect(createGlobalModule).not.toHaveBeenCalled()

    const progress = saveAssets.mock.calls[0][1].onProgress
    progress(1, 3)
    progress(2, 3)
    progress(3, 3)

    expect(alertWait.mock.calls.map(([message]) => message)).toEqual([
      'Loading... (Adding Assets 0 / 3)',
      'Loading... (Adding Assets 1 / 3)',
      'Loading... (Adding Assets 2 / 3)',
      'Loading... (Adding Assets 3 / 3)',
    ])
    expect(createGlobalModule).not.toHaveBeenCalled()

    save.resolve(['asset-0', 'asset-1', 'asset-2'])
    await importPromise

    expect(alertWait.mock.calls.map(([message]) => message)).toEqual([
      'Loading... (Adding Assets 0 / 3)',
      'Loading... (Adding Assets 1 / 3)',
      'Loading... (Adding Assets 2 / 3)',
      'Loading... (Adding Assets 3 / 3)',
    ])
  })

  it('does not announce .risum import success when module creation fails', async () => {
    const save = createDeferred<any>()
    createGlobalModule.mockReturnValueOnce(save.promise)
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum({
        id: 'old-id',
        name: 'Rejected module',
        description: 'Imported',
      }),
    }

    const importPromise = importRisuModuleData(selectedFileState.file.data)
    await vi.waitFor(() => expect(createGlobalModule).toHaveBeenCalledOnce())
    expect(alertNormal).not.toHaveBeenCalled()

    save.resolve({ status: 'error', error: 'module write failed' })
    await importPromise

    expect(alertNormal).not.toHaveBeenCalled()
    expect(alertError).toHaveBeenCalledWith(language.moduleImport.commandError('module write failed'))
  })

  it('returns no imported module or success alert after an object-import conflict', async () => {
    createGlobalModule.mockResolvedValueOnce({ status: 'conflict', currentRevision: 41 })

    const imported = await importRisuModuleObject(
      {
        id: 'old-id',
        name: 'Conflicted module',
        description: 'Imported',
      },
      { alertSuccess: true },
    )

    expect(imported).toBeUndefined()
    expect(alertNormal).not.toHaveBeenCalled()
    expect(alertError).toHaveBeenCalledWith(language.moduleImport.commandConflict)
  })

  it.each([
    [
      'Risu lorebook',
      {
        type: 'risu',
        name: 'Lorebook module',
        data: [],
      },
    ],
    [
      'external lorebook',
      {
        name: 'External lorebook module',
        entries: { first: { content: 'Lore' } },
      },
    ],
    [
      'regex',
      {
        type: 'regex',
        name: 'Regex module',
        data: [{ in: 'x', out: 'y', type: 'editoutput' }],
      },
    ],
  ])('reports unavailable creation for converted %s imports', async (_kind, payload) => {
    importLocalModuleFileFromServer.mockResolvedValueOnce({ status: 'unavailable' })
    selectedFileState.file = {
      name: 'converted.json',
      data: Buffer.from(JSON.stringify(payload)),
    }

    await importModule()

    expect(importLocalModuleFileFromServer).toHaveBeenCalledOnce()
    expect(alertError).toHaveBeenCalledWith(language.moduleImport.commandUnavailable)
  })

  it('does not upload decoded module assets after writer loss and re-promotion', async () => {
    setManagedWriterForTest()
    let release!: (data: Uint8Array) => void
    decodeRPack
      .mockImplementationOnce(async (data) => data)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
    const pending = importRisuModuleData(
      buildRisum({ id: 'old', name: 'Held decode', assets: [['one', '', 'one.png']] }, [new Uint8Array([1])]),
    )
    await vi.waitFor(() => expect(decodeRPack).toHaveBeenCalledTimes(2))
    demoteAndRepromoteForTest()
    release(new Uint8Array([1]))
    await expect(pending).resolves.toBeUndefined()
    expect(saveAssets).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(alertError).not.toHaveBeenCalled()
  })

  it('does not retry a failed module asset batch after its delay crosses re-promotion', async () => {
    setManagedWriterForTest()
    let release!: () => void
    saveAssets.mockRejectedValueOnce(new Error('temporary upload failure'))
    sleep.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const pending = importRisuModuleData(
      buildRisum({ id: 'old', name: 'Held retry', assets: [['one', '', 'one.png']] }, [new Uint8Array([1])]),
    )
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release()
    await expect(pending).resolves.toBeUndefined()
    expect(saveAssets).toHaveBeenCalledOnce()
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(alertError).not.toHaveBeenCalled()
  })

  it('does not create a module after low-level confirmation resumes under a new writer', async () => {
    setManagedWriterForTest()
    let release!: (accepted: boolean) => void
    alertConfirm.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = importRisuModuleObject({ id: 'old', name: 'Held confirmation', lowLevelAccess: true } as never)
    await vi.waitFor(() => expect(alertConfirm).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(true)
    await expect(pending).resolves.toBe(false)
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(alertNormal).not.toHaveBeenCalled()
  })

  it('denies Reader module import entry points before decode or creation', async () => {
    setManagedReaderForTest()
    await importRisuModuleData(buildRisum({ id: 'old', name: 'Reader module' }))
    await importRisuModuleObject({ id: 'old', name: 'Reader module' } as never)
    await importModule()
    expect(decodeRPack).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(importLocalModuleFileFromServer).not.toHaveBeenCalled()
  })

  it('imports .risum asset tuples with a null filename slot using empty filename fallback', async () => {
    const assetData = new Uint8Array([1, 2, 3])
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Imported module',
          description: 'Imported',
          assets: [['portrait', '', null]],
        },
        [assetData],
      ),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(saveAssets).toHaveBeenCalledWith([{ data: Buffer.from(assetData), fileName: '' }], {
      onProgress: expect.any(Function),
    })
    expect(createGlobalModule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Imported module',
        assets: [['portrait', 'asset-0', '']],
      }),
    )
  })

  it('infers upload extension for legacy .risum asset filename tokens', async () => {
    const avifData = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00, 0x00,
    ])
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Imported module',
          description: 'Imported',
          assets: [['portrait', '', '1']],
        },
        [avifData],
      ),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(saveAssets).toHaveBeenCalledWith([{ data: Buffer.from(avifData), fileName: 'asset.avif' }], {
      onProgress: expect.any(Function),
    })
    expect(createGlobalModule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Imported module',
        assets: [['portrait', 'asset-0', '1']],
      }),
    )
  })

  it('cancels low-level .risum import before asset upload or module creation', async () => {
    alertConfirm.mockResolvedValue(false)
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Low level module',
          description: 'Imported',
          lowLevelAccess: true,
          assets: [['portrait', '', 'portrait.webp']],
        },
        [new Uint8Array([7, 8, 9])],
      ),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(alertConfirm).toHaveBeenCalled()
    expect(saveAssets).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(alertNormal).not.toHaveBeenCalled()
  })

  it('imports a validated MCP .risum module through the durable module flow', async () => {
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'MCP module',
          description: 'Imported',
          lowLevelAccess: true,
          mcp: { url: 'https://example.test/mcp' },
          assets: [['portrait', '', 'portrait.webp']],
        },
        [new Uint8Array([7, 8, 9])],
      ),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(alertError).not.toHaveBeenCalled()
    expect(alertConfirm).toHaveBeenCalled()
    expect(saveAssets).toHaveBeenCalledWith(
      [{ data: Buffer.from(new Uint8Array([7, 8, 9])), fileName: 'portrait.webp' }],
      { onProgress: expect.any(Function) },
    )
    expect(createGlobalModule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'MCP module',
        mcp: { url: 'https://example.test/mcp' },
        assets: [['portrait', 'asset-0', 'portrait.webp']],
      }),
    )
  })

  it('rejects invalid MCP metadata before confirmation, asset upload, or module creation', async () => {
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Invalid MCP module',
          description: 'Imported',
          lowLevelAccess: true,
          mcp: { url: 'http://public.example/mcp' },
          assets: [['portrait', '', 'portrait.webp']],
        },
        [new Uint8Array([7, 8, 9])],
      ),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(alertError).toHaveBeenCalledWith(language.moduleImport.mcpInvalidUrl)
    expect(alertConfirm).not.toHaveBeenCalled()
    expect(saveAssets).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
  })

  it('reports no-data for invalid .risum files without asset upload or module creation', async () => {
    selectedFileState.file = {
      name: 'module.risum',
      data: new Uint8Array([111, 0, 0, 0]),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(alertError).toHaveBeenCalledWith(language.errors.noData)
    expect(saveAssets).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
  })

  it('fails corrupt asset decoding immediately without retry delays', async () => {
    decodeRPack
      .mockImplementationOnce(async (data: Uint8Array) => data)
      .mockRejectedValueOnce(new Error('corrupt asset payload'))
    selectedFileState.file = {
      name: 'module.risum',
      data: buildRisum(
        {
          id: 'old-id',
          name: 'Corrupt module',
          description: 'Imported',
          assets: [['portrait', '', 'portrait.webp']],
        },
        [new Uint8Array([7, 8, 9])],
      ),
    }

    await importRisuModuleData(selectedFileState.file.data)

    expect(decodeRPack).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
    expect(saveAssets).not.toHaveBeenCalled()
    expect(createGlobalModule).not.toHaveBeenCalled()
    expect(alertError).toHaveBeenCalledWith(language.errors.noData)
  })

  it('routes JSON module imports through the global module command helper', async () => {
    selectedFileState.file = {
      name: 'module.json',
      data: Buffer.from(
        JSON.stringify({
          type: 'risuModule',
          id: 'old-id',
          name: 'Imported module',
          description: 'Imported',
        }),
      ),
    }

    await importRisuModuleObject(JSON.parse(Buffer.from(selectedFileState.file.data).toString()))

    expect(createGlobalModule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        name: 'Imported module',
        description: 'Imported',
      }),
    )
  })

  it('pre-stages exact idempotent character snapshots and awaits all three replacements', async () => {
    installCompleteModuleApplyFixture()

    await applyModule()

    expect(dispatchCharacterOwnedDurableBatch).toHaveBeenCalledTimes(1)
    const [characterId, steps] = dispatchCharacterOwnedDurableBatch.mock.calls[0] as [string, TestModuleApplyStep[]]
    expect(characterId).toBe('char-a')
    expect(
      steps.map(({ method, path, body, projectionTargets }) => ({ method, path, body, projectionTargets })),
    ).toEqual([
      {
        method: 'PUT',
        path: '/characters/char-a/lorebooks',
        body: {
          entries: [
            { comment: 'Existing lore', content: 'old' },
            { comment: 'Module lore', content: 'lore' },
          ],
        },
        projectionTargets: ['character-lorebooks:char-a'],
      },
      {
        method: 'PUT',
        path: '/characters/char-a/scripts',
        body: {
          scripts: [
            { comment: 'Existing regex', in: 'old', out: 'old' },
            { comment: 'Module regex', in: 'in', out: 'out' },
          ],
        },
        projectionTargets: ['character-scripts:char-a'],
      },
      {
        method: 'PUT',
        path: '/characters/char-a/triggers',
        body: {
          triggers: [
            { comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] },
            { comment: 'Module trigger', type: 'manual', conditions: [], effect: [] },
          ],
        },
        projectionTargets: ['character-triggers:char-a'],
      },
    ])
    expect(replaceCharacterLorebooksCommand).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: 10, characterId: 'char-a' }),
    )
    expect(replaceCharacterScriptsCommand).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: 1, characterId: 'char-a' }),
      undefined,
      false,
      true,
    )
    expect(replaceCharacterTriggersCommand).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: 2, characterId: 'char-a' }),
      undefined,
      false,
      true,
    )
    expect(acknowledgeCharacterScriptDefinitionStructuralWrite).toHaveBeenCalledTimes(2)
    expect(rejectCharacterScriptDefinitionStructuralWrite).not.toHaveBeenCalled()
    expect(alertNormal).toHaveBeenCalledWith(language.successApplyModule)
    expect(alertError).not.toHaveBeenCalled()
  })

  it('repairs only cloned module-application rows before projecting the canonical character', async () => {
    const currentCharacter = installCompleteModuleApplyFixture()
    const before = {
      globalLore: snapshotJson(currentCharacter.globalLore),
      customscript: snapshotJson(currentCharacter.customscript),
      triggerscript: snapshotJson(currentCharacter.triggerscript),
    }
    const assignMissingIds = (prefix: string) => (entries: unknown) => {
      for (const [index, entry] of (entries as Array<Record<string, unknown>>).entries()) {
        if (!entry.id) entry.id = `${prefix}-${index}`
      }
      return entries
    }
    ensureClientLorebookEntryIds.mockImplementation(assignMissingIds('lore'))
    ensureClientScriptDefinitionIds.mockImplementation(assignMissingIds('script'))
    ensureClientTriggerDefinitionIds.mockImplementation(assignMissingIds('trigger'))

    let canonicalBeforeProjection: typeof before | undefined
    dispatchCharacterOwnedDurableBatch.mockImplementationOnce(
      async (_characterId: string, steps: TestModuleApplyStep[]) => {
        canonicalBeforeProjection = {
          globalLore: snapshotJson(currentCharacter.globalLore),
          customscript: snapshotJson(currentCharacter.customscript),
          triggerscript: snapshotJson(currentCharacter.triggerscript),
        }
        expect(steps.map((step) => step.body)).toEqual([
          {
            entries: [
              { id: 'lore-0', comment: 'Existing lore', content: 'old' },
              { id: 'lore-1', comment: 'Module lore', content: 'lore' },
            ],
          },
          {
            scripts: [
              { id: 'script-0', comment: 'Existing regex', in: 'old', out: 'old' },
              { id: 'script-1', comment: 'Module regex', in: 'in', out: 'out' },
            ],
          },
          {
            triggers: [
              { id: 'trigger-0', comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] },
              { id: 'trigger-1', comment: 'Module trigger', type: 'manual', conditions: [], effect: [] },
            ],
          },
        ])
        expect(steps[0].body.entries[0]).not.toBe(currentCharacter.globalLore?.[0])
        expect(steps[1].body.scripts[0]).not.toBe(currentCharacter.customscript?.[0])
        expect(steps[2].body.triggers[0]).not.toBe(currentCharacter.triggerscript?.[0])
        return { status: 'ok', acceptedCount: steps.length }
      },
    )

    await applyModule()

    expect(canonicalBeforeProjection).toEqual(before)
  })

  it('projects only after staging and does not announce success before durable settlement', async () => {
    const currentCharacter = installCompleteModuleApplyFixture()
    const settlement = createDeferred<{ status: 'ok'; acceptedCount: number }>()
    dispatchCharacterOwnedDurableBatch.mockImplementationOnce((_characterId: string, steps: TestModuleApplyStep[]) => {
      expect(currentCharacter.globalLore).toEqual([{ comment: 'Existing lore', content: 'old' }])
      expect(currentCharacter.customscript).toEqual([{ comment: 'Existing regex', in: 'old', out: 'old' }])
      expect(steps).toHaveLength(3)
      return settlement.promise
    })

    const applying = applyModule()
    await vi.waitFor(() => expect(dispatchCharacterOwnedDurableBatch).toHaveBeenCalledTimes(1))
    await applyModule()

    expect(currentCharacter.globalLore).toHaveLength(2)
    expect(currentCharacter.customscript).toHaveLength(2)
    expect(currentCharacter.triggerscript).toHaveLength(2)
    expect(alertModuleSelect).toHaveBeenCalledTimes(1)
    expect(dispatchCharacterOwnedDurableBatch).toHaveBeenCalledTimes(1)
    expect(alertNormal).not.toHaveBeenCalled()
    expect(alertError).not.toHaveBeenCalled()

    settlement.resolve({ status: 'ok', acceptedCount: 3 })
    await applying
    expect(alertNormal).toHaveBeenCalledWith(language.successApplyModule)
  })

  it('does not stage replacement commands for empty module collections', async () => {
    alertModuleSelect.mockResolvedValue('mod-empty')
    const currentCharacter = {
      chaId: 'char-a',
      globalLore: [{ comment: 'Existing lore', content: 'old' }],
      customscript: [{ comment: 'Existing regex', in: 'old', out: 'old' }],
      triggerscript: [{ comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] }],
    } as unknown as character
    testDatabaseState.db.characters = [currentCharacter]
    getCurrentCharacter.mockReturnValue(currentCharacter)
    getDatabase.mockReturnValue({
      characters: [currentCharacter],
      modules: [{ id: 'mod-empty', name: 'Empty module', description: '', lorebook: [], regex: [], trigger: [] }],
    })

    await applyModule()

    expect(dispatchCharacterOwnedDurableBatch).not.toHaveBeenCalled()
    expect(beginCharacterScriptDefinitionStructuralWrite).not.toHaveBeenCalled()
    expect(replaceCharacterLorebooksCommand).not.toHaveBeenCalled()
    expect(replaceCharacterScriptsCommand).not.toHaveBeenCalled()
    expect(replaceCharacterTriggersCommand).not.toHaveBeenCalled()
    expect(alertNormal).toHaveBeenCalledWith(language.successApplyModule)
  })

  it('fails closed instead of reporting success when a stubbed character lorebook cannot hydrate', async () => {
    const currentCharacter = installCompleteModuleApplyFixture()
    const database = getDatabase()
    database.enableLorebookStubs = true
    isCharacterLorebookHydrated.mockReturnValue(false)
    ensureCharacterLorebookHydrated.mockResolvedValueOnce(false)

    await applyModule()

    expect(ensureCharacterLorebookHydrated).toHaveBeenCalledWith('char-a')
    expect(dispatchCharacterOwnedDurableBatch).not.toHaveBeenCalled()
    expect(currentCharacter.globalLore).toEqual([{ comment: 'Existing lore', content: 'old' }])
    expect(alertNormal).not.toHaveBeenCalled()
    expect(alertError).toHaveBeenCalledWith(language.lorebookDataLoadFailed)
  })

  it('hydrates a stubbed stable character before building the durable lorebook snapshot', async () => {
    const originalCharacter = installCompleteModuleApplyFixture()
    const database = getDatabase()
    database.enableLorebookStubs = true
    isCharacterLorebookHydrated.mockReturnValue(false)
    const hydratedCharacter = {
      ...originalCharacter,
      globalLore: [{ comment: 'Server lore', content: 'hydrated' }],
    } as character
    ensureCharacterLorebookHydrated.mockImplementationOnce(async () => {
      database.characters = [hydratedCharacter]
      return true
    })

    await applyModule()

    const [, steps] = dispatchCharacterOwnedDurableBatch.mock.calls[0] as [string, TestModuleApplyStep[]]
    expect(steps[0].body).toEqual({
      entries: [
        { comment: 'Server lore', content: 'hydrated' },
        { comment: 'Module lore', content: 'lore' },
      ],
    })
    expect(hydratedCharacter.globalLore).toEqual(steps[0].body.entries)
    expect(originalCharacter.globalLore).toEqual([{ comment: 'Existing lore', content: 'old' }])
    expect(alertNormal).toHaveBeenCalledWith(language.successApplyModule)
  })

  it.each([
    ['first', 0],
    ['middle', 1],
    ['tail', 2],
  ] as const)(
    'retains and reasserts the queued suffix after a retryable %s-step failure',
    async (_name, failureIndex) => {
      const currentCharacter = installCompleteModuleApplyFixture()
      dispatchCharacterOwnedDurableBatch.mockImplementationOnce(
        async (_characterId: string, steps: TestModuleApplyStep[]) => {
          await Promise.resolve()
          let revision = 10
          for (let index = 0; index < failureIndex; index += 1) {
            const result = await steps[index].command(revision, steps[index].body)
            revision = result.revision ?? revision
          }

          if (failureIndex === 0) {
            currentCharacter.globalLore = [{ comment: 'Existing lore', content: 'old' }] as loreBook[]
          }
          if (failureIndex <= 1) {
            currentCharacter.customscript = [{ comment: 'Existing regex', in: 'old', out: 'old' }] as customscript[]
          }
          currentCharacter.triggerscript = [
            { comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] },
          ] as triggerscript[]
          for (let index = failureIndex; index < steps.length; index += 1) {
            steps[index].reapply?.(() => true)
          }
          return {
            status: 'retained',
            acceptedCount: failureIndex,
            failure: { status: 'conflict', revision },
          }
        },
      )

      await applyModule()

      expect(currentCharacter.globalLore).toHaveLength(2)
      expect(currentCharacter.customscript).toHaveLength(2)
      expect(currentCharacter.triggerscript).toHaveLength(2)
      expect(rollbackCharacterLorebookReplacement).not.toHaveBeenCalled()
      expect(rollbackScopedScriptDefinitionReplacement).not.toHaveBeenCalled()
      expect(alertNormal).toHaveBeenCalledWith(language.moduleApply.queued)
      expect(alertNormal).not.toHaveBeenCalledWith(language.successApplyModule)
      expect(alertError).not.toHaveBeenCalled()
      expect(new Set(rejectCharacterScriptDefinitionStructuralWrite.mock.calls.map(([handle]) => handle)).size).toBe(
        failureIndex < 2 ? 2 : 1,
      )
    },
  )

  it('keeps an accepted prefix and rolls back only a terminally rejected suffix', async () => {
    const currentCharacter = installCompleteModuleApplyFixture()
    dispatchCharacterOwnedDurableBatch.mockImplementationOnce(
      async (_characterId: string, steps: TestModuleApplyStep[]) => {
        await Promise.resolve()
        await steps[0].command(10, steps[0].body)
        for (let index = steps.length - 1; index >= 1; index -= 1) steps[index].rollback()
        return {
          status: 'failure',
          acceptedCount: 1,
          failure: { status: 'error', error: 'invalid definitions', reason: 'invalid-request' },
        }
      },
    )

    await applyModule()

    expect(currentCharacter.globalLore).toHaveLength(2)
    expect(currentCharacter.customscript).toEqual([{ comment: 'Existing regex', in: 'old', out: 'old' }])
    expect(currentCharacter.triggerscript).toEqual([
      { comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] },
    ])
    expect(rollbackCharacterLorebookReplacement).not.toHaveBeenCalled()
    expect(rollbackScopedScriptDefinitionReplacement.mock.calls.map(([rollback]) => rollback.kind)).toEqual([
      'characterTriggers',
      'characterScripts',
    ])
    expect(alertNormal).not.toHaveBeenCalled()
    expect(alertError).toHaveBeenCalledWith(language.moduleApply.commandError('invalid definitions'))
  })

  it('stores full-snapshot PUTs whose accepted-prefix replay cannot duplicate module definitions', async () => {
    installCompleteModuleApplyFixture()
    let replayedScripts: unknown[] = []
    let replayedTriggers: unknown[] = []
    dispatchCharacterOwnedDurableBatch.mockImplementationOnce(
      async (_characterId: string, steps: TestModuleApplyStep[]) => {
        await Promise.resolve()
        await steps[0].command(10, steps[0].body)
        for (let replay = 0; replay < 2; replay += 1) {
          replayedScripts = cloneJsonValue(steps[1].body.scripts as unknown[])
          replayedTriggers = cloneJsonValue(steps[2].body.triggers as unknown[])
        }
        return {
          status: 'retained',
          acceptedCount: 1,
          failure: { status: 'unavailable' },
        }
      },
    )

    await applyModule()

    expect(replayedScripts.filter((script: any) => script.comment === 'Module regex')).toHaveLength(1)
    expect(replayedTriggers.filter((trigger: any) => trigger.comment === 'Module trigger')).toHaveLength(1)
    const [, steps] = dispatchCharacterOwnedDurableBatch.mock.calls[0] as [string, TestModuleApplyStep[]]
    expect(steps.slice(1).map((step) => step.method)).toEqual(['PUT', 'PUT'])
    expect(steps[1].body).not.toHaveProperty('baseRevision')
    expect(steps[2].body).not.toHaveProperty('baseRevision')
  })

  it('does not reassert retained definitions over a newer edit or newer projection owner', async () => {
    const currentCharacter = installCompleteModuleApplyFixture()
    const newerScripts = [{ comment: 'Newer regex', in: 'newer', out: 'newer', type: 'regex' }] as customscript[]
    const previousTriggers = [
      { comment: 'Existing trigger', type: 'manual', conditions: [], effect: [] },
    ] as triggerscript[]
    dispatchCharacterOwnedDurableBatch.mockImplementationOnce(
      async (_characterId: string, steps: TestModuleApplyStep[]) => {
        await Promise.resolve()
        currentCharacter.customscript = cloneJsonValue(newerScripts)
        currentCharacter.triggerscript = cloneJsonValue(previousTriggers)
        steps[1].reapply?.(() => true)
        steps[2].reapply?.(() => false)
        return {
          status: 'retained',
          acceptedCount: 0,
          failure: { status: 'conflict', revision: 10 },
        }
      },
    )

    await applyModule()

    expect(currentCharacter.customscript).toEqual(newerScripts)
    expect(currentCharacter.triggerscript).toEqual(previousTriggers)
    expect(alertNormal).toHaveBeenCalledWith(language.moduleApply.queued)
  })

  it('does not reassert a retained suffix after a newer character-owner projection', async () => {
    const currentCharacter = installCompleteModuleApplyFixture()
    const previousLorebooks = [{ comment: 'Existing lore', content: 'old' }] as loreBook[]
    dispatchCharacterOwnedDurableBatch.mockImplementationOnce(
      async (_characterId: string, steps: TestModuleApplyStep[]) => {
        await Promise.resolve()
        currentCharacter.globalLore = cloneJsonValue(previousLorebooks)
        characterRowEpochState.epoch += 1
        steps[0].reapply?.(() => true)
        return {
          status: 'retained',
          acceptedCount: 0,
          failure: { status: 'unavailable' },
        }
      },
    )

    await applyModule()

    expect(currentCharacter.globalLore).toEqual(previousLorebooks)
    expect(alertNormal).toHaveBeenCalledWith(language.moduleApply.queued)
  })

  it('refreshes active module triggers when module rows are replaced under the same enabled namespace', () => {
    const db = {
      enabledModules: [],
      moduleIntergration: 'aos-ns',
      modules: [
        {
          id: 'module-a',
          name: 'AOS Module',
          namespace: 'aos-ns',
          trigger: [
            {
              comment: '',
              type: 'start',
              conditions: [],
              effect: [{ type: 'triggerlua', code: 'old triggerlua' }],
            },
          ],
        },
      ],
    }
    getDatabase.mockReturnValue(db)

    expect(getModuleTriggers()[0]?.effect?.[0]).toMatchObject({
      type: 'triggerlua',
      code: 'old triggerlua',
    })

    db.modules = [
      {
        id: 'module-a',
        name: 'AOS Module',
        namespace: 'aos-ns',
        trigger: [
          {
            comment: '',
            type: 'start',
            conditions: [],
            effect: [{ type: 'triggerlua', code: 'new triggerlua with AOS' }],
          },
        ],
      },
    ]

    expect(getModuleTriggers()[0]?.effect?.[0]).toMatchObject({
      type: 'triggerlua',
      code: 'new triggerlua with AOS',
    })
  })

  it('refreshes active modules when a module id or namespace is mutated in place', () => {
    const module = {
      id: 'inactive-id',
      name: 'Mutable Module',
      namespace: 'inactive-space',
      regex: [{ comment: 'mutable regex', in: 'MUTABLE', out: 'mutable', type: 'editdisplay' }],
    }
    const db = {
      enabledModules: ['active-id'],
      moduleIntergration: 'active-space',
      modules: [module],
    }
    getDatabase.mockReturnValue(db)

    expect(getModuleRegexScripts()).toEqual([])

    module.namespace = 'active-space'
    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['mutable regex'])

    module.namespace = 'inactive-space'
    expect(getModuleRegexScripts()).toEqual([])

    module.id = 'active-id'
    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['mutable regex'])
  })

  it('refreshes module background embedding when an active module row is replaced in place', () => {
    const db = {
      enabledModules: ['module-a'],
      moduleIntergration: '',
      modules: [
        {
          id: 'module-a',
          name: 'Module A',
          description: '',
          backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
        },
      ],
    }
    getDatabase.mockReturnValue(db)

    moduleUpdate()
    expect(moduleBackgroundEmbedding.set).toHaveBeenLastCalledWith('\n<style>.chattext .name { color: red; }</style>\n')

    vi.mocked(moduleBackgroundEmbedding.set).mockClear()
    db.modules[0] = {
      id: 'module-a',
      name: 'Module A',
      description: '',
      backgroundEmbedding: '<style>.chattext .name { color: blue; }</style>',
    }

    moduleUpdate()
    expect(moduleBackgroundEmbedding.set).toHaveBeenLastCalledWith(
      '\n<style>.chattext .name { color: blue; }</style>\n',
    )
  })

  it('reparses the UI after an authoritative active module definition refresh', () => {
    const db = {
      enabledModules: ['module-a'],
      moduleIntergration: '',
      modules: [{ id: 'module-a', name: 'Module A', namespace: 'old-namespace' }],
    }
    getDatabase.mockReturnValue(db)

    moduleUpdate()
    vi.mocked(reloadGuiAfterDefinitionChange).mockClear()

    db.modules = [{ id: 'module-a', name: 'Module A', namespace: 'new-namespace' }]
    moduleCollectionEpochState.epoch += 1
    moduleUpdate()

    expect(reloadGuiAfterDefinitionChange).toHaveBeenCalledOnce()
  })

  it('clears module background embedding when active modules no longer provide one', () => {
    const db = {
      enabledModules: ['module-a'],
      moduleIntergration: '',
      modules: [
        {
          id: 'module-a',
          name: 'Module A',
          description: '',
          backgroundEmbedding: '<style>.chattext .name { color: red; }</style>',
        },
      ],
    }
    getDatabase.mockReturnValue(db)

    moduleUpdate()
    expect(moduleBackgroundEmbedding.set).toHaveBeenLastCalledWith('\n<style>.chattext .name { color: red; }</style>\n')

    vi.mocked(moduleBackgroundEmbedding.set).mockClear()
    db.modules[0] = {
      id: 'module-a',
      name: 'Module A',
      description: '',
      backgroundEmbedding: '',
    }

    moduleUpdate()
    expect(moduleBackgroundEmbedding.set).toHaveBeenLastCalledWith('')
  })

  it('resolves module regex from the active chat selected prompt preset integration', () => {
    getCurrentChatMock.mockReturnValue({
      modules: [],
      generationSettings: {
        promptPresetId: 'chat-preset',
      },
    })
    getCurrentCharacter.mockReturnValue({ modules: [] })
    getDatabase.mockReturnValue({
      enabledModules: [],
      moduleIntergration: 'global-space',
      promptPresets: [
        { id: 'global-preset', moduleIntergration: 'global-space' },
        { id: 'chat-preset', moduleIntergration: 'chat-space' },
      ],
      modules: [
        {
          id: 'global-module',
          namespace: 'global-space',
          regex: [{ comment: 'global regex', in: 'GLOBAL', out: 'global', type: 'editdisplay' }],
        },
        {
          id: 'chat-module',
          namespace: 'chat-space',
          regex: [{ comment: 'chat regex', in: 'CHAT', out: 'chat', type: 'editdisplay' }],
        },
      ],
    })

    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['chat regex'])
  })

  it('resolves modules linked to the Persona selected for the active chat', () => {
    getCurrentChatMock.mockReturnValue({
      modules: [],
      generationSettings: { personaId: 'persona-chat' },
    })
    getCurrentCharacter.mockReturnValue({ modules: [] })
    getDatabase.mockReturnValue({
      selectedPersona: 0,
      personas: [
        { id: 'persona-global', modules: [] },
        { id: 'persona-chat', modules: ['persona-module'] },
      ],
      enabledModules: [],
      modules: [
        {
          id: 'persona-module',
          regex: [{ comment: 'persona regex', in: 'PERSONA', out: 'persona', type: 'editdisplay' }],
        },
      ],
    })

    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['persona regex'])
  })

  it('resolves module assets from an explicit character and chat context', () => {
    getCurrentCharacter.mockReturnValue({ modules: ['selected-character-module'] })
    getCurrentChatMock.mockReturnValue({ modules: ['selected-chat-module'] })
    getDatabase.mockReturnValue({
      enabledModules: [],
      modules: [
        {
          id: 'selected-character-module',
          assets: [['selected-character', 'selected-character-asset', 'png']],
        },
        {
          id: 'selected-chat-module',
          assets: [['selected-chat', 'selected-chat-asset', 'png']],
        },
        {
          id: 'explicit-character-module',
          assets: [['explicit-character', 'explicit-character-asset', 'png']],
        },
        {
          id: 'explicit-chat-module',
          assets: [['explicit-chat', 'explicit-chat-asset', 'png']],
        },
      ],
    })
    const explicitCharacter = { modules: ['explicit-character-module'] } as unknown as character
    const explicitChat = { modules: ['explicit-chat-module'] } as unknown as Chat

    expect(getModuleAssets({ character: explicitCharacter, chat: explicitChat })).toEqual([
      ['explicit-character', 'explicit-character-asset', 'png'],
      ['explicit-chat', 'explicit-chat-asset', 'png'],
    ])
  })

  it('adds module integration from the effective default Agent Preset', () => {
    getCurrentChatMock.mockReturnValue({
      modules: [],
      generationSettings: {
        promptPresetId: 'chat-preset',
      },
    })
    getCurrentCharacter.mockReturnValue({ modules: [] })
    getDatabase.mockReturnValue({
      enabledModules: [],
      moduleIntergration: '',
      promptPresets: [{ id: 'chat-preset', moduleIntergration: 'prompt-space' }],
      agentPresetDefaultId: 'agent-preset-default',
      agentPresets: [
        {
          id: 'agent-preset-default',
          enabled: true,
          moduleIntergration: 'agent-space',
        },
      ],
      modules: [
        {
          id: 'prompt-module',
          namespace: 'prompt-space',
          regex: [{ comment: 'prompt regex', in: 'PROMPT', out: 'prompt', type: 'editdisplay' }],
        },
        {
          id: 'agent-module',
          namespace: 'agent-space',
          regex: [{ comment: 'agent regex', in: 'AGENT', out: 'agent', type: 'editdisplay' }],
        },
      ],
    })

    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['prompt regex', 'agent regex'])
  })

  it('does not use global prompt integration when the active chat selected prompt has none', () => {
    getCurrentChatMock.mockReturnValue({
      modules: [],
      generationSettings: {
        promptPresetId: 'plain-preset',
      },
    })
    getCurrentCharacter.mockReturnValue({ modules: [] })
    getDatabase.mockReturnValue({
      enabledModules: [],
      moduleIntergration: 'global-space',
      promptPresets: [{ id: 'plain-preset' }],
      modules: [
        {
          id: 'global-module',
          namespace: 'global-space',
          regex: [{ comment: 'global regex', in: 'GLOBAL', out: 'global', type: 'editdisplay' }],
        },
      ],
    })

    expect(getModuleRegexScripts()).toEqual([])
  })

  it('keeps active module cache keys collision-safe for hyphenated ids', () => {
    const db = {
      enabledModules: ['a-b', 'c'],
      moduleIntergration: '',
      modules: [
        {
          id: 'a-b',
          regex: [{ comment: 'first-a-b', in: 'A', out: 'a', type: 'editdisplay' }],
        },
        {
          id: 'c',
          regex: [{ comment: 'first-c', in: 'C', out: 'c', type: 'editdisplay' }],
        },
        {
          id: 'a',
          regex: [{ comment: 'second-a', in: 'A', out: 'a', type: 'editdisplay' }],
        },
        {
          id: 'b-c',
          regex: [{ comment: 'second-b-c', in: 'B', out: 'b', type: 'editdisplay' }],
        },
      ],
    }
    getDatabase.mockReturnValue(db)

    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['first-a-b', 'first-c'])

    db.enabledModules = ['a', 'b-c']

    expect(getModuleRegexScripts().map((script) => script.comment)).toEqual(['second-a', 'second-b-c'])
  })

  it('reparses the UI when hyphenated active module ids have a colliding joined form', () => {
    const db = {
      enabledModules: ['a-b', 'c'],
      moduleIntergration: '',
      modules: [{ id: 'a-b' }, { id: 'c' }, { id: 'a' }, { id: 'b-c' }],
    }
    getDatabase.mockReturnValue(db)

    moduleUpdate()
    vi.mocked(reloadGuiAfterDefinitionChange).mockClear()

    db.enabledModules = ['a', 'b-c']
    moduleUpdate()

    expect(reloadGuiAfterDefinitionChange).toHaveBeenCalledOnce()
  })

  it('does not mutate module trigger rows when attaching low-level access metadata', () => {
    const trigger = Object.freeze({
      comment: 'readonly trigger',
      type: 'start',
      conditions: [],
      effect: [{ type: 'triggerlua', code: 'return "ok"' }],
    })
    getDatabase.mockReturnValue({
      enabledModules: ['module-a'],
      modules: [
        {
          id: 'module-a',
          name: 'Readonly Module',
          description: '',
          lowLevelAccess: true,
          trigger: [trigger],
        },
      ],
    })

    const [resolvedTrigger] = getModuleTriggers()

    expect(resolvedTrigger).not.toBe(trigger)
    expect(resolvedTrigger).toMatchObject({
      comment: 'readonly trigger',
      lowLevelAccess: true,
    })
    expect(getModuleTriggerOwner(resolvedTrigger)).toEqual({
      moduleId: 'module-a',
      scriptModelOverrides: {},
    })
    expect('lowLevelAccess' in trigger).toBe(false)
  })
})
