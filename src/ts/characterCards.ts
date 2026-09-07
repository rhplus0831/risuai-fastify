import { captureClientSessionGeneration } from './clientSession'
import { awaitClientWriteOperation, isClientWriteOperationCurrent } from './clientWriteOperation'
import {
  alertCardExport,
  alertClear,
  alertConfirm,
  alertError,
  alertInput,
  alertNormal,
  alertProgress,
  alertStore,
  alertRealmTerms,
  alertWait,
} from './alert'
import {
  defaultSdDataFunc,
  type character,
  type customscript,
  type loreSettings,
  type loreBook,
  type triggerscript,
  importPreset,
  appVer,
} from './storage/database.svelte'
import { checkNullish, decryptBuffer, isKnownUri, sleep } from './util'
import { selectFileByDom } from './filePicker'
// @ts-ignore - resolved by Vite bundler path mapping
import { language } from 'src/lang'
import { v4 as uuidv4, v4 } from 'uuid'
import { changeChar, characterFormatUpdate } from './characters'
import {
  AppendableBuffer,
  BlankWriter,
  checkCharOrder,
  downloadFile,
  loadAsset,
  LocalWriter,
  readImage,
  saveAsset,
  saveAssets,
  VirtualWriter,
} from './globalApi.svelte'
import { getNodeServerProxyAuth } from './storage/fastifyStorage'
import { compressImage, getImageType } from './media'
import { SettingsMenuIndex, selectedCharID, settingsOpen } from './stores.svelte'
import { hasher } from './parser/parser.svelte'
import { type CharacterCardV3, type LorebookEntry } from '@risuai/ccardlib'
import { reencodeImage } from './process/files/inlays'
import { PngChunk } from './pngChunk'
import type { OnnxModelFiles } from './process/transformers'
import { CharXImporter, CharXWriter, DEFAULT_CHARX_MAX_ENTRY_SIZE_BYTES } from './process/processzip'
import {
  exportModule,
  importRisuModuleData,
  importRisuModuleObject,
  readModule,
  type RisuModule,
} from './process/modules'
import {
  applyCharacterCreateOptimistically,
  currentCharacterStateSnapshot,
  dispatchCreateCharacter,
  type CharacterMutationOutcome,
} from './characterCommands'
import {
  importRealmCharacterFromServer,
  type ServerRealmImportProgress,
  type ServerRealmImportResult,
} from './server/realmImport'
import {
  importLocalCharacterFileFromServer,
  type ServerLocalCharacterImportResult,
  type LocalFileImportProgress,
} from './server/localFileImport'
import { refreshServerRealmImportResources } from './server/resourceRefresh'
import { sanitizeHubAdditionalHtml } from './hubAdditionalHtml'
import { ensureClientLorebookEntryIds } from './server/lorebookOwner.svelte'
import {
  ensureClientScriptDefinitionIds,
  ensureClientTriggerDefinitionIds,
} from './server/scriptDefinitionOwner.svelte'
import { serverAssetIdFromReference } from './server/assets'
import {
  charactersResourceState,
  getCharacterResourceOwner,
  settingsResourceState,
} from './server/resourceState.svelte'
import { showRealmInfoStore } from './realmInfoStore'
import type { hubType } from './types/risuHub'

export { showRealmInfoStore } from './realmInfoStore'
export type { hubType } from './types/risuHub'

export const hubURL = '/api/v1/hub'
export interface CharacterImportProcessOptions {
  charXMaxEntrySizeBytes?: number
  dataUriMaxBase64Length?: number
  /** Preserve the initiating import across nested browser parser work. */
  sourceGeneration?: number
}

export interface CharacterImportCompletenessReport {
  droppedArchiveEntries: string[]
  droppedInlineAssets: Array<{ index: number; name: string }>
}

export type CharacterImportOutcome =
  | (Extract<CharacterMutationOutcome, { status: 'accepted' }> & { characterId: string })
  | Exclude<CharacterMutationOutcome, { status: 'accepted' }>

function createCharacterImportCompletenessReport(): CharacterImportCompletenessReport {
  return { droppedArchiveEntries: [], droppedInlineAssets: [] }
}

function hasDroppedCharacterContent(report: CharacterImportCompletenessReport): boolean {
  return report.droppedArchiveEntries.length > 0 || report.droppedInlineAssets.length > 0
}

function wasArchiveEntryDropped(report: CharacterImportCompletenessReport, fileName: string): boolean {
  return report.droppedArchiveEntries.includes(fileName)
}

function characterImportCompletenessMessage(report: CharacterImportCompletenessReport, imported: boolean): string {
  const details = [
    ...report.droppedArchiveEntries.map((fileName) => language.characterImportDroppedArchiveEntry(fileName)),
    ...report.droppedInlineAssets.map(({ index, name }) => language.characterImportDroppedInlineAsset(index, name)),
  ]
    .map((detail) => `- ${detail}`)
    .join('\n')
  return imported
    ? language.characterImportIncomplete(details)
    : language.characterImportFailedAfterDroppedContent(details)
}

function rewritePrebuiltAssetExcludeReference(risuai: unknown, sourceReference: string, targetReference: string): void {
  if (!risuai || typeof risuai !== 'object') return
  const extension = risuai as { prebuiltAssetExclude?: unknown }
  if (!Array.isArray(extension.prebuiltAssetExclude)) return
  extension.prebuiltAssetExclude = extension.prebuiltAssetExclude.map((reference) =>
    reference === sourceReference ? targetReference : reference,
  )
}

function normalizeImportedPrebuiltAssetExcludes(
  value: unknown,
  additionalAssets: readonly [string, string, string][],
  importedAssetReferences: ReadonlyMap<string, string>,
): string[] {
  if (!Array.isArray(value)) return []

  const availableAssetIds = new Set(additionalAssets.map((asset) => asset[1]))
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const reference of value) {
    if (typeof reference !== 'string') continue
    const canonicalReference = serverAssetIdFromReference(reference)
    const assetId =
      importedAssetReferences.get(reference) ??
      (availableAssetIds.has(reference)
        ? reference
        : canonicalReference && availableAssetIds.has(canonicalReference)
          ? canonicalReference
          : undefined)
    if (!assetId || seen.has(assetId)) continue
    seen.add(assetId)
    normalized.push(assetId)
  }
  return normalized
}

export async function authenticatedHubFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('risu-auth', await getNodeServerProxyAuth())
  return fetch(input, { ...init, headers })
}

async function appendImportedCharacter(
  character: character,
  previous: ReturnType<typeof currentCharacterStateSnapshot>,
  sourceGeneration: number,
): Promise<CharacterImportOutcome> {
  if (!isClientWriteOperationCurrent(sourceGeneration)) return { status: 'failed', result: { status: 'unavailable' } }
  normalizeImportedCharacterIdentities(character)
  const characterId = character.chaId
  applyCharacterCreateOptimistically(character)
  const outcome = await dispatchCreateCharacter(character, previous)
  return outcome.status === 'accepted' ? { ...outcome, characterId } : outcome
}

function reportCharacterImportOutcome(
  outcome: CharacterImportOutcome,
  completenessReport = createCharacterImportCompletenessReport(),
): CharacterImportOutcome {
  if (outcome.status === 'accepted') {
    if (hasDroppedCharacterContent(completenessReport)) {
      alertError(characterImportCompletenessMessage(completenessReport, true))
    } else {
      alertNormal(language.importedCharacter)
    }
  } else if (outcome.status === 'queued') {
    if (hasDroppedCharacterContent(completenessReport)) {
      alertError(`${characterImportCompletenessMessage(completenessReport, true)}\n\n${language.characterImportQueued}`)
    } else {
      alertNormal(language.characterImportQueued)
    }
  } else {
    const detail = outcome.result.status === 'error' ? outcome.result.error : ''
    alertError(detail ? `${language.characterImportFailed}\n${detail}` : language.characterImportFailed)
  }
  return outcome
}

function normalizeImportedCharacterIdentities(character: character): void {
  ensureClientLorebookEntryIds(character.globalLore ?? (character.globalLore = []))

  const chatIds = new Set<string>()
  for (const chat of character.chats ?? []) {
    chat.fmIndex ??= character.firstMsgIndex ?? -1
    let chatId = typeof chat.id === 'string' && chat.id.trim() ? chat.id : ''
    if (!chatId || chatIds.has(chatId)) {
      do {
        chatId = v4()
      } while (chatIds.has(chatId))
      chat.id = chatId
    }
    chatIds.add(chatId)
    ensureClientLorebookEntryIds(chat.localLore ?? (chat.localLore = []))
  }

  character.customscript = ensureClientScriptDefinitionIds(character.customscript ?? [])
  character.triggerscript = ensureClientTriggerDefinitionIds(character.triggerscript ?? [])
}

export async function importCharacter(): Promise<CharacterImportOutcome | null | undefined> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return null
  try {
    const files = await selectFileByDom(['*'], 'multiple')
    if (!isCurrent() || !files) {
      return
    }

    let outcome: CharacterImportOutcome | null = null
    for (const f of files) {
      const nextOutcome = await importCharacterFile(f, f.name)
      if (nextOutcome) outcome = nextOutcome
      if (!isCurrent()) return outcome
      checkCharOrder()
    }
    return outcome
  } catch (error) {
    if (!isCurrent()) return null
    alertError(error as Error)
    return {
      status: 'failed',
      result: {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        reason: 'invalid-request',
      },
    }
  }
}

export async function importCharacterFile(
  file: Blob,
  fileName = file instanceof File ? file.name : 'character.png',
): Promise<CharacterImportOutcome | null> {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return null
  const onProgress = (progress: LocalFileImportProgress) => {
    if (isCurrent()) showLocalCharacterImportProgress(progress, fileName)
  }
  onProgress({ phase: 'prepare' })
  let result = await importLocalCharacterFileFromServer({ file, fileName, onProgress })
  let pendingImportToken: string | undefined
  let password: string | undefined
  let allowLowLevelAccess = false

  while (result.status === 'password-required' || result.status === 'low-level-access') {
    if (!isCurrent()) return null
    pendingImportToken = result.pendingImportToken
    alertClear()
    if (result.status === 'password-required') {
      const entered = await alertInput(language.inputCardPassword)
      if (!isCurrent()) return null
      if (!entered) {
        alertClear()
        return null
      }
      password = entered
    } else {
      const confirmed = await alertConfirm(language.lowLevelAccessConfirm)
      if (!isCurrent()) return null
      if (!confirmed) {
        alertClear()
        return null
      }
      allowLowLevelAccess = true
    }
    onProgress({ phase: 'processing' })
    result = await importLocalCharacterFileFromServer({
      pendingImportToken,
      password,
      allowLowLevelAccess,
      onProgress,
    })
  }

  if (!isCurrent()) return result.status === 'ok' ? localCharacterImportOutcome(result) : null
  if (result.status === 'password-invalid') {
    alertError(language.errors.wrongPassword)
    return null
  }
  const outcome = localCharacterImportOutcome(result)
  return reportCharacterImportOutcome(
    outcome,
    result.status === 'ok'
      ? {
          droppedArchiveEntries: result.importReport.droppedArchiveEntries,
          droppedInlineAssets: result.importReport.droppedInlineAssets,
        }
      : undefined,
  )
}

function showLocalCharacterImportProgress(progress: LocalFileImportProgress, fileName: string) {
  const labels = language.characterImportProgress
  const completedBytes = 'completedBytes' in progress ? progress.completedBytes : undefined
  const totalBytes = 'totalBytes' in progress ? progress.totalBytes : undefined
  const percent =
    completedBytes !== undefined && totalBytes && totalBytes > 0
      ? Math.min(100, (completedBytes / totalBytes) * 100)
      : null
  const detail = [fileName]
  if (completedBytes !== undefined) {
    const formatBytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
    detail.push(
      totalBytes === undefined
        ? formatBytes(completedBytes)
        : `${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}`,
    )
  }
  if ('completedAssets' in progress && progress.completedAssets !== undefined) {
    detail.push(labels.assetsSaved.replace('{{count}}', String(progress.completedAssets)))
  }
  alertProgress(labels[progress.phase], percent, detail.join('\n'))
}

function localCharacterImportOutcome(result: ServerLocalCharacterImportResult): CharacterImportOutcome {
  if (result.status === 'ok') {
    return {
      status: 'accepted',
      characterId: result.characterId,
      result: {
        status: 'ok',
        revision: result.revision,
        event: result.event,
      },
    }
  }
  if (result.status === 'conflict') {
    return { status: 'failed', result: { status: 'conflict', currentRevision: result.currentRevision } }
  }
  if (result.status === 'unavailable') {
    return { status: 'failed', result: { status: 'unavailable' } }
  }
  return {
    status: 'failed',
    result: {
      status: 'error',
      error: result.status === 'error' || result.status === 'password-invalid' ? result.error : 'Import failed',
      reason: 'invalid-request',
    },
  }
}

export async function importCharacterProcess(
  f: {
    name: string
    data: Uint8Array | File | ReadableStream<Uint8Array>
  },
  options: CharacterImportProcessOptions = {},
): Promise<CharacterImportOutcome | null | undefined> {
  const sourceGeneration = options.sourceGeneration ?? captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return null
  try {
    const dataUriMaxBase64Length = options.dataUriMaxBase64Length ?? DEFAULT_CHARX_MAX_ENTRY_SIZE_BYTES
    const completenessReport = createCharacterImportCompletenessReport()
    if (f.name.endsWith('json')) {
      if (f.data instanceof ReadableStream) {
        return null
      }
      const data =
        f.data instanceof Uint8Array
          ? f.data
          : new Uint8Array(await awaitClientWriteOperation(sourceGeneration, f.data.arrayBuffer()))
      const da = JSON.parse(Buffer.from(data).toString('utf-8'))
      const imported = await importCharacterCardSpec(
        da,
        undefined,
        'normal',
        {},
        undefined,
        dataUriMaxBase64Length,
        completenessReport,
        sourceGeneration,
      )
      if (imported) {
        return imported
      }
      if (!isCurrent()) return null
      if ((da.char_name || da.name) && (da.char_persona || da.description) && (da.char_greeting || da.first_mes)) {
        const previous = currentCharacterStateSnapshot()
        const character = convertOffSpecCards(da)
        const outcome = await appendImportedCharacter(character, previous, sourceGeneration)
        return isCurrent() ? reportCharacterImportOutcome(outcome) : outcome
      } else {
        alertError(language.errors.noData)
        return
      }
    }
    if (f.name.endsWith('charx') || f.name.endsWith('jpg') || f.name.endsWith('jpeg')) {
      console.log('reading charx')
      alertStore.set({
        type: 'wait',
        msg: 'Loading... (Reading)',
      })

      const importer = new CharXImporter({ maxEntrySizeBytes: options.charXMaxEntrySizeBytes })
      importer.alertInfo = true
      await awaitClientWriteOperation(sourceGeneration, importer.parse(f.data))
      let completionError: unknown
      try {
        await awaitClientWriteOperation(sourceGeneration, importer.done())
      } catch (error) {
        if (!isCurrent()) return null

        completionError = error
      }
      completenessReport.droppedArchiveEntries.push(...importer.excludedFiles)
      if (completionError) {
        if (hasDroppedCharacterContent(completenessReport)) {
          alertError(characterImportCompletenessMessage(completenessReport, false))
        }
        throw completionError
      }
      const cardData = importer.cardData
      if (!cardData) {
        alertError(
          hasDroppedCharacterContent(completenessReport)
            ? characterImportCompletenessMessage(completenessReport, false)
            : language.errors.noData,
        )
        return
      }
      const card: CharacterCardV3 = JSON.parse(cardData)
      if (card.spec !== 'chara_card_v3') {
        alertError(language.errors.noData)
        return
      }
      let lorebook: loreBook[] | undefined
      if (importer.moduleData) {
        const md = await awaitClientWriteOperation(
          sourceGeneration,
          readModule(Buffer.from(importer.moduleData), { sourceGeneration }),
        )
        if (!md) {
          return null
        }
        card.data.extensions ??= {}
        card.data.extensions.risuai ??= {}
        card.data.extensions.risuai.triggerscript = md.trigger ?? []
        card.data.extensions.risuai.customScripts = md.regex ?? []
        if (md.lorebook) {
          lorebook = md.lorebook
        }
      }
      return await importCharacterCardSpec(
        card,
        undefined,
        'normal',
        importer.assets,
        lorebook,
        dataUriMaxBase64Length,
        completenessReport,
        sourceGeneration,
      )
    }

    if (!f.name.endsWith('png')) {
      alertError(language.errors.noData)
      return
    }

    alertStore.set({
      type: 'wait',
      msg: 'Loading... (Reading)',
    })
    await awaitClientWriteOperation(sourceGeneration, sleep(10))

    // const readed = PngChunk.read(img, ['chara'])?.['chara']
    let readedChara = ''
    let readedCCv3 = ''
    let img: Uint8Array | undefined

    const readGenerator = PngChunk.readGenerator(f.data, {
      returnTrimed: true,
    })
    const assets: { [key: string]: string } = {}
    const embeddedAssetChunks: { index: string; value: string }[] = []
    for await (const chunk of readGenerator) {
      if (!isCurrent()) return null

      if (!chunk) {
        continue
      }
      if (chunk instanceof AppendableBuffer) {
        img = chunk.buffer
        break
      }
      if (chunk.key === 'chara') {
        //For memory reason, limit to 5MB
        if (readedChara.length < 5 * 1024 * 1024) {
          readedChara = chunk.value
        }
        continue
      }
      if (chunk.key === 'ccv3') {
        if (readedCCv3.length < 5 * 1024 * 1024) {
          readedCCv3 = chunk.value
        }
        continue
      }
      if (chunk.key.startsWith('chara-ext-asset_')) {
        const assetIndex = chunk.key.replace('chara-ext-asset_:', '').replace('chara-ext-asset_', '')
        embeddedAssetChunks.push({ index: assetIndex, value: chunk.value })
      }
    }

    const embeddedAssetPayloads: { index: string; data: Uint8Array }[] = []
    for (let i = 0; i < embeddedAssetChunks.length; i++) {
      const assetChunk = embeddedAssetChunks[i]
      alertStore.set({
        type: 'progress',
        msg: 'Loading... (Loading Assets)',
        submsg: ((i / embeddedAssetChunks.length) * 100).toFixed(2),
      })

      embeddedAssetPayloads.push({
        index: assetChunk.index,
        data: Buffer.from(assetChunk.value, 'base64'),
      })
      assetChunk.value = ''
    }
    embeddedAssetChunks.length = 0

    if (embeddedAssetPayloads.length > 0) {
      alertStore.set({
        type: 'progress',
        msg: 'Loading... (Saving Assets)',
        submsg: '0.00',
      })
      // CCv3 PNG-embedded asset payloads are images;
      // server metadata may default to PNG content-type.
      const savedAssetIds = await awaitClientWriteOperation(
        sourceGeneration,
        saveAssets(embeddedAssetPayloads.map((asset) => ({ data: asset.data }))),
      )
      for (let i = 0; i < embeddedAssetPayloads.length; i++) {
        assets[embeddedAssetPayloads[i].index] = savedAssetIds[i]
        embeddedAssetPayloads[i].data = new Uint8Array(0)
      }
      embeddedAssetPayloads.length = 0
    }

    if (!readedChara && !readedCCv3) {
      alertError(language.errors.noData)
      return
    }

    if (readedCCv3) {
      readedChara = readedCCv3
    }

    if (!img) {
      alertError(language.errors.noData)
      return
    }

    if (readedChara.startsWith('rcc||')) {
      const parts = readedChara.split('||')
      const type = parts[1]
      if (type === 'rccv1') {
        if (parts.length !== 5) {
          alertError(language.errors.noData)
          return
        }
        const encrypted = Buffer.from(parts[2], 'base64')
        const hashed = await awaitClientWriteOperation(sourceGeneration, hasher(encrypted))
        if (hashed !== parts[3]) {
          alertError(language.errors.noData)
          return
        }
        const metaData: RccCardMetaData = JSON.parse(Buffer.from(parts[4], 'base64').toString('utf-8'))
        if (metaData.usePassword) {
          const password = await awaitClientWriteOperation(sourceGeneration, alertInput(language.inputCardPassword))
          if (!password) {
            return
          } else {
            try {
              const decrypted = await awaitClientWriteOperation(sourceGeneration, decryptBuffer(encrypted, password))
              const charaData: CharacterCardV2Risu = JSON.parse(Buffer.from(decrypted).toString('utf-8'))
              const imported = await importCharacterCardSpec(
                charaData,
                img,
                'normal',
                assets,
                undefined,
                dataUriMaxBase64Length,
                undefined,
                sourceGeneration,
              )
              if (imported) {
                return imported
              } else {
                throw new Error('Error while importing')
              }
            } catch (error) {
              if (!isCurrent()) return null

              alertError(language.errors.wrongPassword)
              return
            }
          }
        } else {
          const decrypted = await awaitClientWriteOperation(sourceGeneration, decryptBuffer(encrypted, 'RISU_NONE'))
          try {
            const charaData: CharacterCardV2Risu = JSON.parse(Buffer.from(decrypted).toString('utf-8'))
            const imported = await importCharacterCardSpec(
              charaData,
              img,
              'normal',
              assets,
              undefined,
              dataUriMaxBase64Length,
              undefined,
              sourceGeneration,
            )
            if (imported) {
              return imported
            }
          } catch (error) {
            if (!isCurrent()) return null

            alertError(language.errors.noData)
            return
          }
        }
      }
    }
    const parsed = JSON.parse(Buffer.from(readedChara, 'base64').toString('utf-8'))
    //fix readedChara version pointing number instead of string because of previous version
    if (typeof (parsed as CharacterCardV2Risu)?.data?.character_version === 'number') {
      ;(parsed as CharacterCardV2Risu).data.character_version = (
        parsed as CharacterCardV2Risu
      ).data.character_version.toString()
    }

    if (parsed.spec !== 'chara_card_v2' && parsed.spec !== 'chara_card_v3') {
      const charaData: OldTavernChar = JSON.parse(Buffer.from(readedChara, 'base64').toString('utf-8'))
      // TavernAI v1 card image bytes (PNG).
      const imgp = await awaitClientWriteOperation(sourceGeneration, saveAsset(img))
      const previous = currentCharacterStateSnapshot()
      const character = convertOffSpecCards(charaData, imgp)
      const outcome = await appendImportedCharacter(character, previous, sourceGeneration)
      return isCurrent() ? reportCharacterImportOutcome(outcome) : outcome
    }
    return await importCharacterCardSpec(
      parsed,
      img,
      'normal',
      assets,
      undefined,
      dataUriMaxBase64Length,
      undefined,
      sourceGeneration,
    )
  } catch (error) {
    if (!isCurrent()) return null
    throw error
  }
}

let latestRealmInfoRequest = 0
let realmInfoRequestController: AbortController | null = null

export function cancelPendingRealmInfoRequest(): void {
  latestRealmInfoRequest += 1
  realmInfoRequestController?.abort()
  realmInfoRequestController = null
}

export const getRealmInfo = async (realmPath: string) => {
  const request = ++latestRealmInfoRequest
  realmInfoRequestController?.abort()
  const controller = new AbortController()
  realmInfoRequestController = controller
  const url = new URL(location.href)
  url.searchParams.delete('realm')
  window.history.pushState(null, '', url.toString())
  const ownerLocation = location.href

  const stillOwnsRequest = () =>
    request === latestRealmInfoRequest && !controller.signal.aborted && location.href === ownerLocation

  try {
    const res = await fetch(`${hubURL}/hub/info/${realmPath}`, { signal: controller.signal })
    if (!stillOwnsRequest()) return
    if (res.status !== 200) {
      const body = await res.text()
      if (stillOwnsRequest()) alertError(body)
      return
    }
    const realmInfo = (await res.json()) as hubType
    if (stillOwnsRequest()) showRealmInfoStore.set(realmInfo)
  } catch (error) {
    if (!controller.signal.aborted && stillOwnsRequest()) throw error
  } finally {
    if (realmInfoRequestController === controller) realmInfoRequestController = null
  }
}

export async function characterURLImport() {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  const realmPath = new URLSearchParams(location.search).get('realm')
  try {
    if (realmPath) {
      await getRealmInfo(realmPath)
    }
  } catch (error) {
    alertError(language.errors.noData)
  }

  if (!isCurrent()) return null
  const charPath = new URLSearchParams(location.search).get('charahub')
  try {
    if (charPath) {
      alertWait('Loading from Chub...')
      const url = new URL(location.href)
      url.searchParams.delete('charahub')
      window.history.pushState(null, '', url.toString())
      const chara = await awaitClientWriteOperation(
        sourceGeneration,
        fetch('https://api.chub.ai/api/characters/download', {
          method: 'POST',
          body: JSON.stringify({
            format: 'tavern',
            fullPath: charPath,
            version: 'main',
          }),
          headers: {
            'content-type': 'application/json',
          },
        }),
      )
      const img = new Uint8Array(await awaitClientWriteOperation(sourceGeneration, chara.arrayBuffer()))
      await awaitClientWriteOperation(
        sourceGeneration,
        importCharacterProcess(
          {
            name: 'charahub.png',
            data: img,
          },
          { sourceGeneration },
        ),
      )
    }
  } catch (error) {
    if (!isCurrent()) return null

    alertError(language.errors.noData)
    return null
  }

  const hash = location.hash
  if (hash.startsWith('#import=')) {
    location.hash = ''
    const url = hash.replace('#import=', '')
    try {
      const res = await awaitClientWriteOperation(
        sourceGeneration,
        fetch(url, {
          method: 'GET',
        }),
      )
      const data = new Uint8Array(await awaitClientWriteOperation(sourceGeneration, res.arrayBuffer()))
      await awaitClientWriteOperation(sourceGeneration, importFile(getFileName(res), data))
      checkCharOrder()
    } catch (error) {
      if (!isCurrent()) return null

      alertError(language.errors.noData)
      return null
    }
  }
  if (hash.startsWith('#import_module=')) {
    const data = hash.replace('#import_module=', '')
    const importData = JSON.parse(Buffer.from(decodeURIComponent(data), 'base64').toString('utf-8'))
    const importedModule = await awaitClientWriteOperation(
      sourceGeneration,
      importRisuModuleObject(importData, { alertSuccess: true, sourceGeneration }),
    )
    if (importedModule) {
      SettingsMenuIndex.set(14)
      settingsOpen.set(true)
    }
    return
  }
  if (hash.startsWith('#import_preset=')) {
    const data = hash.replace('#import_preset=', '')
    const importData = Buffer.from(decodeURIComponent(data), 'base64')
    const imported = await awaitClientWriteOperation(
      sourceGeneration,
      importPreset({
        name: 'imported.risupreset',
        data: importData,
      }),
    )
    if (imported === 'applied' || imported === 'queued') {
      SettingsMenuIndex.set(18)
      settingsOpen.set(true)
    }
    return
  }
  async function importFile(name: string, data: Uint8Array) {
    if (name.endsWith('.charx') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) {
      await awaitClientWriteOperation(
        sourceGeneration,
        importCharacterProcess(
          {
            name: name,
            data: data,
          },
          { sourceGeneration },
        ),
      )
      return
    }
    if (name.endsWith('.risupreset') || name.endsWith('.risup')) {
      const imported = await awaitClientWriteOperation(
        sourceGeneration,
        importPreset({
          name: name,
          data: data,
        }),
      )
      if (imported === 'applied' || imported === 'queued') {
        SettingsMenuIndex.set(18)
        settingsOpen.set(true)
      }
      return
    }
    if (name.endsWith('risum')) {
      const importedModule = await awaitClientWriteOperation(
        sourceGeneration,
        importRisuModuleData(data, { sourceGeneration }),
      )
      if (importedModule) {
        SettingsMenuIndex.set(14)
        settingsOpen.set(true)
      }
      return
    }
  }

  function getFileName(res: Response): string {
    return getFromContent(res.headers.get('content-disposition')) || getFromURL(res.url)

    function getFromContent(contentDisposition: string | null) {
      if (!contentDisposition) return null
      const pattern = /filename\*=UTF-8''([^"';\n]+)|filename[^;\n=]*=["']?([^"';\n]+)["']?/
      const matches = contentDisposition.match(pattern)
      if (matches) {
        if (matches[1]) {
          return decodeURIComponent(matches[1])
        } else if (matches[2]) {
          return matches[2]
        }
      }
      return null
    }

    function getFromURL(url: string): string {
      try {
        const path = new URL(url).pathname
        return path.substring(path.lastIndexOf('/') + 1)
      } catch {
        if (!isCurrent()) return null

        return ''
      }
    }
  }
}

function convertOffSpecCards(
  charaData: OldTavernChar | CharacterCardV2Risu,
  imgp: string | undefined = undefined,
): character {
  const data = charaData.spec_version === '2.0' ? charaData.data : charaData
  const charbook = charaData.spec_version === '2.0' ? charaData.data.character_book : null
  let lorebook: loreBook[] = []
  let loresettings: undefined | loreSettings = undefined
  let loreExt: undefined | any = undefined
  if (charbook) {
    const a = convertCharbook({
      lorebook,
      charbook,
      loresettings,
      loreExt,
    })

    lorebook = a.lorebook
    loresettings = a.loresettings
    loreExt = a.loreExt
  }

  return {
    name: data.name ?? 'unknown name',
    firstMessage: data.first_mes ?? 'unknown first message',
    desc: data.description ?? '',
    notes: '',
    chats: [
      {
        message: [],
        note: '',
        name: 'Chat 1',
        localLore: [],
      },
    ],
    chatPage: 0,
    image: imgp,
    notificationImage: '',
    emotionImages: [],
    bias: [],
    globalLore: lorebook,
    viewScreen: 'none',
    chaId: uuidv4(),
    sdData: defaultSdDataFunc(),
    utilityBot: false,
    customscript: [],
    exampleMessage: data.mes_example,
    creatorNotes: '',
    systemPrompt: (charaData.spec_version === '2.0' ? charaData.data.system_prompt : '') ?? '',
    postHistoryInstructions: (charaData.spec_version === '2.0' ? charaData.data.post_history_instructions : '') ?? '',
    alternateGreetings: [],
    tags: [],
    creator: '',
    characterVersion: '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMsgIndex: -1,
    replaceGlobalNote: '',
    triggerscript: [],
    customNotificationMessage: '',
    additionalText: '',
    loreExt: loreExt,
    loreSettings: loresettings,
    chatFolders: [],
  }
}

export async function exportChar(charaID: number): Promise<string> {
  const owner = characterOwnerAt(charaID)
  if (!owner) return ''
  let char = structuredClone(owner)

  if (!char.image) {
    const res = await fetch('/none.webp')
    const data = new Uint8Array(await res.arrayBuffer())
    char.image = await saveAsset(data, '', 'none.webp')
  }

  const option = await alertCardExport()
  if (option.type === '') {
    exportCharacterCard(
      char,
      option.type2 === 'json'
        ? 'json'
        : option.type2 === 'charx'
          ? 'charx'
          : option.type2 === 'charxJpeg'
            ? 'charxJpeg'
            : 'png',
      { spec: 'v3' },
    )
  } else if (option.type === 'ccv2') {
    exportCharacterCard(char, 'png', { spec: 'v2' })
  } else {
    return option.type
  }
  return ''
}

async function importCharacterCardSpec(
  card: CharacterCardV2Risu | CharacterCardV3,
  img?: Uint8Array,
  mode: 'hub' | 'normal' = 'normal',
  assetDict: { [key: string]: string } = {},
  overrideLorebook?: loreBook[],
  dataUriMaxBase64Length = DEFAULT_CHARX_MAX_ENTRY_SIZE_BYTES,
  completenessReport = createCharacterImportCompletenessReport(),
  sourceGeneration = captureClientSessionGeneration(),
): Promise<CharacterImportOutcome | null> {
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return null
  if (!card || (card.spec !== 'chara_card_v2' && card.spec !== 'chara_card_v3')) {
    return null
  }

  console.log(`Importing ${card.spec}, mode is ${mode}`)

  const data = card.data
  // character card primary image bytes (PNG).
  let im = img ? await awaitClientWriteOperation(sourceGeneration, saveAsset(img)) : undefined
  const previous = currentCharacterStateSnapshot()

  const risuext = structuredClone(data.extensions.risuai)
  let emotions: [string, string][] = []
  let bias: [string, number][] = []
  let viewScreen: 'none' | 'emotion' | 'imggen' = 'none'
  let customScripts: customscript[] = []
  let utilityBot = false
  let sdData = defaultSdDataFunc()
  let extAssets: [string, string, string][] = []
  let notificationImage = ''
  const importedAssetReferences = new Map<string, string>()
  let ccAssets: {
    type: string
    uri: string
    name: string
    ext: string
  }[] = []

  let vits: OnnxModelFiles | undefined = undefined
  if (risuext && card.spec === 'chara_card_v2') {
    if (risuext.emotions) {
      const importedEmotions: ([string, string] | undefined)[] = []
      const emotionUploads: { targetIndex: number; data: Uint8Array }[] = []
      for (let i = 0; i < risuext.emotions.length; i++) {
        alertStore.set({
          type: 'progress',
          msg: `Loading... (Loading Emotions)`,
          submsg: ((i / risuext.emotions.length) * 100).toFixed(2),
        })
        await awaitClientWriteOperation(sourceGeneration, sleep(10))
        if (risuext.emotions[i][1].startsWith('__asset:')) {
          const key = risuext.emotions[i][1].replace('__asset:', '')
          const imgp = assetDict[key]
          if (!imgp) {
            if (wasArchiveEntryDropped(completenessReport, key)) continue
            throw new Error('Error while importing, asset ' + key + ' not found')
          }
          importedEmotions[i] = [risuext.emotions[i][0], imgp]
          continue
        }
        // emotion images carried inline in cards are
        // image bytes; PNG default is honest for the persisted metadata.
        emotionUploads.push({
          targetIndex: i,
          data:
            mode === 'hub'
              ? await awaitClientWriteOperation(sourceGeneration, getHubResources(risuext.emotions[i][1]))
              : Buffer.from(risuext.emotions[i][1], 'base64'),
        })
      }
      const savedEmotionAssets = await awaitClientWriteOperation(
        sourceGeneration,
        saveAssets(emotionUploads.map((asset) => ({ data: asset.data }))),
      )
      for (let i = 0; i < emotionUploads.length; i++) {
        const targetIndex = emotionUploads[i].targetIndex
        importedEmotions[targetIndex] = [risuext.emotions[targetIndex][0], savedEmotionAssets[i]]
      }
      emotions.push(...importedEmotions.filter((entry): entry is [string, string] => !!entry))
    }
    if (risuext.additionalAssets) {
      const importedAdditionalAssets: ([string, string, string] | undefined)[] = []
      const additionalAssetUploads: {
        targetIndex: number
        sourceReference: string
        data: Uint8Array
        fileName: string
      }[] = []
      for (let i = 0; i < risuext.additionalAssets.length; i++) {
        alertStore.set({
          type: 'progress',
          msg: `Loading... (Loading Assets)`,
          submsg: ((i / risuext.additionalAssets.length) * 100).toFixed(2),
        })

        if (i % 100 === 0) {
          await awaitClientWriteOperation(sourceGeneration, sleep(10))
        }
        let fileName = ''
        if (risuext.additionalAssets[i].length >= 3) fileName = risuext.additionalAssets[i][2]
        if (risuext.additionalAssets[i][1].startsWith('__asset:')) {
          const sourceReference = risuext.additionalAssets[i][1]
          const key = sourceReference.replace('__asset:', '')
          const imgp = assetDict[key]
          if (!imgp) {
            if (wasArchiveEntryDropped(completenessReport, key)) continue
            throw new Error('Error while importing, asset ' + key + ' not found')
          }
          importedAdditionalAssets[i] = [risuext.additionalAssets[i][0], imgp, fileName]
          importedAssetReferences.set(sourceReference, imgp)
          continue
        }
        additionalAssetUploads.push({
          targetIndex: i,
          sourceReference: risuext.additionalAssets[i][1],
          data:
            mode === 'hub'
              ? await awaitClientWriteOperation(sourceGeneration, getHubResources(risuext.additionalAssets[i][1]))
              : Buffer.from(risuext.additionalAssets[i][1], 'base64'),
          fileName,
        })
      }
      const savedAdditionalAssets = await awaitClientWriteOperation(
        sourceGeneration,
        saveAssets(
          additionalAssetUploads.map((asset) => ({
            data: asset.data,
            fileName: asset.fileName,
          })),
        ),
      )
      for (let i = 0; i < additionalAssetUploads.length; i++) {
        const targetIndex = additionalAssetUploads[i].targetIndex
        const assetId = savedAdditionalAssets[i]
        importedAdditionalAssets[targetIndex] = [
          risuext.additionalAssets[targetIndex][0],
          assetId,
          additionalAssetUploads[i].fileName,
        ]
        importedAssetReferences.set(additionalAssetUploads[i].sourceReference, assetId)
      }
      extAssets.push(...importedAdditionalAssets.filter((entry): entry is [string, string, string] => !!entry))
    }
    if (typeof risuext.notificationImage === 'string' && risuext.notificationImage) {
      if (risuext.notificationImage.startsWith('__asset:')) {
        const key = risuext.notificationImage.replace('__asset:', '')
        const imgp = assetDict[key]
        if (!imgp) {
          if (!wasArchiveEntryDropped(completenessReport, key)) {
            throw new Error('Error while importing, asset ' + key + ' not found')
          }
        } else {
          notificationImage = imgp
        }
      } else {
        const [savedNotificationImage] = await awaitClientWriteOperation(
          sourceGeneration,
          saveAssets([
            {
              data:
                mode === 'hub'
                  ? await awaitClientWriteOperation(sourceGeneration, getHubResources(risuext.notificationImage))
                  : Buffer.from(risuext.notificationImage, 'base64'),
            },
          ]),
        )
        notificationImage = savedNotificationImage ?? ''
      }
    }
    if (risuext.vits) {
      const keys = Object.keys(risuext.vits)
      const vitsUploads: { key: string; data: Uint8Array }[] = []
      for (let i = 0; i < keys.length; i++) {
        alertStore.set({
          type: 'progress',
          msg: `Loading... (Loading VITS)`,
          submsg: ((i / keys.length) * 100).toFixed(2),
        })
        await awaitClientWriteOperation(sourceGeneration, sleep(10))
        const key = keys[i]
        if (risuext.vits[key].startsWith('__asset:')) {
          const rkey = risuext.vits[key].replace('__asset:', '')
          const imgp = assetDict[rkey]
          if (!imgp) {
            if (wasArchiveEntryDropped(completenessReport, rkey)) {
              delete risuext.vits[key]
              continue
            }
            throw new Error('Error while importing, asset ' + rkey + ' not found')
          }
          risuext.vits[key] = imgp
          continue
        }
        // VITS payloads are audio/model files; preserve the source key's
        // extension (e.g. `.wav`, `.ogg`) so server metadata is honest.
        vitsUploads.push({
          key,
          data:
            mode === 'hub'
              ? await awaitClientWriteOperation(sourceGeneration, getHubResources(risuext.vits[key]))
              : Buffer.from(risuext.vits[key], 'base64'),
        })
      }
      const savedVitsAssets = await awaitClientWriteOperation(
        sourceGeneration,
        saveAssets(vitsUploads.map((asset) => ({ data: asset.data, fileName: asset.key }))),
      )
      for (let i = 0; i < vitsUploads.length; i++) {
        risuext.vits[vitsUploads[i].key] = savedVitsAssets[i]
      }

      if (Object.keys(risuext.vits).length > 0) {
        vits = {
          name: 'Imported VITS',
          files: risuext.vits,
          id: uuidv4().replace(/-/g, ''),
        }
      }
    }

    if (risuext) {
      bias = risuext.bias ?? bias
      viewScreen = risuext.viewScreen ?? viewScreen
      customScripts = risuext.customScripts ?? customScripts
      utilityBot = risuext.utilityBot ?? utilityBot
      sdData = risuext.sdData ?? sdData
    }
  }
  if (card.spec === 'chara_card_v3') {
    const data = card.data //required for type checking
    if (data.assets) {
      const resolvedAssetUris: (string | undefined)[] = []
      const dataUriUploads: { targetIndex: number; data: Uint8Array }[] = []
      for (let i = 0; i < data.assets.length; i++) {
        alertStore.set({
          type: 'progress',
          msg: `Loading... (Assets)`,
          submsg: (((i + 1) / data.assets.length) * 100).toFixed(2),
        })
        if (i % 100 === 0) {
          await awaitClientWriteOperation(sourceGeneration, sleep(10))
        }
        if (data.assets[i].uri.startsWith('__asset:')) {
          const key = data.assets[i].uri.replace('__asset:', '')
          const assetId = assetDict[key]
          if (!assetId) {
            if (wasArchiveEntryDropped(completenessReport, key)) continue
            throw new Error('Error while importing, asset ' + key + ' not found')
          }
          resolvedAssetUris[i] = assetId
        } else if (data.assets[i].uri === 'ccdefault:') {
          resolvedAssetUris[i] = im
        } else if (data.assets[i].uri.startsWith('embeded://')) {
          const key = data.assets[i].uri.replace('embeded://', '')
          const assetId = assetDict[key]
          if (!assetId) {
            if (wasArchiveEntryDropped(completenessReport, key)) continue
            throw new Error('Error while importing, asset ' + key + ' not found')
          }
          resolvedAssetUris[i] = assetId
        } else if (data.assets[i].uri.startsWith('data:')) {
          //data uri
          const b64 = data.assets[i].uri.split(',')[1] ?? ''
          if (b64.length < dataUriMaxBase64Length) {
            // CCv3 inline data: URI assets are image
            // bytes by convention; PNG default is acceptable.
            dataUriUploads.push({ targetIndex: i, data: Buffer.from(b64, 'base64') })
          } else {
            completenessReport.droppedInlineAssets.push({ index: i, name: data.assets[i].name ?? '' })
          }
        } else {
          continue
        }
      }

      const savedDataUriAssets =
        dataUriUploads.length > 0
          ? await awaitClientWriteOperation(
              sourceGeneration,
              saveAssets(dataUriUploads.map((asset) => ({ data: asset.data }))),
            )
          : []
      for (let i = 0; i < dataUriUploads.length; i++) {
        resolvedAssetUris[dataUriUploads[i].targetIndex] = savedDataUriAssets[i]
      }

      for (let i = 0; i < data.assets.length; i++) {
        const resolvedAssetUri = resolvedAssetUris[i]
        if (resolvedAssetUri) importedAssetReferences.set(data.assets[i].uri, resolvedAssetUri)
      }

      for (let i = 0; i < data.assets.length; i++) {
        let fileName = ''
        if (data.assets[i].name) {
          fileName = data.assets[i].name
        }
        const imgp = resolvedAssetUris[i]
        if (!imgp) {
          continue
        }
        if (data.assets[i].type === 'emotion') {
          emotions.push([fileName, imgp])
        } else if (data.assets[i].type === 'x-risu-asset') {
          extAssets.push([fileName, imgp, data.assets[i].ext ?? 'unknown'])
        } else if (data.assets[i].type === 'x-risu-notification-image') {
          notificationImage = imgp
        } else if (data.assets[i].type === 'icon' && data.assets[i].name === 'main') {
          im = imgp
        } else {
          ccAssets.push({
            type: data.assets[i].type ?? 'asset',
            uri: imgp,
            name: fileName,
            ext: data.assets[i].ext ?? 'unknown',
          })
        }
      }
    }

    if (risuext) {
      bias = risuext.bias ?? bias
      viewScreen = risuext.viewScreen ?? viewScreen
      customScripts = risuext.customScripts ?? customScripts
      utilityBot = risuext.utilityBot ?? utilityBot
      sdData = risuext.sdData ?? sdData
    }
  }

  if (risuext && risuext?.lowLevelAccess) {
    alertClear()
    const conf = await awaitClientWriteOperation(sourceGeneration, alertConfirm(language.lowLevelAccessConfirm))
    if (!conf) {
      return null
    }
  }
  const charbook = data.character_book
  let lorebook: loreBook[] = overrideLorebook ?? []
  let loresettings: undefined | loreSettings = undefined
  let loreExt: undefined | any = undefined
  if (charbook) {
    const a = convertCharbook({
      lorebook: overrideLorebook ? [] : lorebook,
      charbook,
      loresettings,
      loreExt,
    })

    if (!overrideLorebook) {
      lorebook = a.lorebook
    }
    loresettings = a.loresettings
    loreExt = a.loreExt
  }

  let ext = structuredClone(data?.extensions ?? {})

  for (const key in ext) {
    if (key === 'risuai') {
      delete ext[key]
    }
    if (key === 'depth_prompt') {
      delete ext[key]
    }
  }

  let char: character = {
    name: data.name ?? '',
    firstMessage: data.first_mes ?? '',
    desc: data.description ?? '',
    notes: '',
    chats: [
      {
        message: [],
        note: '',
        name: 'Chat 1',
        localLore: [],
      },
    ],
    chatPage: 0,
    image: im,
    emotionImages: emotions,
    bias: bias,
    globalLore: lorebook, //lorebook
    viewScreen: viewScreen,
    chaId: uuidv4(),
    sdData: sdData,
    utilityBot: utilityBot,
    customscript: customScripts,
    exampleMessage: data.mes_example ?? '',
    creatorNotes: data.creator_notes ?? '',
    systemPrompt: data.system_prompt ?? '',
    postHistoryInstructions: '',
    alternateGreetings: data.alternate_greetings ?? [],
    tags: data.tags ?? [],
    creator: data.creator ?? '',
    characterVersion: `${data.character_version}` || '',
    personality: data.personality ?? '',
    scenario: data.scenario ?? '',
    firstMsgIndex: -1,
    removedQuotes: false,
    loreSettings: loresettings,
    loreExt: loreExt,
    additionalData: {
      tag: data.tags ?? [],
      creator: data.creator,
      character_version: data.character_version,
    },
    additionalAssets: extAssets,
    replaceGlobalNote: data.post_history_instructions ?? '',
    backgroundHTML: data?.extensions?.risuai?.backgroundHTML,
    license: data?.extensions?.risuai?.license,
    triggerscript: data?.extensions?.risuai?.triggerscript ?? [],
    private: data?.extensions?.risuai?.private ?? false,
    customNotificationMessage: data?.extensions?.risuai?.customNotificationMessage ?? '',
    notificationImage: notificationImage || data?.extensions?.risuai?.notificationImage || '',
    additionalText: data?.extensions?.risuai?.additionalText ?? '',
    virtualscript: '', //removed dude to security issue
    extentions: ext ?? {},
    largePortrait: data?.extensions?.risuai?.largePortrait ?? !data?.extensions?.risuai,
    lorePlus: data?.extensions?.risuai?.lorePlus ?? false,
    inlayViewScreen: data?.extensions?.risuai?.inlayViewScreen ?? false,
    newGenData: data?.extensions?.risuai?.newGenData ?? undefined,
    vits: vits,
    ttsMode: vits ? 'vits' : 'normal',
    imported: true,
    source: card?.data?.extensions?.risuai?.source ?? [],
    ccAssets: ccAssets,
    lowLevelAccess: risuext?.lowLevelAccess ?? false,
    defaultVariables: data?.extensions?.risuai?.defaultVariables ?? '',
    chatFolders: [],
    prebuiltAssetCommand: data?.extensions?.risuai?.prebuiltAssetCommand ?? '',
    prebuiltAssetExclude: normalizeImportedPrebuiltAssetExcludes(
      risuext?.prebuiltAssetExclude,
      extAssets,
      importedAssetReferences,
    ),
    prebuiltAssetStyle: data?.extensions?.risuai?.prebuiltAssetStyle ?? '',
  }

  if (card.spec === 'chara_card_v3') {
    char.group_only_greetings = card.data.group_only_greetings ?? []
    char.nickname = card.data.nickname ?? ''
    char.source = card.data.source ?? card.data?.extensions?.risuai?.source ?? []
    char.creation_date = card.data.creation_date ?? 0
    char.modification_date = card.data.modification_date ?? 0
  }

  const outcome = await appendImportedCharacter(char, previous, sourceGeneration)
  return isCurrent() ? reportCharacterImportOutcome(outcome, completenessReport) : outcome
}

function convertCharbook(arg: {
  lorebook: loreBook[]
  charbook: CharacterBook
  loresettings: loreSettings | undefined
  loreExt: any
}) {
  let { lorebook, loresettings, loreExt, charbook } = arg
  if (
    !checkNullish(charbook.recursive_scanning) &&
    !checkNullish(charbook.scan_depth) &&
    !checkNullish(charbook.token_budget)
  ) {
    loresettings = {
      tokenBudget: charbook.token_budget!,
      scanDepth: charbook.scan_depth!,
      recursiveScanning: charbook.recursive_scanning!,
      fullWordMatching: charbook?.extensions?.risu_fullWordMatching ?? false,
    }
  }

  loreExt = charbook.extensions

  for (const book of charbook.entries) {
    let content = book.content

    if (book.use_regex && !book.keys?.[0]?.startsWith('/')) {
      book.use_regex = false
    }

    //extention migration
    const extensions = book.extensions ?? {}

    if (extensions.useProbability && extensions.probability !== undefined && extensions.probability !== 100) {
      content = `@@probability ${extensions.probability}\n` + content
      delete extensions.useProbability
      delete extensions.probability
    }
    if (extensions.position === 4 && typeof extensions.depth === 'number' && typeof extensions.role === 'number') {
      content = `@@depth ${extensions.depth}\n@@role ${['system', 'user', 'assistant'][extensions.role]}\n` + content
      delete extensions.position
      delete extensions.depth
      delete extensions.role
    }
    if (typeof extensions.selectiveLogic === 'number' && book.secondary_keys && book.secondary_keys.length > 0) {
      switch (extensions.selectiveLogic) {
        case 0: {
          if (!book.secondary_keys || book.secondary_keys.length === 0) {
            book.selective = false
          }
          break
        }
        case 1: {
          book.selective = false
          content = `@@exclude_keys_all ${book.secondary_keys.join(',')}\n` + content
          break
        }
        case 2: {
          book.selective = false
          for (const secKey of book.secondary_keys) {
            content = `@@exclude_keys ${secKey}\n` + content
          }
          break
        }
        case 3: {
          book.selective = false
          for (const secKey of book.secondary_keys) {
            content = `@@additional_keys ${secKey}\n` + content
          }
          break
        }
      }
    }
    if (typeof extensions.delay === 'number' && extensions.delay > 0) {
      content = `@@activate_only_after ${extensions.delay}\n` + content
      delete extensions.delay
    }
    if (extensions.match_whole_words === true) {
      content = `@@match_full_word\n` + content
      delete extensions.match_whole_words
    }
    if (extensions.match_whole_words === false) {
      content = `@@match_partial_word\n` + content
      delete extensions.match_whole_words
    }

    const agentOnly = extensions.risu_agent_only === true
    lorebook.push({
      key: book.keys.join(', '),
      secondkey: book.secondary_keys?.join(', ') ?? '',
      insertorder: book.insertion_order,
      comment: book.name ?? book.comment ?? '',
      content: content,
      mode: (book.mode as any) ?? 'normal',
      alwaysActive: book.constant ?? false,
      selective: book.selective ?? false,
      extentions: { ...extensions, risu_case_sensitive: book.case_sensitive ?? false },
      agentOnly,
      activationPercent: book.extensions?.risu_activationPercent,
      loreCache: book.extensions?.risu_loreCache ?? null,
      useRegex: book.use_regex ?? false,
      folder: book.folder,
    })
  }

  return {
    lorebook,
    loresettings,
    loreExt,
  }
}

function createBaseV2(char: character) {
  let charBook: charBookEntry[] = []
  for (const lore of char.globalLore) {
    let ext: {
      risu_case_sensitive?: boolean
      risu_activationPercent?: number | null
      risu_loreCache?: {
        key: string
        data: string[]
      } | null
      risu_agent_only?: boolean
    } = structuredClone(lore.extentions ?? {})

    let caseSensitive = ext.risu_case_sensitive ?? false
    ext.risu_activationPercent = lore.activationPercent
    ext.risu_loreCache = lore.loreCache
    const agentOnly = lore.agentOnly === true || ext.risu_agent_only === true
    ext.risu_agent_only = agentOnly

    charBook.push({
      keys: agentOnly ? [] : lore.key.split(',').map((r) => r.trim()),
      secondary_keys: agentOnly ? [] : lore.selective ? lore.secondkey.split(',').map((r) => r.trim()) : undefined,
      content: lore.content,
      extensions: ext,
      enabled: true,
      insertion_order: lore.insertorder,
      constant: agentOnly ? false : lore.alwaysActive,
      selective: lore.selective,
      name: lore.comment,
      comment: lore.comment,
      case_sensitive: caseSensitive,
      mode: lore.mode ?? 'normal',
      folder: lore.folder,
    })
  }
  const exportedLoreExtensions = structuredClone(char.loreExt ?? {})
  exportedLoreExtensions.risu_fullWordMatching = char.loreSettings?.fullWordMatching ?? false

  const card: CharacterCardV2Risu = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: char.name,
      description: char.desc ?? '',
      personality: char.personality ?? '',
      scenario: char.scenario ?? '',
      first_mes: char.firstMessage ?? '',
      mes_example: char.exampleMessage ?? '',
      creator_notes: char.creatorNotes ?? '',
      system_prompt: char.systemPrompt ?? '',
      post_history_instructions: char.replaceGlobalNote ?? '',
      alternate_greetings: char.alternateGreetings ?? [],
      character_book: {
        scan_depth: char.loreSettings?.scanDepth,
        token_budget: char.loreSettings?.tokenBudget,
        recursive_scanning: char.loreSettings?.recursiveScanning,
        extensions: exportedLoreExtensions,
        entries: charBook,
      },
      tags: char.tags ?? [],
      creator: char.additionalData?.creator ?? '',
      character_version: `${char.additionalData?.character_version}` || '',
      extensions: {
        risuai: {
          emotions: structuredClone(char.emotionImages ?? []),
          bias: char.bias,
          viewScreen: char.viewScreen,
          customScripts: char.customscript,
          utilityBot: char.utilityBot,
          sdData: char.sdData,
          additionalAssets: structuredClone(char.additionalAssets ?? []),
          backgroundHTML: char.backgroundHTML,
          license: char.license,
          triggerscript: char.triggerscript,
          customNotificationMessage: char.customNotificationMessage ?? '',
          notificationImage: char.notificationImage ?? '',
          additionalText: char.additionalText,
          virtualscript: '', //removed dude to security issue
          largePortrait: char.largePortrait,
          lorePlus: char.lorePlus,
          inlayViewScreen: char.inlayViewScreen,
          newGenData: char.newGenData,
          vits: {},
        },
        depth_prompt: char.depth_prompt,
      },
    },
  }

  if (char.extentions) {
    for (const key in char.extentions) {
      if (key === 'risuai' || key === 'depth_prompt') {
        continue
      }
      ;(card.data.extensions as Record<string, any>)[key] = char.extentions[key]
    }
  }
  return card
}

export async function exportCharacterCard(
  char: character,
  type: 'png' | 'json' | 'charx' | 'charxJpeg' = 'png',
  arg: {
    password?: string
    writer?: LocalWriter | VirtualWriter
    spec?: 'v2' | 'v3'
  } = {},
) {
  let img = await readImage(char.image ?? '')
  const spec: 'v2' | 'v3' = arg.spec ?? 'v2' //backward compatibility
  try {
    char.image = ''
    img = type === 'png' ? await reencodeImage(img) : img
    const localWriter = arg.writer ?? new LocalWriter()
    if (!arg.writer && type !== 'json') {
      const nameExt = {
        png: ['Image File', 'png'],
        json: ['JSON File', 'json'],
        charx: ['CharX File', 'charx'],
        charxJpeg: ['CharX Embeded Jpeg', 'jpeg'],
      }
      const ext = nameExt[type]
      await (localWriter as LocalWriter).init(ext[0], [ext[1]])
    }
    const writer =
      type === 'charx' || type === 'charxJpeg'
        ? new CharXWriter(localWriter)
        : type === 'json'
          ? new BlankWriter()
          : new PngChunk.streamWriter(img, localWriter)
    await writer.init()
    if (writer instanceof CharXWriter && type === 'charxJpeg') {
      await writer.writeJpeg(img)
    }
    let assetIndex = 0
    if (spec === 'v2') {
      const card = await createBaseV2(char)
      const risuai = card.data.extensions.risuai!
      if (risuai.emotions && risuai.emotions.length > 0) {
        for (let i = 0; i < risuai.emotions.length; i++) {
          alertStore.set({
            type: 'progress',
            msg: 'Loading... (Adding Emotions)',
            submsg: ((i / risuai.emotions.length) * 100).toFixed(2),
          })
          const key = risuai.emotions[i][1]
          const rData = await readImage(key)
          const b64encoded = Buffer.from(await compressImage(rData)).toString('base64')
          if (type === 'json') {
            risuai.emotions[i][1] = b64encoded
          } else {
            assetIndex++
            risuai.emotions[i][1] = `__asset:${assetIndex}`
            await writer.write('chara-ext-asset_:' + assetIndex, b64encoded)
          }
        }
      }

      if (risuai.additionalAssets && risuai.additionalAssets.length > 0) {
        for (let i = 0; i < risuai.additionalAssets.length; i++) {
          alertStore.set({
            type: 'progress',
            msg: 'Loading... (Adding Additional Assets)',
            submsg: ((i / risuai.additionalAssets.length) * 100).toFixed(2),
          })
          const key = risuai.additionalAssets[i][1]
          const rData = await readImage(key)
          const b64encoded = Buffer.from(await compressImage(rData)).toString('base64')
          if (type === 'json') {
            risuai.additionalAssets[i][1] = b64encoded
          } else {
            assetIndex++
            risuai.additionalAssets[i][1] = `__asset:${assetIndex}`
            await writer.write('chara-ext-asset_:' + assetIndex, b64encoded)
          }
        }
      }

      if (risuai.notificationImage) {
        alertStore.set({
          type: 'progress',
          msg: 'Loading... (Adding Notification Image)',
        })
        const rData = await readImage(risuai.notificationImage)
        const b64encoded = Buffer.from(await compressImage(rData)).toString('base64')
        if (type === 'json') {
          risuai.notificationImage = b64encoded
        } else {
          assetIndex++
          risuai.notificationImage = `__asset:${assetIndex}`
          await writer.write('chara-ext-asset_:' + assetIndex, b64encoded)
        }
      }

      if (char.vits && char.ttsMode === 'vits') {
        const keys = Object.keys(char.vits.files)
        for (let i = 0; i < keys.length; i++) {
          alertStore.set({
            type: 'progress',
            msg: 'Loading... (Adding VITS)',
            submsg: ((i / keys.length) * 100).toFixed(2),
          })
          const key = keys[i]
          const rData = await loadAsset(char.vits.files[key])
          const b64encoded = Buffer.from(rData).toString('base64')
          if (type === 'json') {
            risuai.vits![key] = b64encoded
          } else {
            assetIndex++
            risuai.vits![key] = `__asset:${assetIndex}`
            await writer.write('chara-ext-asset_:' + assetIndex, b64encoded)
          }
        }
      }
      if (type === 'json') {
        await downloadFile(
          `${char.name.replace(/[<>:"/\\|?*\.\,]/g, '')}_export.json`,
          Buffer.from(JSON.stringify(card, null, 4), 'utf-8'),
        )
        alertNormal(language.successExport)
        return
      }

      await sleep(10)
      alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing)',
      })

      await writer.write('chara', Buffer.from(JSON.stringify(card)).toString('base64'))
    } else if (spec === 'v3') {
      const card = createBaseV3(char)
      const seenPaths = new Set<string>()
      if (card.data.assets && card.data.assets.length > 0) {
        for (let i = 0; i < card.data.assets.length; i++) {
          alertStore.set({
            type: 'progress',
            msg: 'Loading... (Adding Assets)',
            submsg: ((i / card.data.assets.length) * 100).toFixed(2),
          })
          const sourceReference = card.data.assets[i].uri
          let key = sourceReference
          let rData: Uint8Array
          if (key === 'ccdefault:' && type !== 'png') {
            key = char.image
            rData = img
          } else if (isKnownUri(key)) {
            continue
          } else {
            rData = await readImage(key)
          }
          assetIndex++
          if (type === 'png') {
            const b64encoded = Buffer.from(await compressImage(rData)).toString('base64')
            card.data.assets[i].uri = `__asset:${assetIndex}`
            await writer.write('chara-ext-asset_:' + assetIndex, b64encoded)
          } else if (type === 'json') {
            const b64encoded = Buffer.from(await compressImage(rData)).toString('base64')
            card.data.assets[i].uri = `data:application/octet-stream;base64,${b64encoded}`
          } else {
            let type = 'other'
            let itype = 'other'
            switch (card.data.assets[i].type) {
              case 'emotion':
                type = 'emotion'
                break
              case 'background':
                type = 'background'
                break
              case 'user_icon':
                type = 'user_icon'
                break
              case 'icon':
                type = 'icon'
                break
            }
            switch (card.data.assets[i].ext) {
              case 'png':
              case 'jpg':
              case 'jpeg':
              case 'gif':
              case 'webp':
              case 'avif':
                itype = 'image'
                break
              case 'mp3':
              case 'wav':
              case 'ogg':
              case 'flac':
                itype = 'audio'
                break
              case 'mp4':
              case 'webm':
              case 'mov':
              case 'avi':
              case 'mkv':
                itype = 'video'
                break
              case 'mmd':
              case 'obj':
                itype = 'model'
                break
              case 'safetensors':
              case 'cpkt':
              case 'onnx':
                itype = 'ai'
                break
              case 'otf':
              case 'ttf':
              case 'woff':
              case 'woff2':
                itype = 'fonts'
                break
              case 'js':
              case 'ts':
              case 'lua':
                itype = 'code'
            }

            let path = ''
            let name = card.data.assets[i].name || `asset_${assetIndex}`
            if (name.length > 100) {
              name = name.substring(0, 100)
            }
            const ext = card.data.assets[i].ext === 'unknown' ? 'png' : card.data.assets[i].ext
            const baseDir = card.data.assets[i].ext === 'unknown' ? `assets/${type}/image` : `assets/${type}/${itype}`

            // Generate unique path to avoid duplicate filenames
            let uniqueName = name
            let suffix = 0
            while (seenPaths.has(`${baseDir}/${uniqueName}.${ext}`)) {
              suffix++
              uniqueName = `${name}_${suffix}`
            }
            path = `${baseDir}/${uniqueName}.${ext}`
            seenPaths.add(path)

            card.data.assets[i].uri = 'embeded://' + path
            const imageType = getImageType(rData)
            const metaPath = `x_meta/${uniqueName}.json`
            if (imageType === 'PNG' && writer instanceof CharXWriter) {
              const metadatas: Record<string, string> = {}
              const gen = PngChunk.readGenerator(rData)
              for await (const chunk of gen) {
                if (!chunk || chunk instanceof AppendableBuffer) {
                  continue
                }
                metadatas[chunk.key] = chunk.value
              }
              if (Object.keys(metadatas).length > 0) {
                await writer.write(metaPath, Buffer.from(JSON.stringify(metadatas, null, 4)), 6)
              } else {
                await writer.write(
                  metaPath,
                  Buffer.from(
                    JSON.stringify({
                      type: imageType,
                    }),
                    'utf-8',
                  ),
                  6,
                )
              }
            } else {
              await writer.write(
                metaPath,
                Buffer.from(
                  JSON.stringify({
                    type: imageType,
                  }),
                  'utf-8',
                ),
                6,
              )
            }
            await writer.write(path, Buffer.from(await compressImage(rData)))
          }
          rewritePrebuiltAssetExcludeReference(card.data.extensions.risuai, sourceReference, card.data.assets[i].uri)
        }
      }
      if (type === 'json') {
        await downloadFile(
          `${char.name.replace(/[<>:"/\\|?*\.\,]/g, '')}_export.json`,
          Buffer.from(JSON.stringify(card, null, 4), 'utf-8'),
        )
        alertNormal(language.successExport)
        return
      }

      await sleep(10)
      alertStore.set({
        type: 'wait',
        msg: 'Loading... (Writing)',
      })

      if (type === 'charx' || type === 'charxJpeg') {
        const md: RisuModule = {
          name: `${char.name} Module`,
          description: 'Module for ' + char.name,
          id: v4(),
          trigger: card.data.extensions.risuai.triggerscript ?? [],
          regex: card.data.extensions.risuai.customScripts ?? [],
          lorebook: char.globalLore ?? [],
        }
        delete card.data.extensions.risuai.triggerscript
        delete card.data.extensions.risuai.customScripts
        await writer.write(
          'module.risum',
          await exportModule(md, {
            alertEnd: false,
            saveData: false,
          }),
        )
        await writer.write('card.json', Buffer.from(JSON.stringify(card, null, 4)))
      } else {
        await writer.write('ccv3', Buffer.from(JSON.stringify(card)).toString('base64'))
      }
    }
    await writer.end()

    await sleep(10)

    if (!arg.writer) {
      alertNormal(language.successExport)
    }
  } catch (e) {
    alertError(e as Error)
  }
}

// Extended LorebookEntry with Risuai specific fields
type RisuLorebookEntry = LorebookEntry & {
  mode?: string
  folder?: string
}

export function createBaseV3(char: character) {
  let charBook: RisuLorebookEntry[] = []
  let assets: Array<{
    type: string
    uri: string
    name: string
    ext: string
  }> = structuredClone(char.ccAssets ?? [])

  if (char.additionalAssets) {
    for (const asset of char.additionalAssets) {
      assets.push({
        type: 'x-risu-asset',
        uri: asset[1],
        name: asset[0],
        ext: asset[2] || 'png',
      })
    }
  }

  if (char.notificationImage) {
    assets.push({
      type: 'x-risu-notification-image',
      uri: char.notificationImage,
      name: 'notification',
      ext: 'png',
    })
  }

  if (char.emotionImages) {
    for (const asset of char.emotionImages) {
      assets.push({
        type: 'emotion',
        uri: asset[1],
        name: asset[0],
        ext: 'png',
      })
    }

    assets.push({
      type: 'icon',
      uri: 'ccdefault:',
      name: 'main',
      ext: 'png',
    })
  }

  for (const lore of char.globalLore) {
    let ext: {
      risu_case_sensitive?: boolean
      risu_activationPercent?: number | null
      risu_loreCache?: {
        key: string
        data: string[]
      } | null
      risu_agent_only?: boolean
    } = structuredClone(lore.extentions ?? {})

    let caseSensitive = ext.risu_case_sensitive ?? false
    ext.risu_activationPercent = lore.activationPercent
    ext.risu_loreCache = lore.loreCache
    const agentOnly = lore.agentOnly === true || ext.risu_agent_only === true
    ext.risu_agent_only = agentOnly

    charBook.push({
      ...({
        keys: agentOnly ? [] : lore.key.split(',').map((r) => r.trim()),
        secondary_keys: agentOnly ? [] : lore.selective ? lore.secondkey.split(',').map((r) => r.trim()) : undefined,
        content: lore.content,
        extensions: ext,
        enabled: true,
        insertion_order: lore.insertorder,
        constant: agentOnly ? false : lore.alwaysActive,
        selective: lore.selective,
        name: lore.comment,
        comment: lore.comment,
        case_sensitive: caseSensitive,
        use_regex: lore.useRegex ?? false,
      } as LorebookEntry),
      mode: lore.mode ?? 'normal',
      folder: lore.folder,
    })
  }
  const exportedLoreExtensions = structuredClone(char.loreExt ?? {})
  exportedLoreExtensions.risu_fullWordMatching = char.loreSettings?.fullWordMatching ?? false

  const card: CharacterCardV3 = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: char.name,
      description: char.desc ?? '',
      personality: char.personality ?? '',
      scenario: char.scenario ?? '',
      first_mes: char.firstMessage ?? '',
      mes_example: char.exampleMessage ?? '',
      creator_notes: char.creatorNotes ?? '',
      system_prompt: char.systemPrompt ?? '',
      post_history_instructions: char.replaceGlobalNote ?? '',
      alternate_greetings: char.alternateGreetings ?? [],
      character_book: {
        scan_depth: char.loreSettings?.scanDepth,
        token_budget: char.loreSettings?.tokenBudget,
        recursive_scanning: char.loreSettings?.recursiveScanning,
        extensions: exportedLoreExtensions,
        entries: charBook,
      },
      tags: char.tags ?? [],
      creator: char.additionalData?.creator ?? '',
      character_version: `${char.additionalData?.character_version}` || '',
      extensions: {
        risuai: {
          bias: char.bias,
          viewScreen: char.viewScreen,
          customScripts: char.customscript,
          utilityBot: char.utilityBot,
          sdData: char.sdData,
          backgroundHTML: char.backgroundHTML,
          license: char.license,
          triggerscript: char.triggerscript,
          customNotificationMessage: char.customNotificationMessage ?? '',
          notificationImage: char.notificationImage ?? '',
          additionalText: char.additionalText,
          virtualscript: '', //removed dude to security issue
          largePortrait: char.largePortrait,
          lorePlus: char.lorePlus,
          inlayViewScreen: char.inlayViewScreen,
          newGenData: char.newGenData,
          vits: {},
          lowLevelAccess: char.lowLevelAccess ?? false,
          defaultVariables: char.defaultVariables ?? '',
          prebuiltAssetCommand: char.prebuiltAssetCommand ?? '',
          prebuiltAssetExclude: char.prebuiltAssetExclude ?? [],
          prebuiltAssetStyle: char.prebuiltAssetStyle ?? '',
        },
        depth_prompt: char.depth_prompt,
      },
      group_only_greetings: char.group_only_greetings ?? [],
      nickname: char.nickname ?? '',
      source: char.source ?? [],
      creation_date: char.creation_date ?? 0,
      modification_date: Math.floor(Date.now() / 1000),
      assets: assets,
    },
  }

  if (char.extentions) {
    for (const key in char.extentions) {
      if (key === 'risuai' || key === 'depth_prompt') {
        continue
      }
      ;(card.data.extensions as Record<string, any>)[key] = char.extentions[key]
    }
  }
  return card
}

export interface RisuHubCatalogResult {
  status: 'ok' | 'error'
  cards: hubType[]
  additionalHTML: string
}

export interface RisuHubCatalogQuery {
  search: string
  page: number
  nsfw: boolean
  sort: string
  signal?: AbortSignal
}

let latestRealmImportOperationToken = 0

function createRealmImportOperationToken() {
  latestRealmImportOperationToken += 1
  return latestRealmImportOperationToken
}

function isLatestRealmImportOperation(token: number) {
  return token === latestRealmImportOperationToken
}

function createRealmImportProgressReporter(token: number, sourceGeneration: number) {
  return (progress: ServerRealmImportProgress) => {
    if (isClientWriteOperationCurrent(sourceGeneration) && isLatestRealmImportOperation(token)) {
      showRealmImportProgress(progress)
    }
  }
}

export async function getRisuHub(arg: RisuHubCatalogQuery): Promise<RisuHubCatalogResult> {
  try {
    const params = new URLSearchParams({
      search: `${arg.search} __shared`,
      page: String(arg.page),
      nsfw: String(arg.nsfw),
      sort: arg.sort,
      web: 'other',
    })

    const da = await fetch(`${hubURL}/realm?${params.toString()}`, {
      headers: {
        'x-risuai-info': appVer + ';' + 'fastify',
      },
      signal: arg.signal,
    })
    if (da.status !== 200) {
      return { status: 'error', cards: [], additionalHTML: '' }
    }
    const jso = await da.json()
    if (Array.isArray(jso)) {
      return { status: 'ok', cards: jso, additionalHTML: '' }
    }
    const additionalHTML =
      typeof jso?.additionalHTML === 'string' && jso.additionalHTML.length > 0
        ? sanitizeHubAdditionalHtml(jso.additionalHTML)
        : ''
    return {
      status: 'ok',
      cards: Array.isArray(jso?.cards) ? jso.cards : [],
      additionalHTML,
    }
  } catch (error) {
    return { status: 'error', cards: [], additionalHTML: '' }
  }
}

export async function getRisuHubCards(arg: RisuHubCatalogQuery): Promise<hubType[]> {
  return (await getRisuHub(arg)).cards
}

export async function downloadRisuHub(
  id: string,
  arg: {
    forceRedirect?: boolean
  } = {},
) {
  const sourceGeneration = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(sourceGeneration)
  if (!isCurrent()) return
  try {
    if (!arg.forceRedirect) {
      if (!(await alertRealmTerms())) {
        return
      }
    }
    if (!isCurrent()) return
    let realmImportOperationToken = createRealmImportOperationToken()
    let onProgress = createRealmImportProgressReporter(realmImportOperationToken, sourceGeneration)
    if (!arg.forceRedirect) {
      alertStore.set({
        type: 'wait',
        msg: 'Downloading...',
      })
    }
    const imported = await importRealmCharacterFromServer(id, { onProgress })
    if (!isCurrent()) return
    if (imported.status === 'low-level-access') {
      if (!isLatestRealmImportOperation(realmImportOperationToken)) {
        return
      }
      // Release the progress overlay so the queued confirmation can be shown.
      alertStore.set({ type: 'none', msg: '' })
      const confirmed = await alertConfirm(language.lowLevelAccessConfirm)
      if (!isCurrent()) return
      if (!confirmed) {
        if (isLatestRealmImportOperation(realmImportOperationToken)) {
          alertStore.set({ type: 'none', msg: '' })
        }
        return
      }
      if (!isLatestRealmImportOperation(realmImportOperationToken)) {
        return
      }
      realmImportOperationToken = createRealmImportOperationToken()
      onProgress = createRealmImportProgressReporter(realmImportOperationToken, sourceGeneration)
      const retry = await importRealmCharacterFromServer(id, {
        allowLowLevelAccess: true,
        pendingImportToken: imported.pendingImportToken,
        onProgress,
      })
      if (!isCurrent()) return
      if (retry.status !== 'ok') {
        if (retry.status !== 'unsupported') {
          if (isLatestRealmImportOperation(realmImportOperationToken)) {
            alertError(retry.status === 'error' ? retry.error : 'Error while importing')
          }
          return
        }
      } else {
        await finishServerRealmImport(retry, arg, realmImportOperationToken, sourceGeneration, onProgress)
        return
      }
    } else if (imported.status !== 'ok') {
      if (imported.status !== 'unsupported') {
        if (isLatestRealmImportOperation(realmImportOperationToken)) {
          alertError(imported.status === 'error' ? imported.error : 'Error while importing')
        }
        return
      }
    } else {
      await finishServerRealmImport(imported, arg, realmImportOperationToken, sourceGeneration, onProgress)
      return
    }
    const res = await fetch('https://realm.risuai.net/api/v1/download/dynamic/' + id + '?cors=true', {
      headers: {
        'x-risu-api-version': '4',
      },
    })
    if (!isCurrent()) return
    if (res.status !== 200) {
      const error = await res.text()
      if (isCurrent()) alertError(error)
      return
    }

    if (
      res.headers.get('content-type') === 'image/png' ||
      res.headers.get('content-type') === 'application/zip' ||
      res.headers.get('content-type') === 'application/charx'
    ) {
      let importedCharacter: CharacterImportOutcome | null | undefined
      if (
        res.headers.get('content-type') === 'application/zip' ||
        res.headers.get('content-type') === 'application/charx'
      ) {
        const data = new Uint8Array(await res.arrayBuffer())
        if (!isCurrent()) return
        importedCharacter = await importCharacterProcess(
          {
            name: 'realm.charx',
            data,
          },
          { sourceGeneration },
        )
      } else {
        importedCharacter = await importCharacterProcess(
          {
            name: 'realm.png',
            data: res.body!,
          },
          { sourceGeneration },
        )
      }
      if (!isCurrent()) return
      checkCharOrder()
      const index =
        importedCharacter?.status === 'accepted' ? characterOwnerIndexById(importedCharacter.characterId) : -1
      if (
        isLatestRealmImportOperation(realmImportOperationToken) &&
        index !== -1 &&
        shouldNavigateImportedCharacter(arg)
      ) {
        changeChar(index, {
          isFresh: () => isCurrent() && isLatestRealmImportOperation(realmImportOperationToken),
        })
      }
      return
    }

    const result = await res.json()
    if (!isCurrent()) return
    const data: CharacterCardV3 = result.card
    const img: string = result.img

    data.data.extensions.risuRealmImportId = id

    const image = await getHubResources(img)
    if (!isCurrent()) return
    const importedCharacter = await importCharacterCardSpec(
      data,
      image,
      'hub',
      {},
      undefined,
      undefined,
      undefined,
      sourceGeneration,
    )
    if (!isCurrent()) return
    checkCharOrder()
    const index = importedCharacter?.status === 'accepted' ? characterOwnerIndexById(importedCharacter.characterId) : -1
    if (
      isLatestRealmImportOperation(realmImportOperationToken) &&
      index !== -1 &&
      shouldNavigateImportedCharacter(arg)
    ) {
      changeChar(index, {
        isFresh: () => isCurrent() && isLatestRealmImportOperation(realmImportOperationToken),
      })
      alertStore.set({
        type: 'none',
        msg: '',
      })
    }
  } catch (error) {
    if (!isCurrent()) return
    console.error(error)
    console.log((error as Error)?.stack)
    alertError('Error while importing')
  }
}

async function finishServerRealmImport(
  imported: Extract<ServerRealmImportResult, { status: 'ok' }>,
  arg: {
    forceRedirect?: boolean
  },
  operationToken: number,
  sourceGeneration: number,
  reportProgress?: (progress: ServerRealmImportProgress) => void,
) {
  const isCurrent = () =>
    isClientWriteOperationCurrent(sourceGeneration) && isLatestRealmImportOperation(operationToken)
  if (!isCurrent()) {
    return
  }
  reportProgress?.({
    phase: 'refresh',
    message: 'Refreshing imported character',
    percent: 96,
  })
  let refreshResult: Awaited<ReturnType<typeof refreshServerRealmImportResources>>
  try {
    refreshResult = await refreshServerRealmImportResources(imported)
  } catch (error) {
    if (isCurrent()) {
      alertError(error instanceof Error && error.message ? error.message : 'Server resource refresh failed')
    }
    return
  }
  if (refreshResult.status !== 'ok') {
    if (isCurrent()) {
      alertError(refreshResult.status === 'error' ? refreshResult.error : 'Server resource refresh is unavailable')
    }
    return
  }
  if (!isCurrent()) {
    return
  }
  reportProgress?.({
    phase: 'refresh',
    message: 'Realm import complete',
    percent: 100,
  })
  checkCharOrder()
  const index = characterOwnerIndexById(imported.characterId)
  if (index !== -1 && shouldNavigateImportedCharacter(arg)) {
    changeChar(index, {
      isFresh: () => isCurrent(),
    })
    alertStore.set({
      type: 'none',
      msg: '',
    })
  } else {
    alertNormal(language.importedCharacter)
  }
}

function shouldNavigateImportedCharacter(arg: { forceRedirect?: boolean }): boolean {
  if (arg.forceRedirect) return true
  const sidebarStatus = settingsResourceState.groupStatuses.sidebar ?? settingsResourceState.status
  return (
    settingsResourceState.status !== 'error' &&
    sidebarStatus === 'ready' &&
    settingsResourceState.value.goCharacterOnImport === true
  )
}

function characterOwnerAt(index: number): character | undefined {
  if (charactersResourceState.status !== 'ready' || index < 0) return undefined
  const candidate = charactersResourceState.characters[index]
  return candidate?.chaId ? getCharacterResourceOwner(candidate.chaId) : undefined
}

function characterOwnerIndexById(characterId: string): number {
  if (charactersResourceState.status !== 'ready') return -1
  const owner = getCharacterResourceOwner(characterId)
  return owner ? charactersResourceState.characters.indexOf(owner) : -1
}

function showRealmImportProgress(progress: ServerRealmImportProgress) {
  alertProgress(progress.message, progress.percent)
}

export async function getHubResources(id: string) {
  const res = await fetch(`${hubURL}/resource/${id}`)
  if (res.status !== 200) {
    throw await res.text()
  }
  return Buffer.from(await res.arrayBuffer())
}

export function isCharacterHasAssets(char: character) {
  if (char.additionalAssets && char.additionalAssets.length > 0) {
    return true
  }

  if (char.emotionImages && char.emotionImages.length > 0) {
    return true
  }

  if (char.ccAssets && char.ccAssets.length > 0) {
    return true
  }

  return false
}

type CharacterCardV2Risu = {
  spec: 'chara_card_v2'
  spec_version: '2.0' // May 8th addition
  data: {
    name: string
    description: string
    personality: string
    scenario: string
    first_mes: string
    mes_example: string
    creator_notes: string
    system_prompt: string
    post_history_instructions: string
    alternate_greetings: string[]
    character_book?: CharacterBook
    tags: string[]
    creator: string
    character_version: string
    extensions: {
      risuai?: {
        emotions?: [string, string][]
        bias?: [string, number][]
        viewScreen?: any
        customScripts?: customscript[]
        utilityBot?: boolean
        sdData?: [string, string][]
        additionalAssets?: [string, string, string][]
        backgroundHTML?: string
        license?: string
        triggerscript?: triggerscript[]
        private?: boolean
        customNotificationMessage?: string
        notificationImage?: string
        additionalText?: string
        virtualscript?: string
        largePortrait?: boolean
        lorePlus?: boolean
        inlayViewScreen?: boolean
        newGenData?: {
          prompt: string
          negative: string
          instructions: string
          emotionInstructions: string
        }
        vits?: { [key: string]: string }
      }
      depth_prompt?: { depth: number; prompt: string }
    }
  }
}

interface OldTavernChar {
  avatar: 'none'
  chat: string
  create_date: string
  description: string
  first_mes: string
  mes_example: string
  name: string
  personality: string
  scenario: string
  talkativeness: '0.5'
  spec_version?: '1.0'
}
type CharacterBook = {
  name?: string
  description?: string
  scan_depth?: number // agnai: "Memory: Chat History Depth"
  token_budget?: number // agnai: "Memory: Context Limit"
  recursive_scanning?: boolean // no agnai equivalent. whether entry content can trigger other entries
  extensions: Record<string, any>
  entries: Array<charBookEntry>
}

interface charBookEntry {
  keys: Array<string>
  content: string
  extensions: Record<string, any>
  enabled: boolean
  insertion_order: number // if two entries inserted, lower "insertion order" = inserted higher

  // FIELDS WITH NO CURRENT EQUIVALENT IN SILLY
  name?: string // not used in prompt engineering
  priority?: number // if token budget reached, lower priority value = discarded first

  // FIELDS WITH NO CURRENT EQUIVALENT IN AGNAI
  id?: number // not used in prompt engineering
  comment?: string // not used in prompt engineering
  selective?: boolean // if `true`, require a key from both `keys` and `secondary_keys` to trigger the entry
  secondary_keys?: Array<string> // see field `selective`. ignored if selective == false
  constant?: boolean // if true, always inserted in the prompt (within budget limit)
  position?: 'before_char' | 'after_char' // whether the entry is placed before or after the character defs
  case_sensitive?: boolean
  use_regex?: boolean
  mode?: string // Risuai mode field
  folder?: string // Risuai folder field
}

interface RccCardMetaData {
  usePassword?: boolean
}
