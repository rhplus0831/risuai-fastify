import { captureClientSessionGeneration } from '../clientSession'
import { awaitClientWriteOperation, isClientWriteOperationCurrent } from '../clientWriteOperation'
import { language } from 'src/lang'
import { alertClear, alertConfirm, alertError, alertModuleSelect, alertNormal, alertStore, alertWait } from '../alert'
import {
  type Chat,
  type Database,
  type character,
  type customscript,
  type loreBook,
  type triggerscript,
} from '../storage/database.svelte'
import { AppendableBuffer, downloadFile, forageStorage, readImage, saveAssets } from '../globalApi.svelte'
import { sleep } from '../util'
import { selectFileByDom } from '../filePicker'
import { v4 } from 'uuid'
import { compressImage } from '../media'
import { decodeRPack, encodeRPack } from '../rpack/rpack_js'
import { HideIconStore, moduleBackgroundEmbedding, reloadGuiAfterDefinitionChange } from '../stores.svelte'
import { createGlobalModule } from '../moduleCommands'
import {
  moduleActivationIdentifiersKey,
  resolveActiveModuleIdentifiers,
  resolveModuleActivationStates,
} from '../moduleActivation'
import { SERVER_ASSET_CONTENT_TYPES } from '../server/assets'
import {
  currentLorebookCollectionScopedSnapshot,
  ensureClientLorebookEntryIds,
  isCharacterLorebookHydrated,
  rollbackCharacterLorebookReplacement,
} from '../server/lorebookOwner.svelte'
import {
  acknowledgeCharacterScriptDefinitionStructuralWrite,
  beginCharacterScriptDefinitionStructuralWrite,
  ensureClientScriptDefinitionIds,
  ensureClientTriggerDefinitionIds,
  rejectCharacterScriptDefinitionStructuralWrite,
  rollbackScopedScriptDefinitionReplacement,
} from '../server/scriptDefinitionOwner.svelte'
import {
  captureCharacterLorebookProjectionEpoch,
  captureCharacterRowProjectionEpoch,
  captureCollectionProjectionEpoch,
  hasCharacterLorebookProjectionEpochChanged,
  hasCharacterRowProjectionEpochChanged,
  getCharacterResourceOwner,
} from '../server/resourceState.svelte'
import { dispatchCharacterOwnedDurableBatch, type CharacterOwnedDurableBatchStep } from '../chatCommands'
import {
  replaceCharacterLorebooksCommand,
  replaceCharacterScriptsCommand,
  replaceCharacterTriggersCommand,
  type ServerCommandResult,
} from '../server/commands'
import {
  pendingMutationCharacterLorebooksProjectionTarget,
  pendingMutationCharacterScriptsProjectionTarget,
  pendingMutationCharacterTriggersProjectionTarget,
} from '../server/pendingMutationOutbox'
import { isImportableMCPIdentifier } from './mcp/mcpIdentifier'
import { ensureCharacterLorebookHydrated } from '../server/chatMessageHydration.svelte'
import { normalizeScriptModelOverrides, type ScriptModelOverrides } from '@risuai/shared-core/script-model-overrides'
import { resolveActiveChatGenerationSettings } from '../activeChatGenerationSettings'
import { getActiveModuleReadModules, getModuleReadDatabase } from './moduleReadDatabase.svelte'
import { importLocalModuleFileFromServer } from '../server/localFileImport'
import type { ModuleFolder } from '@risuai/protocol/module-organization'

export interface MCPModule {
  url: string
}

export interface RisuModule {
  name: string
  description: string
  lorebook?: loreBook[]
  regex?: customscript[]
  cjs?: string
  trigger?: triggerscript[]
  id: string
  lowLevelAccess?: boolean
  /** Local-only model-profile selections for module-owned script LLM calls. */
  scriptModelOverrides?: ScriptModelOverrides
  hideIcon?: boolean
  backgroundEmbedding?: string
  assets?: [string, string, string][]
  namespace?: string
  customModuleToggle?: string
  mcp?: MCPModule
  folderId?: string
}

export type { ModuleFolder }

const MODULE_TRIGGER_OWNER = Symbol('risu.moduleTriggerOwner')

interface ModuleTriggerOwner {
  moduleId: string
  scriptModelOverrides: ScriptModelOverrides
}

type ModuleOwnedTrigger = triggerscript & {
  [MODULE_TRIGGER_OWNER]?: ModuleTriggerOwner
}

export function getModuleTriggerOwner(trigger: triggerscript | undefined): ModuleTriggerOwner | undefined {
  return (trigger as ModuleOwnedTrigger | undefined)?.[MODULE_TRIGGER_OWNER]
}

function attachModuleTriggerOwner(trigger: triggerscript, module: RisuModule): triggerscript {
  Object.defineProperty(trigger, MODULE_TRIGGER_OWNER, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: {
      moduleId: module.id,
      scriptModelOverrides: normalizeScriptModelOverrides(module.scriptModelOverrides),
    },
  })
  return trigger
}

export interface ReadModuleOptions {
  sourceGeneration?: number
  beforeSaveAssets?: (module: RisuModule) => boolean | void | Promise<boolean | void>
}

interface ImportRisuModuleOptions {
  sourceGeneration?: number
  alertSuccess?: boolean
}

function moduleImportCommandError(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
  if (result.status === 'conflict') return language.moduleImport.commandConflict
  if (result.status === 'unavailable') return language.moduleImport.commandUnavailable
  return language.moduleImport.commandError(result.error)
}

async function createImportedGlobalModule(module: RisuModule, sourceGeneration: number): Promise<boolean> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return false
  try {
    const result = await createGlobalModule(module)
    if (result === null || result.status === 'ok') return true
    if (!isClientWriteOperationCurrent(sourceGeneration)) return false
    alertError(moduleImportCommandError(result))
  } catch (error) {
    if (!isClientWriteOperationCurrent(sourceGeneration)) return false
    alertError(language.moduleImport.commandError(error instanceof Error ? error.message : String(error)))
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeModuleAssetMetadata(value: unknown): [string, string, string][] | null | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Array.isArray(value)) {
    return null
  }
  const assets: [string, string, string][] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) {
      return null
    }
    if (typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      return null
    }
    const fileName = entry[2]
    if (fileName !== undefined && fileName !== null && typeof fileName !== 'string') {
      return null
    }
    assets.push([entry[0], entry[1], fileName ?? ''])
  }
  return assets
}

function normalizeRisuModuleMetadata(module: unknown): RisuModule | null {
  if (!isRecord(module)) {
    return null
  }
  if (typeof module.name !== 'string' || module.name.trim() === '') {
    return null
  }
  if (typeof module.id !== 'string' || module.id.trim() === '') {
    return null
  }
  const assets = normalizeModuleAssetMetadata(module.assets)
  if (assets === null) {
    return null
  }
  const normalized = module as unknown as RisuModule
  // Script model-profile bindings are deliberately installation-local. Crafted
  // or older single-module imports must not bind themselves to a coincidentally
  // matching local profile id.
  delete normalized.scriptModelOverrides
  delete normalized.folderId
  if (assets) {
    normalized.assets = assets
  } else {
    delete normalized.assets
  }
  return normalized
}

function hasMcpModuleMetadata(module: RisuModule): boolean {
  return Object.prototype.hasOwnProperty.call(module, 'mcp')
}

function moduleAssetExtensionFromFileName(fileName: string): string {
  const normalized = fileName.trim().toLowerCase()
  if (!normalized) {
    return ''
  }
  return normalized.split('.').pop() ?? ''
}

function isSupportedModuleAssetExtension(extension: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVER_ASSET_CONTENT_TYPES, extension)
}

function asciiSlice(data: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...data.subarray(start, end))
}

function inferModuleAssetExtension(data: Uint8Array): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && asciiSlice(data, 1, 4) === 'PNG') {
    return 'png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpg'
  }
  if (data.length >= 12 && asciiSlice(data, 0, 4) === 'RIFF' && asciiSlice(data, 8, 12) === 'WEBP') {
    return 'webp'
  }
  if (data.length >= 6) {
    const gifHeader = asciiSlice(data, 0, 6)
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
      return 'gif'
    }
  }
  if (data.length >= 12 && asciiSlice(data, 4, 8) === 'ftyp') {
    const majorBrand = asciiSlice(data, 8, 12)
    if (majorBrand === 'avif' || majorBrand === 'avis') {
      return 'avif'
    }
    for (let offset = 16; offset + 4 <= Math.min(data.length, 64); offset += 4) {
      const compatibleBrand = asciiSlice(data, offset, offset + 4)
      if (compatibleBrand === 'avif' || compatibleBrand === 'avis') {
        return 'avif'
      }
    }
  }
  return undefined
}

function uploadFileNameForModuleAsset(fileName: string, data: Uint8Array): string {
  const extension = moduleAssetExtensionFromFileName(fileName)
  if (!extension) {
    return fileName
  }
  if (isSupportedModuleAssetExtension(extension)) {
    return fileName
  }
  return `asset.${inferModuleAssetExtension(data) ?? 'png'}`
}

async function guardImportableRisuModule(module: RisuModule, sourceGeneration: number): Promise<boolean> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return false
  if (hasMcpModuleMetadata(module)) {
    const mcp = module.mcp as unknown
    const url = isRecord(mcp) && typeof mcp.url === 'string' ? mcp.url.trim() : ''
    if (!isImportableMCPIdentifier(url)) {
      alertError(language.moduleImport.mcpInvalidUrl)
      return false
    }
    module.mcp = { url }
  }
  if (module.lowLevelAccess) {
    const conf = await alertConfirm(language.lowLevelAccessConfirm)
    if (!isClientWriteOperationCurrent(sourceGeneration)) return false
    if (!conf) {
      return false
    }
  }
  return true
}

export function moduleForSingleItemExport(module: RisuModule): RisuModule {
  const exported = safeStructuredClone(module)
  delete exported.scriptModelOverrides
  delete exported.folderId
  return exported
}

export async function exportModule(
  module: RisuModule,
  arg: {
    alertEnd?: boolean
    saveData?: boolean
  } = {},
) {
  const alertEnd = arg.alertEnd ?? true
  const saveData = arg.saveData ?? true
  const apb = new AppendableBuffer()
  const writeLength = (len: number) => {
    const lenbuf = Buffer.alloc(4)
    lenbuf.writeUInt32LE(len, 0)
    apb.append(lenbuf)
  }
  const writeByte = (byte: number) => {
    //byte is 0-255
    const buf = Buffer.alloc(1)
    buf.writeUInt8(byte, 0)
    apb.append(buf)
  }

  const assets = module.assets ?? []
  module = moduleForSingleItemExport(module)
  module.assets ??= []
  module.assets = module.assets.map((asset) => {
    return [asset[0], '', asset[2]] as [string, string, string]
  })

  const mainbuf = await encodeRPack(
    Buffer.from(
      JSON.stringify(
        {
          module: module,
          type: 'risuModule',
        },
        null,
        2,
      ),
      'utf-8',
    ),
  )

  writeByte(111) //magic number
  writeByte(0) //version
  writeLength(mainbuf.length)
  apb.append(mainbuf)

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]
    writeByte(1) //mark as asset
    alertStore.set({
      type: 'wait',
      msg: `Loading... (Adding Assets ${i} / ${assets.length})`,
    })
    let rData = await readImage(asset[1])
    if (!rData) {
      rData = new Uint8Array(0) //blank buffer
    }
    let encoded = await encodeRPack(Buffer.from(await compressImage(rData)))
    writeLength(encoded.length)
    apb.append(encoded)
  }

  writeByte(0) //end of file

  if (saveData) {
    await downloadFile(module.name + '.risum', apb.buffer)
  }
  if (alertEnd) {
    alertNormal(language.successExport)
  }

  return apb.buffer
}

export async function readModule(
  data: Uint8Array | Buffer,
  options: ReadModuleOptions = {},
): Promise<RisuModule | undefined> {
  const sourceGeneration = options.sourceGeneration ?? captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return undefined

  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let pos = 0

  const readLength = () => {
    if (pos + 4 > buf.length) {
      throw new Error('Unexpected end of module file')
    }
    const len = buf.readUInt32LE(pos)
    pos += 4
    return len
  }
  const readByte = () => {
    if (pos + 1 > buf.length) {
      throw new Error('Unexpected end of module file')
    }
    const byte = buf.readUInt8(pos)
    pos += 1
    return byte
  }
  const readData = (len: number) => {
    if (len < 0 || pos + len > buf.length) {
      throw new Error('Unexpected end of module file')
    }
    const data = buf.subarray(pos, pos + len)
    pos += len
    return data
  }

  try {
    if (readByte() !== 111) {
      throw new Error('Invalid magic number')
    }
    if (readByte() !== 0) {
      //Version check
      throw new Error('Invalid version')
    }

    const mainLen = readLength()
    const mainData = readData(mainLen)
    const main: {
      type?: unknown
      module?: unknown
    } = JSON.parse(Buffer.from(await awaitClientWriteOperation(sourceGeneration, decodeRPack(mainData))).toString())

    const parsedModule = normalizeRisuModuleMetadata(main.module)
    if (main.type !== 'risuModule' || !parsedModule) {
      throw new Error('Invalid module data')
    }

    let module = parsedModule

    const shouldReadAssets = await awaitClientWriteOperation(sourceGeneration, options.beforeSaveAssets?.(module))
    if (shouldReadAssets === false) {
      return
    }

    const retryDelayMs = 5000
    const maxRetries = 3
    const totalAssets = module.assets?.length ?? 0
    let completed = 0
    let reportedCompleted = -1

    const reportCompleted = (nextCompleted: number) => {
      if (!isCurrent()) return
      const boundedCompleted = Math.max(0, Math.min(totalAssets, nextCompleted))
      if (boundedCompleted <= reportedCompleted) return
      reportedCompleted = boundedCompleted
      alertWait(`Loading... (Adding Assets ${reportedCompleted} / ${totalAssets})`)
    }

    type AssetTask = {
      index: number
      data: Uint8Array
    }

    const runAssetTasks = async (tasks: AssetTask[]) => {
      if (tasks.length === 0) {
        return []
      }
      const failed: AssetTask[] = []
      const decodedTasks: { task: AssetTask; decoded: Uint8Array; fileName: string }[] = []
      for (const task of tasks) {
        try {
          const decoded = await awaitClientWriteOperation(sourceGeneration, decodeRPack(task.data))
          if (!module.assets?.[task.index]) {
            throw new Error(`Missing asset metadata for index ${task.index}`)
          }
          decodedTasks.push({
            task,
            decoded,
            fileName: uploadFileNameForModuleAsset(module.assets[task.index][2] ?? '', decoded),
          })
        } catch (error) {
          if (!isCurrent()) throw error

          throw new Error(`Failed to decode module asset ${task.index + 1}`, { cause: error })
        }
      }

      reportCompleted(completed)
      try {
        const completedBeforeBatch = completed
        const savedAssetIds = await awaitClientWriteOperation(
          sourceGeneration,
          saveAssets(
            decodedTasks.map((task) => ({
              data: task.decoded,
              fileName: task.fileName,
            })),
            {
              onProgress: (batchCompleted) => reportCompleted(completedBeforeBatch + batchCompleted),
            },
          ),
        )
        for (let i = 0; i < decodedTasks.length; i++) {
          // Preserve the module asset's declared filename (the [2] slot of
          // the [name, asset_id, filename] tuple) so persisted metadata
          // matches the source extension.
          module.assets[decodedTasks[i].task.index][1] = savedAssetIds[i]
          completed += 1
        }
      } catch (error) {
        if (!isCurrent()) throw error

        failed.push(...decodedTasks.map((task) => task.task))
      }
      reportCompleted(completed)
      return failed
    }

    const tasks: AssetTask[] = []
    let i = 0
    while (true) {
      const mark = readByte()
      if (mark === 0) {
        break
      }
      if (mark !== 1) {
        throw new Error('Invalid module asset marker')
      }
      const len = readLength()
      const data = readData(len)
      tasks.push({
        index: i,
        data,
      })
      i++
    }

    if (tasks.length !== totalAssets) {
      throw new Error('Module asset payload count does not match metadata')
    }

    try {
      let failed = await awaitClientWriteOperation(sourceGeneration, runAssetTasks(tasks))
      let retryCount = 0
      while (failed.length > 0 && retryCount < maxRetries) {
        await awaitClientWriteOperation(sourceGeneration, sleep(retryDelayMs))
        retryCount += 1
        failed = await awaitClientWriteOperation(sourceGeneration, runAssetTasks(failed))
      }
      if (failed.length > 0) {
        throw new Error(`Failed to save ${failed.length} assets`)
      }
    } finally {
      if (isCurrent()) alertClear()
    }

    module.id = v4()
    return module
  } catch (error) {
    if (!isCurrent()) return undefined

    console.error(error)
    alertError(language.errors.noData)
    return
  }
}

export async function importRisuModuleData(
  data: Uint8Array | Buffer,
  options: ImportRisuModuleOptions = {},
): Promise<RisuModule | undefined> {
  const sourceGeneration = options.sourceGeneration ?? captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return undefined

  const alertSuccess = options.alertSuccess ?? true
  const module = await readModule(data, {
    sourceGeneration,
    beforeSaveAssets: (module) => guardImportableRisuModule(module, sourceGeneration),
  })
  if (!module || !isCurrent()) {
    return
  }
  if (!(await createImportedGlobalModule(module, sourceGeneration))) {
    return
  }
  if (isCurrent() && alertSuccess) {
    alertNormal(language.successImport)
  }
  return module
}

export async function importRisuModuleObject(
  importData: RisuModule,
  options: ImportRisuModuleOptions = {},
): Promise<RisuModule | false | undefined> {
  const sourceGeneration = options.sourceGeneration ?? captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return undefined

  const alertSuccess = options.alertSuccess ?? false
  const normalizedImportData = normalizeRisuModuleMetadata(importData)
  if (!normalizedImportData) {
    alertError(language.errors.noData)
    return
  }
  if (!(await guardImportableRisuModule(normalizedImportData, sourceGeneration)) || !isCurrent()) {
    return false
  }
  normalizedImportData.id = v4()
  if (!(await createImportedGlobalModule(normalizedImportData, sourceGeneration))) {
    return
  }
  if (isCurrent() && alertSuccess) {
    alertNormal(language.successImport)
  }
  return normalizedImportData
}

export async function importModule() {
  const sourceGeneration = captureClientSessionGeneration()
  if (!isClientWriteOperationCurrent(sourceGeneration)) return
  const file = (await selectFileByDom(['json', 'lorebook', 'risum'], 'single'))?.[0]
  if (!file || !isClientWriteOperationCurrent(sourceGeneration)) {
    return
  }
  await importModuleFile(file, file.name, sourceGeneration)
}

export async function importModuleFile(
  file: Blob,
  fileName = file instanceof File ? file.name : 'module.risum',
  sourceGeneration = captureClientSessionGeneration(),
) {
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return
  alertWait('Loading... (Uploading)')
  let result = await importLocalModuleFileFromServer({ file, fileName })
  if (!isCurrent()) return
  if (result.status === 'low-level-access') {
    const confirmed = await alertConfirm(language.lowLevelAccessConfirm)
    if (!isCurrent()) return
    if (!confirmed) {
      alertClear()
      return
    }
    alertWait('Loading... (Processing)')
    result = await importLocalModuleFileFromServer({
      pendingImportToken: result.pendingImportToken,
      allowLowLevelAccess: true,
    })
  }
  if (!isCurrent()) return
  if (result.status === 'ok') {
    alertNormal(language.successImport)
    return
  }
  if (result.status === 'conflict') {
    alertError(language.moduleImport.commandConflict)
  } else if (result.status === 'unavailable') {
    alertError(language.moduleImport.commandUnavailable)
  } else if (result.status === 'error' || result.status === 'password-invalid') {
    alertError(language.moduleImport.commandError(result.error))
  } else {
    alertError(language.errors.noData)
  }
}

const emptyModuleList: RisuModule[] = []

function getDatabaseModules(db: Database) {
  return Array.isArray(db.modules) ? db.modules : emptyModuleList
}

function getModuleById(id: string, db: Database) {
  const modules = getDatabaseModules(db)
  for (let i = 0; i < modules.length; i++) {
    if (modules[i].id === id) {
      return modules[i]
    }
  }
  return null
}

let lastModules = ''
let lastModuleData: RisuModule[] = []
let lastModuleSource: RisuModule[] | undefined
let lastModuleSourceRows: Array<{
  module: RisuModule
  id: string
  namespace: string | undefined
}> = []

export interface ActiveModuleContext {
  database?: Database
  character: character | undefined
  chat: Chat | undefined
}

function activeModuleCacheRowsUnchanged(moduleSource: RisuModule[]): boolean {
  if (lastModuleSourceRows.length !== moduleSource.length) return false

  return lastModuleSourceRows.every((cached, index) => {
    const current = moduleSource[index]
    return cached.module === current && cached.id === current.id && cached.namespace === current.namespace
  })
}

export function getModules(context?: ActiveModuleContext) {
  if (!context) return getActiveModuleReadModules()
  const db = context.database ?? getModuleReadDatabase()
  const currentChat = context.chat
  const character = context.character
  const moduleSource = getDatabaseModules(db)
  const activationIdentifiers = resolveActiveModuleIdentifiers(db, character, currentChat)
  const idsJoined = moduleActivationIdentifiersKey(activationIdentifiers)
  if (lastModules === idsJoined && lastModuleSource === moduleSource && activeModuleCacheRowsUnchanged(moduleSource)) {
    return lastModuleData
  }

  const resolvedModules = resolveModuleActivationStates({
    modules: moduleSource,
    identifiers: activationIdentifiers,
  }).map((state) => state.module)
  lastModules = idsJoined
  lastModuleSource = moduleSource
  lastModuleSourceRows = moduleSource.map((module) => ({
    module,
    id: module.id,
    namespace: module.namespace,
  }))
  lastModuleData = resolvedModules
  return resolvedModules
}

export function getModuleLorebooks(context?: ActiveModuleContext) {
  const modules = getModules(context)
  let lorebooks: loreBook[] = []
  for (const module of modules) {
    if (!module) {
      continue
    }
    if (module.lorebook) {
      lorebooks = lorebooks.concat(module.lorebook)
    }
  }
  return lorebooks
}

export function getModuleAssets(context?: ActiveModuleContext) {
  const modules = getModules(context)
  let assets: [string, string, string][] = []
  for (const module of modules) {
    if (!module) {
      continue
    }
    if (module.assets) {
      assets = assets.concat(module.assets)
    }
  }
  return assets
}

export function getModuleTriggers(context?: ActiveModuleContext) {
  const modules = getModules(context)
  let triggers: triggerscript[] = []
  for (const module of modules) {
    if (!module) {
      continue
    }
    if (module.trigger) {
      triggers = triggers.concat(
        module.trigger.map((t) => {
          return attachModuleTriggerOwner(
            {
              ...t,
              lowLevelAccess: module.lowLevelAccess,
            },
            module,
          )
        }),
      )
    }
  }
  return triggers
}

export function getModuleRegexScripts(context?: ActiveModuleContext) {
  const modules = getModules(context)
  let customscripts: customscript[] = []
  for (const module of modules) {
    if (!module) {
      continue
    }
    if (module.regex) {
      customscripts = customscripts.concat(module.regex)
    }
  }
  return customscripts
}

export function getModuleToggles(context?: ActiveModuleContext) {
  const modules = getModules(context)
  let costomModuleToggles: string = ''
  for (const module of modules) {
    if (!module) {
      continue
    }
    if (module.customModuleToggle) {
      costomModuleToggles += '\n' + module.customModuleToggle + '\n'
    }
  }
  return costomModuleToggles
}

export function getModuleMcps(context?: ActiveModuleContext) {
  const modules = getModules(context)

  return modules.map((v) => v.mcp?.url).filter((v) => v)
}

interface ModuleApplyBatchStep extends CharacterOwnedDurableBatchStep {
  rejectStructuralAttempt?: () => void
}

function moduleApplySnapshot(value: unknown): string {
  const snapshot = JSON.stringify(value)
  return snapshot === undefined ? '__undefined__' : snapshot
}

function moduleApplyFailureMessage(result: Exclude<ServerCommandResult, { status: 'ok' }>): string {
  if (result.status === 'conflict') return language.moduleApply.commandConflict
  if (result.status === 'unavailable') return language.moduleApply.commandUnavailable
  return language.moduleApply.commandError(result.error)
}

let moduleApplyInFlight = false

export async function applyModule() {
  if (moduleApplyInFlight) return
  moduleApplyInFlight = true
  try {
    await applyModuleOnce()
  } finally {
    moduleApplyInFlight = false
  }
}

async function applyModuleOnce() {
  const sel = await alertModuleSelect()
  if (!sel) {
    return
  }

  const generation = resolveActiveChatGenerationSettings()
  const module = safeStructuredClone(getModuleById(sel, generation.db))
  if (!module) {
    return
  }

  let currentChar = generation.character
  if (!currentChar) {
    return
  }

  const characterId = currentChar.chaId
  if (!characterId) {
    return
  }

  const hasModuleLorebooks = (module.lorebook?.length ?? 0) > 0
  const hasModuleScripts = (module.regex?.length ?? 0) > 0
  const hasModuleTriggers = (module.trigger?.length ?? 0) > 0
  if (hasModuleLorebooks && generation.db.enableLorebookStubs && !isCharacterLorebookHydrated(characterId)) {
    const hydrated = await ensureCharacterLorebookHydrated(characterId)
    if (!hydrated) {
      alertError(language.lorebookDataLoadFailed)
      return
    }
    const hydratedCharacter = getCharacterResourceOwner(characterId)
    if (!hydratedCharacter) return
    currentChar = hydratedCharacter
  }

  const optimisticRowEpoch = captureCharacterRowProjectionEpoch(characterId)
  const optimisticLorebookEpoch = captureCharacterLorebookProjectionEpoch(characterId)
  const canApplyLorebooks = hasModuleLorebooks
  const lorePrevious = canApplyLorebooks
    ? currentLorebookCollectionScopedSnapshot({ kind: 'character', characterId })
    : null
  const previousScripts = hasModuleScripts ? safeStructuredClone(currentChar.customscript ?? []) : null
  const previousTriggers = hasModuleTriggers ? safeStructuredClone(currentChar.triggerscript ?? []) : null
  const hadScriptsField = hasModuleScripts ? Object.prototype.hasOwnProperty.call(currentChar, 'customscript') : false
  const hadTriggersField = hasModuleTriggers
    ? Object.prototype.hasOwnProperty.call(currentChar, 'triggerscript')
    : false

  const nextLorebooks =
    hasModuleLorebooks && module.lorebook && lorePrevious
      ? ensureClientLorebookEntryIds([
          ...safeStructuredClone(currentChar.globalLore ?? []),
          ...safeStructuredClone(module.lorebook),
        ])
      : undefined
  const nextScripts =
    hasModuleScripts && module.regex
      ? ensureClientScriptDefinitionIds([
          ...safeStructuredClone(currentChar.customscript ?? []),
          ...safeStructuredClone(module.regex),
        ])
      : undefined
  const nextTriggers =
    hasModuleTriggers && module.trigger
      ? ensureClientTriggerDefinitionIds([
          ...safeStructuredClone(currentChar.triggerscript ?? []),
          ...safeStructuredClone(module.trigger),
        ])
      : undefined

  const scriptsRollback =
    nextScripts && previousScripts
      ? {
          kind: 'characterScripts' as const,
          characterId,
          scripts: previousScripts,
          hadScriptsField,
        }
      : null
  const triggersRollback =
    nextTriggers && previousTriggers
      ? {
          kind: 'characterTriggers' as const,
          characterId,
          triggers: previousTriggers,
          hadTriggersField,
        }
      : null
  const scriptStructuralAttempt =
    nextScripts && scriptsRollback
      ? beginCharacterScriptDefinitionStructuralWrite(
          'characterScripts',
          characterId,
          nextScripts,
          scriptsRollback,
          optimisticRowEpoch,
        )
      : null
  const triggerStructuralAttempt =
    nextTriggers && triggersRollback
      ? beginCharacterScriptDefinitionStructuralWrite(
          'characterTriggers',
          characterId,
          nextTriggers,
          triggersRollback,
          optimisticRowEpoch,
        )
      : null

  const steps: ModuleApplyBatchStep[] = []
  if (nextLorebooks && lorePrevious) {
    const lorebookSnapshot = safeStructuredClone(nextLorebooks) as Parameters<
      typeof replaceCharacterLorebooksCommand
    >[0]['entries']
    const attemptedLorebooks = safeStructuredClone(lorebookSnapshot) as loreBook[]
    const previousLorebooks = safeStructuredClone(lorePrevious.scopedValue ?? []) as loreBook[]
    const projectionTarget = pendingMutationCharacterLorebooksProjectionTarget(characterId)
    steps.push({
      method: 'PUT',
      path: `/characters/${encodeURIComponent(characterId)}/lorebooks`,
      body: { entries: lorebookSnapshot },
      projectionTargets: [projectionTarget],
      command: (baseRevision, frozenBody) => {
        const entries = frozenBody.entries as Parameters<typeof replaceCharacterLorebooksCommand>[0]['entries']
        return replaceCharacterLorebooksCommand({
          baseRevision,
          characterId,
          entries,
          acknowledgeOptimistic: true,
          optimisticEntries: entries,
          optimisticRowEpoch,
          optimisticLorebookEpoch,
        })
      },
      rollback: () => {
        if (
          hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch) ||
          hasCharacterLorebookProjectionEpochChanged(characterId, optimisticLorebookEpoch)
        ) {
          return
        }
        rollbackCharacterLorebookReplacement(characterId, lorePrevious, attemptedLorebooks)
      },
      reapply: (isTargetCurrent) => {
        if (
          hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch) ||
          hasCharacterLorebookProjectionEpochChanged(characterId, optimisticLorebookEpoch) ||
          !isTargetCurrent(projectionTarget)
        ) {
          return
        }
        const target = getCharacterResourceOwner(characterId)
        if (!target) return
        if (moduleApplySnapshot(target.globalLore ?? []) === moduleApplySnapshot(attemptedLorebooks)) return
        if (moduleApplySnapshot(target.globalLore ?? []) !== moduleApplySnapshot(previousLorebooks)) return
        target.globalLore = safeStructuredClone(attemptedLorebooks)
      },
    })
  }
  if (nextScripts && scriptsRollback && scriptStructuralAttempt) {
    const scriptsSnapshot = safeStructuredClone(nextScripts) as Parameters<
      typeof replaceCharacterScriptsCommand
    >[0]['scripts']
    const attemptedScripts = safeStructuredClone(scriptsSnapshot) as customscript[]
    const projectionTarget = pendingMutationCharacterScriptsProjectionTarget(characterId)
    steps.push({
      method: 'PUT',
      path: `/characters/${encodeURIComponent(characterId)}/scripts`,
      body: { scripts: scriptsSnapshot },
      projectionTargets: [projectionTarget],
      command: async (baseRevision, frozenBody) => {
        const scripts = frozenBody.scripts as Parameters<typeof replaceCharacterScriptsCommand>[0]['scripts']
        const result = await replaceCharacterScriptsCommand(
          {
            baseRevision,
            characterId,
            scripts,
            optimisticRowEpoch,
          },
          undefined,
          false,
          true,
        )
        if (result.status === 'ok') {
          acknowledgeCharacterScriptDefinitionStructuralWrite(scriptStructuralAttempt)
        }
        return result
      },
      rollback: () => {
        rejectCharacterScriptDefinitionStructuralWrite(scriptStructuralAttempt)
        if (hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch)) return
        rollbackScopedScriptDefinitionReplacement(scriptsRollback, {
          kind: 'characterScripts',
          characterId,
          scripts: attemptedScripts,
        })
      },
      reapply: (isTargetCurrent) => {
        if (
          hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch) ||
          !isTargetCurrent(projectionTarget)
        ) {
          return
        }
        const target = getCharacterResourceOwner(characterId)
        if (!target) return
        const hasCurrent = Object.prototype.hasOwnProperty.call(target, 'customscript')
        const matchesAttempted =
          hasCurrent && moduleApplySnapshot(target.customscript) === moduleApplySnapshot(attemptedScripts)
        if (matchesAttempted) return
        const matchesPrevious = hadScriptsField
          ? hasCurrent && moduleApplySnapshot(target.customscript) === moduleApplySnapshot(previousScripts)
          : !hasCurrent
        if (!matchesPrevious) return
        target.customscript = safeStructuredClone(attemptedScripts)
      },
      rejectStructuralAttempt: () => rejectCharacterScriptDefinitionStructuralWrite(scriptStructuralAttempt),
    })
  }
  if (nextTriggers && triggersRollback && triggerStructuralAttempt) {
    const triggersSnapshot = safeStructuredClone(nextTriggers) as Parameters<
      typeof replaceCharacterTriggersCommand
    >[0]['triggers']
    const attemptedTriggers = safeStructuredClone(triggersSnapshot) as triggerscript[]
    const projectionTarget = pendingMutationCharacterTriggersProjectionTarget(characterId)
    steps.push({
      method: 'PUT',
      path: `/characters/${encodeURIComponent(characterId)}/triggers`,
      body: { triggers: triggersSnapshot },
      projectionTargets: [projectionTarget],
      command: async (baseRevision, frozenBody) => {
        const triggers = frozenBody.triggers as Parameters<typeof replaceCharacterTriggersCommand>[0]['triggers']
        const result = await replaceCharacterTriggersCommand(
          {
            baseRevision,
            characterId,
            triggers,
            optimisticRowEpoch,
          },
          undefined,
          false,
          true,
        )
        if (result.status === 'ok') {
          acknowledgeCharacterScriptDefinitionStructuralWrite(triggerStructuralAttempt)
        }
        return result
      },
      rollback: () => {
        rejectCharacterScriptDefinitionStructuralWrite(triggerStructuralAttempt)
        if (hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch)) return
        rollbackScopedScriptDefinitionReplacement(triggersRollback, {
          kind: 'characterTriggers',
          characterId,
          triggers: attemptedTriggers,
        })
      },
      reapply: (isTargetCurrent) => {
        if (
          hasCharacterRowProjectionEpochChanged(characterId, optimisticRowEpoch) ||
          !isTargetCurrent(projectionTarget)
        ) {
          return
        }
        const target = getCharacterResourceOwner(characterId)
        if (!target) return
        const hasCurrent = Object.prototype.hasOwnProperty.call(target, 'triggerscript')
        const matchesAttempted =
          hasCurrent && moduleApplySnapshot(target.triggerscript) === moduleApplySnapshot(attemptedTriggers)
        if (matchesAttempted) return
        const matchesPrevious = hadTriggersField
          ? hasCurrent && moduleApplySnapshot(target.triggerscript) === moduleApplySnapshot(previousTriggers)
          : !hasCurrent
        if (!matchesPrevious) return
        target.triggerscript = safeStructuredClone(attemptedTriggers)
      },
      rejectStructuralAttempt: () => rejectCharacterScriptDefinitionStructuralWrite(triggerStructuralAttempt),
    })
  }

  // The batch helper synchronously freezes and stages every exact full-snapshot
  // PUT before it reserves the shared command queue. Start it before projecting
  // the rows, then wait for its accepted/retained outcome before reporting UI
  // success.
  const applyResult =
    steps.length > 0
      ? dispatchCharacterOwnedDurableBatch(characterId, steps)
      : Promise.resolve({ status: 'ok' as const, acceptedCount: 0 })
  const target = getCharacterResourceOwner(characterId)
  if (target) {
    if (nextLorebooks) target.globalLore = safeStructuredClone(nextLorebooks)
    if (nextScripts) target.customscript = safeStructuredClone(nextScripts)
    if (nextTriggers) target.triggerscript = safeStructuredClone(nextTriggers)
  }

  const outcome = await applyResult
  for (const step of steps.slice(outcome.acceptedCount)) {
    step.rejectStructuralAttempt?.()
  }
  if (outcome.status === 'ok') {
    alertNormal(language.successApplyModule)
  } else if (outcome.status === 'retained') {
    alertNormal(language.moduleApply.queued)
  } else {
    alertError(moduleApplyFailureMessage(outcome.failure))
  }
}

let lastModuleIds: string = ''
let lastModuleProjectionEpoch = -1

export function moduleUpdate() {
  const generation = resolveActiveChatGenerationSettings()
  const m = getModules({ database: generation.db, character: generation.character, chat: generation.chat })

  const ids = JSON.stringify(m.map((module) => module.id))
  const projectionEpoch = captureCollectionProjectionEpoch('modules')

  let moduleHideIcon = false
  let backgroundEmbedding = ''
  m.forEach((module) => {
    if (!module) {
      return
    }

    if (module.hideIcon) {
      moduleHideIcon = true
    }
    if (module.backgroundEmbedding) {
      backgroundEmbedding += '\n' + module.backgroundEmbedding + '\n'
    }
  })

  moduleBackgroundEmbedding.set(backgroundEmbedding)
  HideIconStore.set(generation.character?.hideChatIcon || moduleHideIcon)

  if (lastModuleIds !== ids || lastModuleProjectionEpoch !== projectionEpoch) {
    reloadGuiAfterDefinitionChange()
    lastModuleIds = ids
    lastModuleProjectionEpoch = projectionEpoch
  }
}

export function refreshModules() {
  lastModules = ''
  lastModuleData = []
  lastModuleSource = undefined
  lastModuleProjectionEpoch = -1
}
