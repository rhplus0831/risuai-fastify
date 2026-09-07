import {
  assertClientWriteAccess,
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  clientSessionStore,
  isClientSessionGenerationCurrent,
  isClientReadOnly,
} from '../clientSession'
import { get, readonly, writable } from 'svelte/store'
import { language } from '../../lang'
import type { character } from '../storage/database.svelte'
import { alertConfirm, alertError } from '../alert'
import { selectSingleFile } from '../filePicker'
import type { OpenAIChat } from '../process/index.svelte'
import { pluginFetchNative, pluginGlobalFetch, readImage, saveAsset } from '../globalApi.svelte'
import { hotReloading, selectedCharID } from '../stores.svelte'
import { invalidateModuleRenderRevision } from '../moduleRenderRevision'
import type { ScriptMode } from '../process/scripts'
import type { RisuModule } from '../process/modules'
import { safeStructuredClone } from '../polyfill'
import {
  BlockedPluginNetworkPrimitive,
  SafeDocument,
  SafeIdbFactory,
  SafeLocalStorage,
  SafePluginLocation,
  SafePluginNavigator,
  isDeviceLocalPluginStorageEnabled,
} from './pluginSafeClass'
import { loadV3Plugins } from './apiV3/v3.svelte'
import { pluginCodeTranspiler } from './apiV3/transpiler'
import {
  acceptedPluginRuntimeProjection,
  applyPluginProviderOwner,
  applyPluginSettingsOwnerPatch,
  currentPluginCharacterSnapshot,
  currentPluginCollectionSnapshot,
  currentPluginDatabaseSnapshot,
  currentPluginStorageSnapshot,
  currentPluginStorageOwnerSnapshot,
  currentPluginStorageValueOwner,
  currentPluginStateSnapshot,
  currentPluginSettingsPatchRollbackSnapshot,
  dispatchBulkPluginStorage,
  dispatchPluginCollectionPatch,
  dispatchDeletePluginStorage,
  dispatchPluginSettingsPatch,
  dispatchPutPluginStorage,
  dispatchSelectPluginProvider,
  dispatchUpdatePlugin,
  replacePluginCharacterOwnerAt,
  replacePluginCharactersOwner,
  applyPluginCharacterPointerOwner,
  replacePluginCollectionOwner,
  replacePluginStorageOwner,
  runCreatePluginCommand,
  runUpdatePluginCommand,
  toPluginSnapshot,
  type PluginMutationFinalSettlement,
  type PluginMutationOutcome,
} from '../pluginCommands'
import {
  currentGlobalModuleStateSnapshot,
  dispatchEnabledModulesPatch,
  dispatchModuleCollectionPatch,
} from '../moduleCommands'
import { currentCharacterRowSnapshot, prepareCompatibleCharacterUpdateScoped } from '../characterCommands'
import { canUseServerCommands } from '../server/commands'
import { collectionsResourceState, settingsResourceState } from '../server/resourceState.svelte'
import { assertNoUnsupportedCharacterChanges } from './unsupportedServerWriteGuard'
import {
  beginPluginImport,
  capturePluginImportTarget,
  clearPluginImport,
  isFreshPluginImport,
  resolveFreshPluginImportApplyTarget,
  type PluginImportFreshness,
  type PluginImportOperation,
} from '../server/pluginImport'
import { createPluginNetworkAccess, createPluginWebFetch } from './pluginNetworkAccess'
import {
  checkPluginUpdate as checkPluginUpdateRequest,
  comparePluginVersions,
  downloadPluginUpdate,
} from './pluginUpdates'
import { mirrorTopLevelPresetFieldWithOutcome } from '../presetFieldMirror'
import {
  addChatOutputListener,
  chatOutputListeners,
  removeChatOutputListener,
  setChatOutputRuntimeReadyPredicate,
  type ChatOutputListener,
} from './chatOutputListeners'
import { settleStartupPluginRuntimeReadiness } from '../startupReadiness'

export const customProviderStore = writable([] as string[])

export type PluginRuntimePhase = 'idle' | 'loading' | 'ready' | 'error'

export interface PluginRuntimeState {
  phase: PluginRuntimePhase
  targetSignature: string | null
  error: unknown | null
}

const initialPluginRuntimeState: PluginRuntimeState = {
  phase: 'idle',
  targetSignature: null,
  error: null,
}
const pluginRuntimeStateWritable = writable(initialPluginRuntimeState)
let pluginRuntimeStateSnapshot = initialPluginRuntimeState

function publishPluginRuntimeState(state: PluginRuntimeState): void {
  pluginRuntimeStateSnapshot = state
  pluginRuntimeStateWritable.set(state)
  settleStartupPluginRuntimeReadiness(state.phase === 'ready')
}

export const pluginRuntimeStateStore = readonly(pluginRuntimeStateWritable)

export function getPluginRuntimeState(): PluginRuntimeState {
  return { ...pluginRuntimeStateSnapshot }
}

export function isPluginRuntimeReady(): boolean {
  return canUseClientWriteAccess() && pluginRuntimeStateSnapshot.phase === 'ready'
}

export function _setPluginRuntimePhaseForTesting(phase: PluginRuntimePhase): void {
  publishPluginRuntimeState({ phase, targetSignature: null, error: null })
}

setChatOutputRuntimeReadyPredicate(isPluginRuntimeReady)

interface ProviderPlugin {
  name: string
  displayName?: string
  script: string
  arguments: { [key: string]: 'int' | 'string' | string[] }
  realArg: { [key: string]: number | string }
  version: '3.0'
  customLink: ProviderPluginCustomLink[]
  argMeta: { [key: string]: { [key: string]: string } }
  versionOfPlugin?: string
  updateURL?: string
  enabled?: boolean
  allowedIPC?: string[]
}
interface ProviderPluginCustomLink {
  link: string
  hoverText?: string
}

export type RisuPlugin = ProviderPlugin

export class UnsupportedPluginApiVersionError extends Error {
  constructor(pluginName: string, version: unknown) {
    const versionLabel =
      typeof version === 'string' || typeof version === 'number' ? JSON.stringify(version) : 'missing'
    super(
      `Plugin "${pluginName}" uses unsupported API version ${versionLabel}. Fastify supports only API version "3.0".`,
    )
    this.name = 'UnsupportedPluginApiVersionError'
  }
}

function assertSupportedPluginApiVersion(plugin: { name: string; version?: unknown }): void {
  if (plugin.version !== '3.0') {
    throw new UnsupportedPluginApiVersionError(plugin.name, plugin.version)
  }
}

export async function createBlankPlugin() {
  await importPlugin(
    `
//@name New Plugin
//@display-name New Plugin Display Name
//@api 3.0
//@arg example_arg string

Risuai.log("Hello from New Plugin!");
`.trim(),
  )
}

function currentPluginImportFreshness(): PluginImportFreshness<RisuPlugin> {
  return {
    plugins: currentPluginCollectionSnapshot(),
  }
}

function isCurrentPluginUpdateTarget(plugin: Pick<RisuPlugin, 'name' | 'script' | 'updateURL'>): boolean {
  const current = currentPluginCollectionSnapshot().find((candidate) => candidate.name === plugin.name)
  return current?.script === plugin.script && current.updateURL === plugin.updateURL
}

export async function checkPluginUpdate(plugin: RisuPlugin) {
  assertClientWriteAccess()
  const sessionGeneration = captureClientSessionGeneration()
  const target = { ...plugin }
  return checkPluginUpdateRequest(
    target,
    () =>
      canUseClientWriteAccess() &&
      isClientSessionGenerationCurrent(sessionGeneration) &&
      isCurrentPluginUpdateTarget(target),
  )
}

export type PluginImportResult =
  | { status: 'accepted'; pluginName: string }
  | { status: 'queued'; pluginName: string; settlement: Promise<PluginMutationFinalSettlement> }
  | { status: 'cancelled' | 'failed' | 'stale' }

export type PluginUpdateInstallResult =
  | 'installed'
  | 'denied'
  | 'failed'
  | 'stale'
  | { status: 'queued'; settlement: Promise<PluginMutationFinalSettlement> }

export async function installPluginUpdate(plugin: RisuPlugin): Promise<PluginUpdateInstallResult> {
  assertClientWriteAccess()
  const sessionGeneration = captureClientSessionGeneration()
  const isCurrent = () =>
    canUseClientWriteAccess() &&
    isClientSessionGenerationCurrent(sessionGeneration) &&
    isCurrentPluginUpdateTarget(plugin)
  let operation: PluginImportOperation | null = null
  try {
    if (!plugin.updateURL) {
      return 'failed'
    }

    operation = beginPluginImport(capturePluginImportTarget(currentPluginImportFreshness()))
    const download = await downloadPluginUpdate(plugin, isCurrent)
    if (download.status !== 'downloaded') return download.status
    if (!isFreshPluginImport(operation, currentPluginImportFreshness()) || !isCurrent()) {
      return 'stale'
    }
    const imported = await importPlugin(download.source, {
      isUpdate: true,
      originalPluginName: plugin.name,
      operation,
    })
    if (imported.status === 'accepted') return 'installed'
    if (imported.status === 'queued') {
      return { status: 'queued', settlement: imported.settlement }
    }
    if (imported.status === 'stale') return 'stale'
    if (!isFreshPluginImport(operation, currentPluginImportFreshness())) {
      return 'stale'
    }
    return 'failed'
  } catch (error) {
    if (!operation || isFreshPluginImport(operation, currentPluginImportFreshness())) {
      console.error('Failed to update plugin:', error)
    }
  } finally {
    if (operation) {
      clearPluginImport(operation)
    }
  }
  return 'failed'
}

export async function updatePlugin(plugin: RisuPlugin): Promise<boolean> {
  return (await installPluginUpdate(plugin)) === 'installed'
}

function completePluginImport(pluginName: string, apiVersion: string, isHotReload: boolean | undefined): void {
  if (isHotReload && !hotReloading.includes(pluginName)) {
    hotReloading.push(pluginName)
  }
  console.log(`Imported plugin: ${pluginName} (API v${apiVersion})`)
  void loadPlugins().catch((error) => {
    console.error(`Failed to load imported plugin "${pluginName}":`, error)
  })
}

function reportPluginImportPersistenceFailure(
  pluginName: string,
  outcome: Extract<PluginMutationOutcome, { status: 'failed' }>,
  isHotReload: boolean | undefined,
): void {
  const detail = 'error' in outcome.result && typeof outcome.result.error === 'string' ? outcome.result.error : ''
  const message = detail ? `${language.pluginMutation.failed}\n${detail}` : language.pluginMutation.failed
  if (isHotReload) {
    console.error(`Hot-reload plugin "${pluginName}" error: ${message}`)
  } else {
    alertError(message)
  }
}

export async function importPlugin(
  code: string | null = null,
  argu: {
    isUpdate?: boolean
    originalPluginName?: string
    isHotReload?: boolean
    isTypescript?: boolean
    operation?: PluginImportOperation
  } = {},
): Promise<PluginImportResult> {
  assertClientWriteAccess()
  const sessionGeneration = captureClientSessionGeneration()
  let operation: PluginImportOperation | null = argu.operation ?? null
  let releasePluginRuntimeSync: (() => void) | null = null
  const beginImport = () => {
    operation ??= beginPluginImport(capturePluginImportTarget(currentPluginImportFreshness()))
  }
  const isFreshImport = () =>
    canUseClientWriteAccess() &&
    isClientSessionGenerationCurrent(sessionGeneration) &&
    operation !== null &&
    isFreshPluginImport(operation, currentPluginImportFreshness())

  try {
    let jsFile = ''
    let isUpdate = argu.isUpdate || false
    let originalPluginName = argu.originalPluginName || ''
    let isTypescript = argu.isTypescript || false

    if (!code) {
      const f = await selectSingleFile(['js', 'ts'], { onFileSelected: beginImport })
      if (!f) {
        return { status: 'cancelled' }
      }
      beginImport()
      if (!isFreshImport()) {
        return { status: 'stale' }
      }
      if (f.name.endsWith('.ts')) {
        isTypescript = true
      }
      //support utf-8 with BOM or without BOM
      jsFile = Buffer.from(f.data)
        .toString('utf-8')
        .replace(/^\uFEFF/gm, '')
    } else {
      beginImport()
      if (!isFreshImport()) {
        return { status: 'stale' }
      }
      jsFile = code
    }

    const splitedJs = jsFile.split('\n')
    let name = ''
    for (const line of splitedJs) {
      if (line.startsWith('//@name')) {
        name = line.slice(7).trim()
        break
      }
    }

    const showError = (msg: string): PluginImportResult => {
      if (isFreshImport()) {
        if (argu.isHotReload) {
          console.error(`Hot-reload plugin "${name}" error: ${msg}`)
        } else {
          alertError(msg)
        }
      }
      return { status: 'failed' }
    }

    let displayName: string = undefined
    let arg: { [key: string]: 'int' | 'string' | string[] } = {}
    let realArg: { [key: string]: number | string } = {}
    let argMeta: { [key: string]: { [key: string]: string } } = {}
    let customLink: ProviderPluginCustomLink[] = []
    let updateURL: string = ''
    let versionOfPlugin: string = '' //This is the version of the plugin itself, not the API version
    let apiVersion = '2.0'
    let ipcList: string[] = []
    for (const line of splitedJs) {
      if (line.startsWith('//@name')) {
        const provied = line.slice(7)
        if (provied === '') {
          return showError('plugin name must be longer than 0, did you put it correctly?')
        }
        name = provied.trim()
      }
      if (line.startsWith('//@api')) {
        const proviedVersions = line.slice(6).trim().split(' ')
        const supportedVersions = ['2.0', '2.1', '3.0']
        for (const ver of proviedVersions) {
          if (supportedVersions.includes(ver)) {
            apiVersion = ver
            break
          } else {
            console.warn(`Plugin API version "${ver}" is not supported.`)
          }
        }
      }
      if (line.startsWith('//@display-name')) {
        const provied = line.slice('//@display-name'.length + 1)
        if (provied === '') {
          return showError('plugin display name must be longer than 0, did you put it correctly?')
        }
        displayName = provied.trim()
      }

      if (line.startsWith('//@link')) {
        const link = line.split(' ')[1]
        if (!link || link === '') {
          return showError('plugin link is empty, did you put it correctly?')
        }
        if (!link.startsWith('https')) {
          return showError('plugin link must start with https, did you check it?')
        }
        const hoverText = line.split(' ').slice(2).join(' ').trim()
        if (hoverText === '') {
          // OK, no hover text. It's fine.
          customLink.push({
            link: link,
            hoverText: undefined,
          })
        } else
          customLink.push({
            link: link,
            hoverText: hoverText || undefined,
          })
      }
      if (line.startsWith('//@risu-arg') || line.startsWith('//@arg')) {
        const provied = line.trim().split(' ')
        if (provied.length < 3) {
          return showError('plugin argument is incorrect, did you put space in argument name?')
        }
        const provKey = provied[1]

        if (provied[2] !== 'int' && provied[2] !== 'string') {
          return showError(`plugin argument type is "${provied[2]}", which is an unknown type.`)
        }
        if (provied[2] === 'int') {
          arg[provKey] = 'int'
          realArg[provKey] = 0
        } else if (provied[2] === 'string') {
          arg[provKey] = 'string'
          realArg[provKey] = ''
        }

        if (provied.length > 3) {
          const meta: { [key: string]: string } = {}
          //Compatibility layer for unofficial meta
          let metaStr = provied
            .slice(3)
            .join(' ')
            .replace(/{{(.+?)(::?(.+?))?}}/g, (a, g1: string, g2, g3: string) => {
              console.log(g1, g3)
              meta[g1] = g3 || '1'
              return ''
            })
            .trim()

          if (metaStr) {
            meta['description'] = metaStr
          }

          argMeta[provKey] = meta
        }
      }

      if (line.startsWith('//@update-url')) {
        updateURL = line.split(' ')[1]

        try {
          const url = new URL(updateURL)
          if (url.protocol !== 'https:') {
            return showError('plugin update URL must start with https, did you put it correctly?')
          }
        } catch (error) {
          return showError('plugin update URL is not a valid URL, did you put it correctly?')
        }
      }

      if (line.startsWith('//@version')) {
        versionOfPlugin = line.split(' ').slice(1).join(' ').trim()

        const versionLocation = jsFile.indexOf('//@version')
        const numberOfBytesBefore = new TextEncoder().encode(jsFile.slice(0, versionLocation) + line).length
        if (numberOfBytesBefore > 500) {
          return showError(
            'plugin version declaration must be within the first 512 Bytes of the file for proper parsing. move //@version line to the top of the file.',
          )
        }
      }

      if (line.startsWith('//@allowed-ipc')) {
        const provied = line.trim().split(' ')
        if (provied.length < 2) {
          return showError('plugin allowed IPC declaration is incorrect, did you put space after //@allowed-ipc?')
        }

        const allowedIPCList = provied.slice(1)

        ipcList.push(...allowedIPCList)
      }
    }

    if (name.length === 0) {
      return showError('plugin name not found, did you put it correctly?')
    }

    if (updateURL && versionOfPlugin.length === 0) {
      return showError(
        'plugin version not found, did you put it correctly? It is required when update URL is provided.',
      )
    }

    if (versionOfPlugin && comparePluginVersions(versionOfPlugin, '0.0.1') === -1) {
      return showError('plugin version must be at least 0.0.1')
    }

    if (apiVersion !== '3.0') {
      throw new UnsupportedPluginApiVersionError(name, apiVersion)
    }

    if (isTypescript) {
      if (!isFreshImport()) {
        return { status: 'stale' }
      }
      try {
        jsFile = await pluginCodeTranspiler(jsFile)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return showError('Failed to transpile TypeScript code: ' + message)
      }
      if (!isFreshImport()) {
        return { status: 'stale' }
      }
    }

    let pluginData: RisuPlugin = {
      name: name,
      script: jsFile,
      realArg: realArg,
      arguments: arg,
      displayName: displayName,
      version: '3.0',
      customLink: customLink,
      argMeta: argMeta,
      versionOfPlugin: versionOfPlugin,
      updateURL: updateURL,
      allowedIPC: ipcList,
      enabled: true,
    }

    const preConfirmTarget = operation
      ? resolveFreshPluginImportApplyTarget({
          operation,
          freshness: currentPluginImportFreshness(),
          plugin: pluginData,
          isUpdate,
          originalPluginName,
          isHotReload: argu.isHotReload,
        })
      : null

    if (!preConfirmTarget) {
      return { status: 'stale' }
    }

    if (preConfirmTarget.kind === 'name-mismatch') {
      return showError(
        `When updating plugin "${preConfirmTarget.originalPluginName}", the plugin name cannot be changed to "${preConfirmTarget.pluginName}". Please keep the original name to update.`,
      )
    }

    if (!isUpdate && preConfirmTarget.kind === 'update') {
      const c = await alertConfirm(language.duplicatePluginFoundUpdateIt)
      if (!isFreshImport()) {
        return { status: 'stale' }
      }
      if (!c) {
        return { status: 'cancelled' }
      }
    }

    const applyTarget = operation
      ? resolveFreshPluginImportApplyTarget({
          operation,
          freshness: currentPluginImportFreshness(),
          plugin: pluginData,
          isUpdate,
          originalPluginName,
          isHotReload: argu.isHotReload,
        })
      : null

    if (!applyTarget || applyTarget.kind === 'skip') {
      return { status: applyTarget ? 'cancelled' : 'stale' }
    }

    if (applyTarget.kind === 'name-mismatch') {
      return showError(
        `When updating plugin "${applyTarget.originalPluginName}", the plugin name cannot be changed to "${applyTarget.pluginName}". Please keep the original name to update.`,
      )
    }

    const previous = currentPluginStateSnapshot()
    // Plugin imports and updates are projected before their command settles,
    // but executing an unaccepted script would make a failed command observable
    // outside the optimistic UI. Hold automatic runtime reconciliation until
    // the accepted explicit reload below, or until rollback has restored the
    // previous runtime signature.
    releasePluginRuntimeSync = deferPluginRuntimeSync()
    let persistenceResult: ReturnType<typeof runCreatePluginCommand> | ReturnType<typeof runUpdatePluginCommand> = null
    if (applyTarget.kind === 'update') {
      const plugins = currentPluginCollectionSnapshot()
      if (applyTarget.index < 0 || applyTarget.index >= plugins.length) return { status: 'stale' }
      plugins[applyTarget.index] = pluginData
      replacePluginCollectionOwner(plugins)
      persistenceResult = runUpdatePluginCommand(applyTarget.pluginId, toPluginSnapshot(pluginData), previous)
    } else if (applyTarget.kind === 'create') {
      replacePluginCollectionOwner([...currentPluginCollectionSnapshot(), pluginData])
      persistenceResult = runCreatePluginCommand(pluginData, previous)
    }

    if (persistenceResult) {
      const result = await persistenceResult
      if (result.status === 'failed') {
        reportPluginImportPersistenceFailure(pluginData.name, result, argu.isHotReload)
        return { status: 'failed' }
      }
      if (result.status === 'queued') {
        const releaseQueuedRuntimeSync = releasePluginRuntimeSync
        releasePluginRuntimeSync = null
        const settlement = result.settlement
          .then((finalSettlement) => {
            if (
              finalSettlement.status === 'accepted' &&
              canUseClientWriteAccess() &&
              isClientSessionGenerationCurrent(sessionGeneration)
            ) {
              completePluginImport(pluginData.name, apiVersion, argu.isHotReload)
            }
            return finalSettlement
          })
          .finally(() => {
            releaseQueuedRuntimeSync?.()
          })
        return { status: 'queued', pluginName: pluginData.name, settlement }
      }
    }

    if (!canUseClientWriteAccess() || !isClientSessionGenerationCurrent(sessionGeneration)) return { status: 'stale' }
    completePluginImport(pluginData.name, apiVersion, argu.isHotReload)
    return { status: 'accepted', pluginName: pluginData.name }
  } catch (error) {
    if (error instanceof UnsupportedPluginApiVersionError) {
      throw error
    }
    console.error(error)
    if (!operation || isFreshPluginImport(operation, currentPluginImportFreshness())) {
      alertError(language.errors.noData)
    }
    return { status: 'failed' }
  } finally {
    releasePluginRuntimeSync?.()
    if (operation) {
      clearPluginImport(operation)
    }
  }
}

let pluginTranslator = false

export interface PluginRuntimeSignalSource {
  name: string
  enabled?: boolean
  version?: RisuPlugin['version']
  script: string
  allowedIPC?: string[]
}

/**
 * Runtime-relevant plugin identity. Argument values and presentation metadata
 * are intentionally excluded: V2/V3 getArg reads the live database, so typing
 * in a plugin setting must not tear down and execute every plugin again.
 */
export function pluginRuntimeSignature(plugins: readonly PluginRuntimeSignalSource[] | null | undefined): string {
  return JSON.stringify(
    (plugins ?? []).map((plugin) => [
      plugin.name,
      plugin.enabled === true,
      plugin.version ?? null,
      plugin.script,
      plugin.allowedIPC ?? [],
    ]),
  )
}

const pluginRuntimeSyncState = $state({
  suppressionDepth: 0,
  targetSignature: null as string | null,
})
let stopPluginRuntimeSyncEffect: (() => void) | null = null

function deferPluginRuntimeSync(): () => void {
  pluginRuntimeSyncState.suppressionDepth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    pluginRuntimeSyncState.suppressionDepth = Math.max(0, pluginRuntimeSyncState.suppressionDepth - 1)
  }
}

/**
 * Keep executing plugin instances aligned with the server-backed projection.
 * The requested target (rather than only the last completed load) matters when
 * a command rolls back while the optimistic runtime reload is still in flight:
 * the rollback must queue one final load of the restored state.
 */
export function startPluginRuntimeSync(): void {
  if (!canUseClientWriteAccess() || stopPluginRuntimeSyncEffect) return
  pluginRuntimeSyncState.targetSignature ??= pluginRuntimeSignature(
    acceptedPluginRuntimeProjection(currentPluginCollectionSnapshot()),
  )
  stopPluginRuntimeSyncEffect = $effect.root(() => {
    $effect(() => {
      const signature = pluginRuntimeSignature(acceptedPluginRuntimeProjection(currentPluginCollectionSnapshot()))
      const suppressionDepth = pluginRuntimeSyncState.suppressionDepth
      const targetSignature = pluginRuntimeSyncState.targetSignature
      if (suppressionDepth > 0 || targetSignature === signature) return
      void loadPlugins().catch((error) => {
        console.error('Failed to reconcile plugin runtime:', error)
      })
    })
  })
}

/** Test/app-lifecycle cleanup for the root runtime synchronization effect. */
export function stopPluginRuntimeSync(): void {
  stopPluginRuntimeSyncEffect?.()
  stopPluginRuntimeSyncEffect = null
  pluginRuntimeSyncState.suppressionDepth = 0
  pluginRuntimeSyncState.targetSignature = null
  customProviderStore.set([])
  publishPluginRuntimeState(initialPluginRuntimeState)
}

let pluginLoadQueue: Promise<void> | null = null
let pluginLoadQueued = false

async function runQueuedPluginLoads() {
  while (pluginLoadQueued && canUseClientWriteAccess()) {
    const sessionGeneration = captureClientSessionGeneration()
    pluginLoadQueued = false
    console.log('Loading plugins...')
    const plugins = acceptedPluginRuntimeProjection(currentPluginCollectionSnapshot())
    const signature = pluginRuntimeSignature(plugins)
    customProviderStore.set([])
    publishPluginRuntimeState({ phase: 'loading', targetSignature: signature, error: null })

    try {
      for (const plugin of plugins) assertSupportedPluginApiVersion(plugin)
      await loadV3Plugins(plugins.filter((plugin) => plugin.enabled))
    } catch (error) {
      if (!canUseClientWriteAccess()) return
      if (!isClientSessionGenerationCurrent(sessionGeneration)) {
        if (pluginLoadQueued) continue
        return
      }
      const latestSignature = pluginRuntimeSignature(acceptedPluginRuntimeProjection(currentPluginCollectionSnapshot()))
      if (latestSignature !== signature) {
        pluginRuntimeSyncState.targetSignature = latestSignature
        pluginLoadQueued = true
        continue
      }
      publishPluginRuntimeState({ phase: 'error', targetSignature: signature, error })
      throw error
    }

    if (!canUseClientWriteAccess()) return
    if (!isClientSessionGenerationCurrent(sessionGeneration)) {
      if (pluginLoadQueued) continue
      return
    }
    const latestSignature = pluginRuntimeSignature(acceptedPluginRuntimeProjection(currentPluginCollectionSnapshot()))
    if (latestSignature !== signature) {
      pluginRuntimeSyncState.targetSignature = latestSignature
      pluginLoadQueued = true
      continue
    }

    customProviderStore.set(Array.from(pluginV2.providers.keys()))
    publishPluginRuntimeState({ phase: 'ready', targetSignature: signature, error: null })
  }
}

export function loadPlugins(): Promise<void> {
  if (!canUseClientWriteAccess()) return Promise.resolve()
  pluginRuntimeSyncState.targetSignature = pluginRuntimeSignature(
    acceptedPluginRuntimeProjection(currentPluginCollectionSnapshot()),
  )
  pluginLoadQueued = true
  pluginLoadQueue ??= runQueuedPluginLoads().finally(() => {
    pluginLoadQueue = null
    // A state projection can land after the queue's final loop condition but
    // before this cleanup callback. Do not strand that last requested target.
    if (pluginLoadQueued) {
      void loadPlugins().catch((error) => {
        console.error('Failed to process queued plugin runtime reload:', error)
      })
    }
  })
  return pluginLoadQueue
}

/** Explicit retry for a localized runtime reload failure after startup. */
export async function retryPluginRuntime(): Promise<boolean> {
  try {
    await loadPlugins()
    startPluginRuntimeSync()
    return true
  } catch {
    return false
  }
}

export type PluginV2ProviderArgument = {
  prompt_chat: OpenAIChat[]
  frequency_penalty: number
  min_p: number
  presence_penalty: number
  repetition_penalty: number
  top_k: number
  top_p: number
  temperature: number
  mode: string
  max_tokens: number
}

export type PluginV2ProviderOptions = {
  tokenizer?: string
  tokenizerFunc?: (content: string) => number[] | Promise<number[]>
}

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>
type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>

export const pluginV2 = {
  providers: new Map<
    string,
    (
      arg: PluginV2ProviderArgument,
      abortSignal?: AbortSignal,
    ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>
  >(),
  providerOptions: new Map<string, PluginV2ProviderOptions>(),
  editdisplay: new Set<EditFunction>(),
  editoutput: new Set<EditFunction>(),
  editprocess: new Set<EditFunction>(),
  editinput: new Set<EditFunction>(),
  replacerbeforeRequest: new Set<ReplacerFunction>(),
  replacerafterRequest: new Set<(content: string, type: string) => string | Promise<string>>(),
  chatOutput: chatOutputListeners,
  unload: new Set<() => void | Promise<void>>(),
}

export const allowedDbKeys = [
  'characters',
  'modules',
  'enabledModules',
  'moduleIntergration',
  'pluginV2',
  'personas',
  'plugins',
  'pluginCustomStorage',
  'currentPluginProvider',
  'customModels',
  'customSidebarItems',
  'globalChatVariables',
  'jailbreakToggle',
  'banCharacterset',
  'allowAllExtentionFiles',
  'auxModelUnderModelSettings',
  'pluginDevelopMode',
  'temperature',
  'askRemoval',
  'maxContext',
  'maxResponse',
  'frequencyPenalty',
  'PresensePenalty',
  'theme',
  'textTheme',
  'lineHeight',
  'seperateModelsForAxModels',
  'seperateModels',
  'customCSS',
  'guiHTML',
  'colorSchemeName',
  'selectedPersona',
  'characterOrder',
]

// Recognized database families that the plugin bridge cannot translate into
// typed commands. In server-backed (Fastify) web mode we block writes to these
// keys instead of doing a dangling projection write that no command persists,
// or shadowing the real resource inside `pluginCustomStorage`. Plugins must use
// the dedicated module/plugin/storage APIs or settings for these in server
// mode.
export const unsupportedServerBridgeKeys = new Set<string>([
  'characters',
  'characterOrder',
  'personas',
  'selectedPersona',
  'userIcon',
  'personaPrompt',
  'userNote',
  'botPresets',
  'botPresetsId',
  'promptTemplate',
  'promptSettings',
  'translatorPresets',
  'translatorPresetId',
  'loadouts',
  'lastLoadedLoadoutName',
  'loreBook',
  'loreBookPage',
  'pluginV2',
])

function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

async function setPluginStorageValue(key: string, value: unknown): Promise<void> {
  const previous = currentPluginStorageSnapshot()
  const next = currentPluginStorageOwnerSnapshot()
  next[key] = cloneJsonValue(value)
  replacePluginStorageOwner(next)
  if (canUseServerCommands()) {
    await requirePluginMutation(dispatchPutPluginStorage(key, value, previous), 'set plugin storage')
  }
}

async function deletePluginStorageValue(key: string): Promise<void> {
  const previous = currentPluginStorageSnapshot()
  const next = currentPluginStorageOwnerSnapshot()
  delete next[key]
  replacePluginStorageOwner(next)
  if (canUseServerCommands()) {
    await requirePluginMutation(dispatchDeletePluginStorage(key, previous), 'delete plugin storage')
  }
}

async function replacePluginStorage(values: Record<string, unknown>): Promise<void> {
  const previous = currentPluginStorageSnapshot()
  replacePluginStorageOwner(values)
  if (canUseServerCommands()) {
    await requirePluginMutation(dispatchBulkPluginStorage({ values, clear: true }, previous), 'replace plugin storage')
  }
}

async function requirePluginMutation(
  pending:
    | ReturnType<typeof dispatchPutPluginStorage>
    | ReturnType<typeof dispatchDeletePluginStorage>
    | ReturnType<typeof dispatchBulkPluginStorage>,
  action: string,
): Promise<void> {
  if (!pending) return
  const outcome = await pending
  if (outcome.status === 'failed') {
    throw new Error(`Failed to ${action}.`)
  }
}

async function applyPluginDatabasePatch(newDb: Record<string, unknown>, options: { full: boolean }): Promise<void> {
  const previous = currentPluginStateSnapshot()
  const previousModules = 'modules' in newDb || 'enabledModules' in newDb ? currentGlobalModuleStateSnapshot() : null
  const settingsRollback = currentPluginSettingsPatchRollbackSnapshot(newDb)
  const serverMode = canUseServerCommands()
  const settingsPatch: Record<string, unknown> = {}
  const storageValues: Record<string, unknown> = {}
  const blockedKeys: string[] = []
  const persistence: Array<Promise<{ status: 'accepted' | 'queued' | 'failed' }>> = []
  let replacedStorage: Record<string, unknown> | null = null
  const storageValuesToApply: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(newDb)) {
    if (value === undefined) {
      console.warn(
        `[plugin db bridge] Ignored undefined database value for "${key}" because undefined cannot be persisted.`,
      )
      continue
    }

    if (key === 'pluginCustomStorage') {
      replacedStorage =
        value && typeof value === 'object' && !Array.isArray(value)
          ? cloneJsonValue(value as Record<string, unknown>)
          : {}
      continue
    }

    // Recognized resource families without a bridge command: block in server
    // mode rather than writing a projection change no command will persist, or
    // shadowing the real resource in plugin storage.
    if (serverMode && unsupportedServerBridgeKeys.has(key)) {
      blockedKeys.push(key)
      continue
    }

    if (allowedDbKeys.includes(key)) {
      if (key === 'characters' && Array.isArray(value)) {
        replacePluginCharactersOwner(value as character[])
        continue
      }
      if (key === 'characterOrder' && Array.isArray(value)) {
        applyPluginCharacterPointerOwner(key, value)
        continue
      }
      if (key === 'currentChar' && Number.isInteger(value)) {
        applyPluginCharacterPointerOwner(key, value)
        continue
      }
      if (
        [
          'personas',
          'modelPresets',
          'promptPresets',
          'botPresets',
          'promptTemplate',
          'loadouts',
          'loreBook',
          'translatorPresets',
          'hypaV3Presets',
        ].includes(key)
      ) {
        ;(collectionsResourceState.values as Record<string, unknown>)[key] = cloneJsonValue(value)
        continue
      }
      if (key === 'modules' && Array.isArray(value)) {
        collectionsResourceState.values.modules = cloneJsonValue(
          value,
        ) as typeof collectionsResourceState.values.modules
        invalidateModuleRenderRevision()
      }
      if (key === 'enabledModules' && Array.isArray(value)) {
        ;(settingsResourceState.value as Record<string, unknown>).enabledModules = cloneJsonValue(value)
        invalidateModuleRenderRevision()
      }
      if (key === 'plugins' && Array.isArray(value)) {
        replacePluginCollectionOwner(value as RisuPlugin[])
      }
      const mirroredPresetOutcome = mirrorTopLevelPresetFieldWithOutcome(key, value)
      if (mirroredPresetOutcome) {
        persistence.push(mirroredPresetOutcome)
      } else if (key === 'currentPluginProvider' && typeof value === 'string') {
        applyPluginProviderOwner(value)
        const pending = dispatchSelectPluginProvider(value, previous)
        if (pending) persistence.push(pending)
      } else if (key === 'plugins' && Array.isArray(value)) {
        persistence.push(dispatchPluginCollectionPatch(value as RisuPlugin[], previous))
      } else if (key === 'modules' && Array.isArray(value) && previousModules) {
        const pending = dispatchModuleCollectionPatch(value as RisuModule[], previousModules)
        if (pending) {
          persistence.push(
            pending.then((outcome) => ({
              status:
                outcome.status === 'ok' ? ('accepted' as const) : outcome.status === 'retained' ? 'queued' : 'failed',
            })),
          )
        }
      } else if (key === 'enabledModules' && Array.isArray(value) && previousModules) {
        const moduleSource = Array.isArray(newDb.modules) ? (newDb.modules as RisuModule[]) : previousModules.modules
        const pending = dispatchEnabledModulesPatch(value, previousModules, moduleSource ?? [])
        if (pending) {
          persistence.push(
            pending.then((outcome) => ({
              status:
                outcome.status === 'ok' ? ('accepted' as const) : outcome.status === 'retained' ? 'queued' : 'failed',
            })),
          )
        }
      } else {
        settingsPatch[key] = value
        applyPluginSettingsOwnerPatch({ [key]: value })
      }
      continue
    }

    storageValues[key] = cloneJsonValue(value)
    storageValuesToApply[key] = cloneJsonValue(value)
  }

  if (replacedStorage) {
    replacePluginStorageOwner({ ...replacedStorage, ...storageValuesToApply })
  } else if (Object.keys(storageValuesToApply).length > 0) {
    replacePluginStorageOwner({ ...currentPluginStorageOwnerSnapshot(), ...storageValuesToApply })
  }

  if (replacedStorage) {
    const storagePrevious = previous.pluginCustomStorage
    const pending = dispatchBulkPluginStorage(
      { values: { ...replacedStorage, ...storageValues }, clear: true },
      storagePrevious,
    )
    if (pending) persistence.push(pending)
  } else if (Object.keys(storageValues).length > 0) {
    const pending = dispatchBulkPluginStorage({ values: storageValues }, previous.pluginCustomStorage)
    if (pending) persistence.push(pending)
  }

  if (Object.keys(settingsPatch).length > 0) {
    persistence.push(dispatchPluginSettingsPatch(settingsPatch, settingsRollback))
  }

  if (blockedKeys.length > 0) {
    console.warn(
      '[plugin db bridge] Ignored unsupported database keys in server-backed mode: ' +
        `${blockedKeys.join(', ')}. Use the dedicated plugin/module/storage APIs or settings instead.`,
    )
  }

  void options

  const outcomes = await Promise.all(persistence)
  if (outcomes.some((outcome) => outcome.status === 'failed')) {
    throw new Error('One or more plugin database changes could not be saved.')
  }
}

type PluginRuntimeCleanupRegistrar = (cleanup: () => void) => void

interface TrackedPluginEventListener {
  target: EventTarget
  type: string
  listener: EventListenerOrEventListenerObject
  wrapped: EventListener
  options?: boolean | AddEventListenerOptions
  capture: boolean
  unregister: () => void
}

/**
 * Revokes callbacks created through deprecated compatibility methods exposed
 * by the V3 host when its load generation ends. Timers, listeners, and API
 * closures must not keep operating after disable/reload.
 */
class PluginRuntimeLifecycle {
  private readonly timeouts = new Set<ReturnType<typeof globalThis.setTimeout>>()
  private readonly intervals = new Set<ReturnType<typeof globalThis.setInterval>>()
  private readonly eventListeners = new Set<TrackedPluginEventListener>()

  private readonly sessionGeneration = captureClientSessionGeneration()
  private disposed = false
  private readonly guardedCallbacks = new WeakMap<Function, Function>()
  private readonly registrationCleanups = new Set<() => void>()

  constructor(private readonly assertActive?: () => void) {}

  guardCallback<T extends Function>(callback: T): T {
    let guarded = this.guardedCallbacks.get(callback)
    if (!guarded) {
      guarded = (...args: unknown[]) => {
        this.assertCurrent()
        const result = callback(...args)
        if (result instanceof Promise)
          return result.then((value) => {
            this.assertCurrent()
            return value
          })
        return result
      }
      this.guardedCallbacks.set(callback, guarded)
    }
    return guarded as T
  }

  trackRegistration(cleanup: () => void): void {
    this.registrationCleanups.add(cleanup)
  }

  guardObject<T extends object>(object: T): T {
    return new Proxy(object, {
      get: (target, key) => {
        this.assertCurrent()
        const value = Reflect.get(target, key, target)
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              this.assertCurrent()
              return value.apply(target, args)
            }
          : value
      },
    })
  }

  assertCurrent = (): void => {
    assertClientWriteAccess()
    if (this.disposed || !isClientSessionGenerationCurrent(this.sessionGeneration))
      throw new Error('Plugin client session is no longer active.')
    this.assertActive?.()
  }

  private isCurrent(): boolean {
    try {
      this.assertCurrent()
      return true
    } catch {
      return false
    }
  }

  setTimeout = (
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ): ReturnType<typeof globalThis.setTimeout> => {
    this.assertCurrent()
    if (typeof handler !== 'function') {
      throw new TypeError('Plugin timer handlers must be functions.')
    }

    let handle: ReturnType<typeof globalThis.setTimeout>
    handle = globalThis.setTimeout(() => {
      this.timeouts.delete(handle)
      if (!this.isCurrent()) return
      handler.apply(globalThis, args)
    }, timeout)
    this.timeouts.add(handle)
    return handle
  }

  setInterval = (
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ): ReturnType<typeof globalThis.setInterval> => {
    this.assertCurrent()
    if (typeof handler !== 'function') {
      throw new TypeError('Plugin timer handlers must be functions.')
    }

    let handle: ReturnType<typeof globalThis.setInterval>
    handle = globalThis.setInterval(() => {
      if (!this.isCurrent()) {
        globalThis.clearInterval(handle)
        this.intervals.delete(handle)
        return
      }
      handler.apply(globalThis, args)
    }, timeout)
    this.intervals.add(handle)
    return handle
  }

  clearTimeout = (handle?: ReturnType<typeof globalThis.setTimeout>): void => {
    if (handle === undefined) return
    this.timeouts.delete(handle)
    globalThis.clearTimeout(handle)
  }

  clearInterval = (handle?: ReturnType<typeof globalThis.setInterval>): void => {
    if (handle === undefined) return
    this.intervals.delete(handle)
    globalThis.clearInterval(handle)
  }

  addEventListener = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
    register?: (wrapped: EventListener) => void,
    unregister?: (wrapped: EventListener) => void,
  ): void => {
    this.assertCurrent()
    if (!listener) return

    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
    const existing = Array.from(this.eventListeners).find(
      (entry) =>
        entry.target === target && entry.type === type && entry.listener === listener && entry.capture === capture,
    )
    if (existing) return

    const entry = {} as TrackedPluginEventListener
    const wrapped: EventListener = (event) => {
      if (!this.isCurrent()) {
        this.removeTrackedEventListener(entry)
        return
      }
      if (typeof options === 'object' && options.once) {
        this.eventListeners.delete(entry)
      }
      if (typeof listener === 'function') {
        listener.call(target, event)
      } else {
        listener.handleEvent(event)
      }
    }
    Object.assign(entry, {
      target,
      type,
      listener,
      wrapped,
      options,
      capture,
      unregister: () => (unregister ? unregister(wrapped) : target.removeEventListener(type, wrapped, options)),
    })
    if (register) register(wrapped)
    else target.addEventListener(type, wrapped, options)
    this.eventListeners.add(entry)
  }

  removeEventListener = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void => {
    if (!listener) return
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false)
    const entry = Array.from(this.eventListeners).find(
      (candidate) =>
        candidate.target === target &&
        candidate.type === type &&
        candidate.listener === listener &&
        candidate.capture === capture,
    )
    if (entry) this.removeTrackedEventListener(entry)
  }

  private removeTrackedEventListener(entry: TrackedPluginEventListener): void {
    this.eventListeners.delete(entry)
    entry.unregister()
  }

  dispose = (): void => {
    this.disposed = true
    for (const cleanup of this.registrationCleanups) cleanup()
    this.registrationCleanups.clear()
    for (const handle of this.timeouts) globalThis.clearTimeout(handle)
    for (const handle of this.intervals) globalThis.clearInterval(handle)
    for (const entry of Array.from(this.eventListeners)) this.removeTrackedEventListener(entry)
    this.timeouts.clear()
    this.intervals.clear()
  }
}

function mergeInstalledPluginsWithApprovedCandidates(
  installedPlugins: readonly RisuPlugin[],
  approvedCandidates: readonly RisuPlugin[],
): RisuPlugin[] {
  // `handlePluginInstallViaPlugin` returns only candidates that needed consent.
  // Treat them as an upsert set, never as the complete desired collection.
  const merged = [...installedPlugins]
  const indexByName = new Map(merged.map((plugin, index) => [plugin.name, index]))

  for (const candidate of approvedCandidates) {
    const existingIndex = indexByName.get(candidate.name)
    if (existingIndex === undefined) {
      indexByName.set(candidate.name, merged.length)
      merged.push(candidate)
    } else {
      merged[existingIndex] = candidate
    }
  }

  return merged
}

export const getV2PluginAPIs = (
  plugin?: Pick<RisuPlugin, 'name' | 'script'>,
  assertActive?: () => void,
  registerCleanup?: PluginRuntimeCleanupRegistrar,
) => {
  const lifecycle = new PluginRuntimeLifecycle(assertActive)
  registerCleanup?.(lifecycle.dispose)
  const guardedSafeDocument = {
    ...SafeDocument,
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) =>
      lifecycle.addEventListener(
        document,
        type,
        listener,
        options,
        (wrapped) => SafeDocument.addEventListener(type, wrapped, options),
        (wrapped) => SafeDocument.removeEventListener(type, wrapped, options),
      ),
    removeEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => lifecycle.removeEventListener(document, type, listener, options),
  }
  const networkAccess = createPluginNetworkAccess(
    plugin,
    {
      risuFetch: pluginGlobalFetch,
      nativeFetch: pluginFetchNative,
    },
    undefined,
    lifecycle.assertCurrent,
  )
  const webFetch = createPluginWebFetch(networkAccess)
  let pluginApis: any
  pluginApis = {
    risuFetch: networkAccess.risuFetch,
    nativeFetch: networkAccess.nativeFetch,
    fetch: webFetch,
    BlockedPluginNetworkPrimitive,
    safeNavigator: SafePluginNavigator,
    safeLocation: SafePluginLocation,
    getArg: (arg: string) => {
      const [name, realArg] = arg.split('::')
      const matches = currentPluginCollectionSnapshot().filter((candidate) => candidate.name === name)
      if (matches.length !== 1) return undefined
      return matches[0].realArg?.[realArg]
    },
    getChar: () => {
      const index = get(selectedCharID)
      return currentPluginCharacterSnapshot(index)
    },
    setChar: (char: any) => {
      lifecycle.assertCurrent()
      const charIndex = get(selectedCharID)
      const previousCharacter = currentPluginCharacterSnapshot(charIndex)
      if (!previousCharacter?.chaId) return Promise.resolve(null)
      if (!canUseServerCommands()) {
        replacePluginCharacterOwnerAt(charIndex, previousCharacter.chaId, char)
        return Promise.resolve(null)
      }

      assertNoUnsupportedCharacterChanges(previousCharacter, char, 'setChar')
      const previous = currentCharacterRowSnapshot(charIndex)
      const preparation = prepareCompatibleCharacterUpdateScoped(previousCharacter, char, previous)
      const optimisticCharacter = preparation.optimisticCharacter
      if (!optimisticCharacter || preparation.factories.length === 0) return Promise.resolve(null)
      if (!replacePluginCharacterOwnerAt(charIndex, previousCharacter.chaId, optimisticCharacter)) {
        return Promise.resolve(null)
      }
      return preparation.dispatchAsync().then((outcome) => {
        lifecycle.assertCurrent()
        return outcome
      })
    },
    addProvider: (
      name: string,
      func: (
        arg: PluginV2ProviderArgument,
        abortSignal?: AbortSignal,
      ) => Promise<{ success: boolean; content: string }>,
      options?: PluginV2ProviderOptions,
    ) => {
      lifecycle.assertCurrent()
      const guarded = lifecycle.guardCallback(func)
      pluginV2.providers.set(name, guarded)
      lifecycle.trackRegistration(() => {
        if (pluginV2.providers.get(name) !== guarded) return
        pluginV2.providers.delete(name)
        pluginV2.providerOptions.delete(name)
      })
      pluginV2.providerOptions.set(name, options ?? {})
      customProviderStore.set(Array.from(pluginV2.providers.keys()))
    },
    addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
      lifecycle.assertCurrent()
      if (pluginV2['edit' + name]) {
        const handlers = pluginV2['edit' + name]
        const guarded = lifecycle.guardCallback(func)
        handlers.add(guarded)
        lifecycle.trackRegistration(() => handlers.delete(guarded))
      } else {
        throw `script handler named ${name} not found`
      }
    },
    removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
      lifecycle.assertCurrent()
      if (pluginV2['edit' + name]) {
        pluginV2['edit' + name].delete(lifecycle.guardCallback(func))
      } else {
        throw `script handler named ${name} not found`
      }
    },
    addRisuReplacer: (name: string, func: ReplacerFunction) => {
      lifecycle.assertCurrent()
      if (pluginV2['replacer' + name]) {
        const handlers = pluginV2['replacer' + name]
        const guarded = lifecycle.guardCallback(func)
        handlers.add(guarded)
        lifecycle.trackRegistration(() => handlers.delete(guarded))
      } else {
        throw `replacer handler named ${name} not found`
      }
    },
    removeRisuReplacer: (name: string, func: ReplacerFunction) => {
      lifecycle.assertCurrent()
      if (pluginV2['replacer' + name]) {
        pluginV2['replacer' + name].delete(lifecycle.guardCallback(func))
      } else {
        throw `replacer handler named ${name} not found`
      }
    },
    addRisuChatListener: (mode: string, func: ChatOutputListener) => {
      lifecycle.assertCurrent()
      const guarded = lifecycle.guardCallback(func)
      addChatOutputListener(mode, guarded)
      lifecycle.trackRegistration(() => removeChatOutputListener(mode, guarded))
    },
    removeRisuChatListener: (mode: string, func: ChatOutputListener) => {
      lifecycle.assertCurrent()
      removeChatOutputListener(mode, lifecycle.guardCallback(func))
    },
    onUnload: (func: () => void | Promise<void>) => {
      lifecycle.assertCurrent()
      const guarded = lifecycle.guardCallback(func)
      pluginV2.unload.add(guarded)
      lifecycle.trackRegistration(() => pluginV2.unload.delete(guarded))
    },
    setArg: (arg: string, value: string | number) => {
      lifecycle.assertCurrent()
      const [name, realArg] = arg.split('::')
      const previous = currentPluginStateSnapshot()
      const plugins = currentPluginCollectionSnapshot()
      const matches = plugins.map((plugin, index) => ({ plugin, index })).filter(({ plugin }) => plugin.name === name)
      if (matches.length === 1) {
        const [{ plugin, index }] = matches
        const nextPlugin = {
          ...plugin,
          realArg: { ...(plugin.realArg ?? {}), [realArg]: value },
        }
        plugins[index] = nextPlugin
        replacePluginCollectionOwner(plugins)
        const pending = dispatchUpdatePlugin(plugin.name, { realArg: nextPlugin.realArg }, previous)
        if (pending) {
          return pending.then((outcome) => {
            lifecycle.assertCurrent()
            return outcome
          })
        }
      }
      return Promise.resolve(null)
    },
    safeGlobalThis: {} as any,
    getSafeGlobalThis: () => {
      if (Object.keys(pluginApis.safeGlobalThis).length > 0) {
        return pluginApis.safeGlobalThis
      }
      const keys = Object.keys(globalThis)
      const safeGlobal: any = {}
      const allowedKeys = ['console', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams']
      for (const key of keys) {
        if (allowedKeys.includes(key)) {
          safeGlobal[key] = (globalThis as any)[key]
        }
      }

      //compatibility layer with old unsafe APIs

      //from PBV2
      safeGlobal.showDirectoryPicker = window.showDirectoryPicker

      safeGlobal.setInterval = lifecycle.setInterval
      safeGlobal.setTimeout = lifecycle.setTimeout
      safeGlobal.clearInterval = lifecycle.clearInterval
      safeGlobal.clearTimeout = lifecycle.clearTimeout
      safeGlobal.alert = globalThis.alert
      safeGlobal.confirm = globalThis.confirm
      safeGlobal.prompt = globalThis.prompt
      safeGlobal.innerWidth = window.innerWidth
      safeGlobal.innerHeight = window.innerHeight
      safeGlobal.getComputedStyle = window.getComputedStyle
      safeGlobal.navigator = pluginApis.safeNavigator
      safeGlobal.location = pluginApis.safeLocation
      safeGlobal.localStorage = pluginApis.safeLocalStorage
      safeGlobal.indexedDB = pluginApis.safeIdbFactory
      safeGlobal.__pluginApis__ = pluginApis
      safeGlobal.Object = Object
      safeGlobal.Array = Array
      safeGlobal.String = String
      safeGlobal.Number = Number
      safeGlobal.Boolean = Boolean
      safeGlobal.Math = Math
      safeGlobal.Date = Date
      safeGlobal.RegExp = RegExp
      safeGlobal.Error = Error
      safeGlobal.Function = pluginApis.SafeFunction
      safeGlobal.document = pluginApis.safeDocument
      safeGlobal.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => lifecycle.addEventListener(window, type, listener, options)
      safeGlobal.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => lifecycle.removeEventListener(window, type, listener, options)
      return safeGlobal
    },
    safeLocalStorage: lifecycle.guardObject(new SafeLocalStorage()),
    safeIdbFactory: lifecycle.guardObject(SafeIdbFactory),
    safeDocument: guardedSafeDocument,
    alertStore: {
      set: (msg: string) => {},
    },
    apiVersion: '2.1',
    apiVersionCompatibleWith: ['2.0', '2.1'],
    getDatabase: () => {
      lifecycle.assertCurrent()
      const db = currentPluginDatabaseSnapshot() as Record<string, any>
      return new Proxy(db, {
        get(target, prop) {
          if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
            return (target as any)[prop]
          } else if (typeof prop === 'string' && canUseServerCommands() && unsupportedServerBridgeKeys.has(prop)) {
            return undefined
          } else if (target.pluginCustomStorage) {
            return target.pluginCustomStorage[prop.toString()]
          }
          return undefined
        },
        set(target, prop, value) {
          lifecycle.assertCurrent()
          if (typeof prop === 'string' && allowedDbKeys.includes(prop)) {
            if (canUseServerCommands() && unsupportedServerBridgeKeys.has(prop)) {
              void applyPluginDatabasePatch({ [prop]: value }, { full: false }).catch((error) => {
                console.error('Plugin database property save failed:', error)
              })
            } else {
              ;(target as any)[prop] = cloneJsonValue(value)
              void applyPluginDatabasePatch({ [prop]: value }, { full: false }).catch((error) => {
                console.error('Plugin database property save failed:', error)
              })
            }
            return true
          } else if (typeof prop === 'string' && canUseServerCommands() && unsupportedServerBridgeKeys.has(prop)) {
            // Recognized resource family with no bridge command: route through
            // applyPluginDatabasePatch so it is blocked + warned instead of
            // being silently shadowed in plugin storage.
            void applyPluginDatabasePatch({ [prop]: value }, { full: false }).catch((error) => {
              console.error('Plugin database property save failed:', error)
            })
            return true
          } else {
            target.pluginCustomStorage ??= {}
            target.pluginCustomStorage[prop.toString()] = cloneJsonValue(value)
            void setPluginStorageValue(prop.toString(), value).catch((error) => {
              console.error('Plugin storage property save failed:', error)
            })
            return true
          }
        },
        ownKeys(target) {
          const keys = new Set(
            Reflect.ownKeys(target).filter((key) => typeof key === 'string' && allowedDbKeys.includes(key)),
          )
          if (target.pluginCustomStorage) {
            for (const key of Object.keys(target.pluginCustomStorage)) {
              if (!canUseServerCommands() || !unsupportedServerBridgeKeys.has(key)) keys.add(key)
            }
          }
          return [...keys]
        },
        getOwnPropertyDescriptor(target, prop) {
          if (typeof prop !== 'string') {
            return Reflect.getOwnPropertyDescriptor(target, prop)
          }
          if (allowedDbKeys.includes(prop)) {
            return Reflect.getOwnPropertyDescriptor(target, prop)
          }
          if (canUseServerCommands() && unsupportedServerBridgeKeys.has(prop)) {
            return undefined
          }
          if (target.pluginCustomStorage && prop in target.pluginCustomStorage) {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: target.pluginCustomStorage[prop],
            }
          }
          return undefined
        },
        deleteProperty(target, prop) {
          console.log('Attempt to delete db.' + String(prop) + ' denied in safe database proxy.')
          return false
        },
        getPrototypeOf(target) {
          return Reflect.getPrototypeOf(target)
        },
      })
    },
    pluginStorage: {
      getItem: (key: string) => {
        const value = currentPluginStorageValueOwner(key)
        return value == null ? null : safeStructuredClone(value)
      },
      setItem: (key: string, value: string) => {
        lifecycle.assertCurrent()
        return setPluginStorageValue(key, value)
      },
      removeItem: (key: string) => {
        lifecycle.assertCurrent()
        return deletePluginStorageValue(key)
      },
      clear: () => {
        lifecycle.assertCurrent()
        return replacePluginStorage({})
      },
      key: (index: number) => {
        const keys = Object.keys(currentPluginStorageOwnerSnapshot())
        return keys[index] || null
      },
      keys: () => {
        return Object.keys(currentPluginStorageOwnerSnapshot())
      },
      length: () => {
        return Object.keys(currentPluginStorageOwnerSnapshot()).length
      },
    },
    isDeviceLocalPluginStorageEnabled,
    setDatabaseLite: (newDb: any) => {
      lifecycle.assertCurrent()
      const pending = applyPluginDatabasePatch(newDb, { full: false })
      // Legacy V2.1 scripts commonly ignored this historically synchronous
      // return value. Keep those calls from becoming unhandled rejections while
      // still returning the rejecting Promise to callers that correctly await.
      void pending.catch(() => undefined)
      return pending
    },
    setDatabase: async (newDb: any) => {
      lifecycle.assertCurrent()
      let databasePatch = newDb
      for (const key of Object.keys(newDb)) {
        if (key === 'plugins') {
          console.warn(
            '[WARN] Plugin attempted to access plugin directly. this would be blocked in future versions. Instead, use the provided APIs to manage plugins. Attempting to handle plugin installation via plugin for new plugins in the provided database object.',
          )
          const approvedCandidates = await handlePluginInstallViaPlugin(newDb.plugins, lifecycle.assertCurrent)
          lifecycle.assertCurrent()
          databasePatch = {
            ...newDb,
            plugins: mergeInstalledPluginsWithApprovedCandidates(currentPluginCollectionSnapshot(), approvedCandidates),
          }
        }
      }
      lifecycle.assertCurrent()
      await applyPluginDatabasePatch(databasePatch, { full: true })
    },
    SafeFunction: new Proxy(Function, {
      construct(target, args) {
        return function () {
          return pluginApis.getSafeGlobalThis()
        }
      },
      apply(target, thisArg, args) {
        return function () {
          return pluginApis.getSafeGlobalThis()
        }
      },
    }),
    loadPlugins: () => {
      lifecycle.assertCurrent()
      return loadPlugins()
    },
    readImage: (path: string) => {
      if (path.startsWith('assets/')) {
        // Normalize the supported `assets/` prefix before validating the asset id.
        path = path.slice(7)
      }
      if (path.includes('/') || path.includes('\\')) {
        throw new Error("readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.")
      }
      // Re-add the canonical prefix expected by `readImage`.
      return readImage('assets/' + path)
    },
    saveAsset: (data: Uint8Array) => {
      lifecycle.assertCurrent()
      // plugin V2 bridge API has no extension hint;
      // plugins that need an honest extension should use the V3 API which
      // accepts a filename.
      return saveAsset(data)
    },
  }
  return pluginApis
}

export async function translatorPlugin(text: string, from: string, to: string) {
  return false
}

export async function pluginProcess(
  arg:
    | {
        prompt_chat: OpenAIChat
        temperature: number
        max_tokens: number
        presence_penalty: number
        frequency_penalty: number
        bias: { [key: string]: string }
      }
    | {},
) {
  return {
    success: false,
    content: language.pluginProviderNotFound,
  }
}

export async function handlePluginInstallViaPlugin(plugins: RisuPlugin[], assertActive?: () => void) {
  const trimmedPlugins: RisuPlugin[] = []
  for (const plugin of plugins) {
    assertActive?.()
    assertSupportedPluginApiVersion(plugin)
    if (
      !currentPluginCollectionSnapshot().some((p: RisuPlugin) => p.name === plugin.name && p.script === plugin.script)
    ) {
      const confirmation = await alertConfirm(language.confirmInstallPluginViaPlugin.replace('{plugin}', plugin.name))
      assertActive?.()
      if (confirmation) {
        trimmedPlugins.push(plugin)
      }
    } else {
      console.warn(`Plugin "${plugin.name}" already exists, skipping installation via plugin.`)
    }
  }

  return trimmedPlugins
}

// The connected reader never starts or retains the writer plugin runtime.
clientSessionStore.subscribe(() => {
  if (!isClientReadOnly()) return
  pluginLoadQueued = false
  stopPluginRuntimeSync()
})
