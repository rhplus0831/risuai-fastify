import { canUseClientWriteAccess, captureClientSessionGeneration } from '../../clientSession'
import {
  captureClientWriteOperation,
  assertClientWriteOperation,
  isClientWriteOperationCurrent,
} from '../../clientWriteOperation'
import localforage from 'localforage'
import { getImageType } from 'src/ts/media'
import { getModelInfo, LLMFlags, type LLMFormat, type LLMModel } from 'src/ts/model/modellist'
import { asBuffer } from '../../util'
import {
  readServerAsset,
  serverAssetIdFromReference,
  SERVER_INLAY_SIGNATURE_CONTENT_TYPE,
  uploadServerAssetBytes,
} from '../../server/assets'
import {
  deleteServerInlayCatalogCommand,
  runServerCommand,
  upsertServerInlayCatalogCommand,
} from '../../server/commands'
import {
  applyServerInlayCatalogDeletionReceipt,
  applyServerInlayCatalogEntryReceipt,
  applyServerInlayCatalogResource,
  findServerInlayCatalogEntry,
  getServerInlayCatalogResource,
  type ServerInlayCatalogEntry,
} from '../../server/inlayCatalog'
import { fetchServerInlayCatalog } from '../../server/resourceReads'
import { settingsResourceState } from '../../server/resourceState.svelte'

export type InlayAsset = {
  data?: string | Blob
  /** File extension */
  ext: string
  height?: number
  name: string
  /** Immutable server byte size. */
  size?: number
  /** Fastify server asset id for browser-local legacy inlay ids. */
  serverAssetId?: string
  /** Browser compatibility cache marker; never an authoritative catalog row. */
  serverCatalogCache?: true
  type: 'image' | 'video' | 'audio' | 'signature'
  width?: number
}

const inlayImageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']

const inlayAudioExts = ['wav', 'mp3', 'ogg', 'flac']

const inlayVideoExts = ['webm', 'mp4', 'mkv']

export const MAX_INLAY_SOURCE_PIXELS = 16 * 1024 * 1024

const inlayStorage = localforage.createInstance({
  name: 'inlay',
  storeName: 'inlay',
})

function inlayContentType(type: InlayAsset['type'], ext: string): string {
  if (type === 'signature') return SERVER_INLAY_SIGNATURE_CONTENT_TYPE
  if (type === 'image') return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  if (type === 'audio') {
    if (ext === 'mp3') return 'audio/mpeg'
    return `audio/${ext}`
  }
  if (ext === 'mkv') return 'video/x-matroska'
  return `video/${ext}`
}

function inlayTypeFromContentType(contentType: string): InlayAsset['type'] | null {
  if (contentType === SERVER_INLAY_SIGNATURE_CONTENT_TYPE) return 'signature'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('audio/')) return 'audio'
  if (contentType.startsWith('video/')) return 'video'
  return null
}

function dataUriToBytes(data: string): { bytes: Uint8Array; contentType: string } {
  const splitDataURI = data.split(',')
  const byteString = atob(splitDataURI[1] ?? '')
  const contentType = splitDataURI[0]?.split(':')[1]?.split(';')[0] ?? 'application/octet-stream'

  const bytes = new Uint8Array(byteString.length)
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i)
  }
  return { bytes, contentType }
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

async function uploadInlayAssetToServer(img: InlayAsset, operation: number): Promise<string> {
  assertClientWriteOperation(operation)
  if (img.serverAssetId) return img.serverAssetId
  if (img.data === undefined) {
    throw new Error(`Inlay asset ${img.name} has no local bytes to upload`)
  }

  if (img.data instanceof Blob) {
    const contentType = img.data.type || inlayContentType(img.type, img.ext)
    const bytes = await blobToBytes(img.data)
    assertClientWriteOperation(operation)
    return uploadServerAssetBytes(bytes, contentType)
  }

  if (img.type === 'signature') {
    return uploadServerAssetBytes(new TextEncoder().encode(img.data), SERVER_INLAY_SIGNATURE_CONTENT_TYPE)
  }

  const { bytes, contentType } = dataUriToBytes(img.data)
  return uploadServerAssetBytes(bytes, contentType || inlayContentType(img.type, img.ext))
}

async function rememberServerInlayAsset(
  id: string,
  img: InlayAsset & { serverAssetId: string },
  aliases: readonly string[] = [],
  operation = captureClientWriteOperation(),
): Promise<void> {
  assertClientWriteOperation(operation)
  const allAliases = Array.from(new Set([...(id !== img.serverAssetId ? [id] : []), ...aliases])).filter(
    (alias) => alias !== img.serverAssetId,
  )
  const result = await runServerCommand({
    command: (baseRevision) =>
      upsertServerInlayCatalogCommand({
        assetId: img.serverAssetId,
        aliases: allAliases,
        baseRevision,
        name: img.name,
        ...(typeof img.width === 'number' && img.width > 0 ? { width: img.width } : {}),
        ...(typeof img.height === 'number' && img.height > 0 ? { height: img.height } : {}),
      }),
  })
  if (result.status !== 'ok') {
    if (result.status === 'error' && result.reason === 'not-found') {
      throw new MissingServerInlayAssetError(img.serverAssetId)
    }
    throw new Error(
      result.status === 'conflict'
        ? `Inlay catalog changed on another client (revision ${result.currentRevision})`
        : result.status === 'error'
          ? result.error
          : 'Inlay catalog is unavailable',
    )
  }
  if (!isClientWriteOperationCurrent(operation)) return
  applyServerInlayCatalogEntryReceipt(result.asset, result.revision)
  const cached = { ...img, data: undefined, serverCatalogCache: true as const }
  try {
    await Promise.all(
      Array.from(new Set([id, img.serverAssetId, ...allAliases])).map((key) => inlayStorage.setItem(key, cached)),
    )
  } catch (error) {
    console.warn('Unable to update the browser inlay compatibility cache', error)
  }
}

class MissingServerInlayAssetError extends Error {
  constructor(readonly assetId: string) {
    super(`Server inlay asset does not exist: ${assetId}`)
    this.name = 'MissingServerInlayAssetError'
  }
}

function getLoadedImageDimensions(imgObj: HTMLImageElement) {
  const width = imgObj.width || imgObj.naturalWidth
  const height = imgObj.height || imgObj.naturalHeight
  return { width, height }
}

function hasLoadedImageDimensions(imgObj: HTMLImageElement) {
  const { width, height } = getLoadedImageDimensions(imgObj)
  return width > 0 && height > 0
}

function assertInlayImageDecodeBudget(width: number, height: number) {
  if (width * height > MAX_INLAY_SOURCE_PIXELS) {
    throw new Error('Inlay image is too large to process safely')
  }
}

function imageLoadError(error?: unknown) {
  if (error instanceof Error) return error
  return new Error('Inlay image failed to load')
}

async function waitForInlayImageLoad(imgObj: HTMLImageElement) {
  if (typeof imgObj.decode === 'function') {
    let rejectOnError: ((error: Error) => void) | null = null
    const errorPromise = new Promise<never>((_, reject) => {
      rejectOnError = reject
    })
    const onError = () => rejectOnError?.(new Error('Inlay image failed to load'))
    imgObj.addEventListener('error', onError, { once: true })
    try {
      await Promise.race([imgObj.decode(), errorPromise])
      if (hasLoadedImageDimensions(imgObj)) return
    } catch (error) {
      if (imgObj.complete && hasLoadedImageDimensions(imgObj)) return
      throw imageLoadError(error)
    } finally {
      imgObj.removeEventListener('error', onError)
    }
  }

  if (imgObj.complete) {
    if (hasLoadedImageDimensions(imgObj)) return
    throw new Error('Inlay image failed to load')
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      imgObj.removeEventListener('load', onLoad)
      imgObj.removeEventListener('error', onError)
    }
    const onLoad = () => {
      cleanup()
      if (hasLoadedImageDimensions(imgObj)) {
        resolve()
      } else {
        reject(new Error('Inlay image loaded without dimensions'))
      }
    }
    const onError = () => {
      cleanup()
      reject(new Error('Inlay image failed to load'))
    }
    imgObj.addEventListener('load', onLoad, { once: true })
    imgObj.addEventListener('error', onError, { once: true })

    if (imgObj.complete) {
      if (hasLoadedImageDimensions(imgObj)) {
        onLoad()
      } else {
        onError()
      }
    }
  })
}

export async function postInlayAsset(img: { name: string; data: Uint8Array }) {
  const operation = captureClientWriteOperation()
  const extention = img.name.split('.').at(-1)?.toLowerCase()
  const imgObj = new Image()

  if (extention && inlayImageExts.includes(extention)) {
    const imgURL = URL.createObjectURL(new Blob([asBuffer(img.data)], { type: `image/${extention}` }))
    try {
      imgObj.src = imgURL
      return await writeInlayImage(imgObj, {
        name: img.name,
        ext: extention,
      })
    } finally {
      URL.revokeObjectURL(imgURL)
    }
  }

  if (extention && inlayAudioExts.includes(extention)) {
    const assetId = await uploadServerAssetBytes(img.data, inlayContentType('audio', extention))
    assertClientWriteOperation(operation)
    await rememberServerInlayAsset(
      assetId,
      {
        name: img.name,
        ext: extention,
        type: 'audio',
        serverAssetId: assetId,
      },
      [],
      operation,
    )
    return assetId
  }

  if (extention && inlayVideoExts.includes(extention)) {
    const assetId = await uploadServerAssetBytes(img.data, inlayContentType('video', extention))
    assertClientWriteOperation(operation)
    await rememberServerInlayAsset(
      assetId,
      {
        name: img.name,
        ext: extention,
        type: 'video',
        serverAssetId: assetId,
      },
      [],
      operation,
    )
    return assetId
  }

  return null
}

export async function writeInlayImage(
  imgObj: HTMLImageElement,
  arg: { name?: string; ext?: string; id?: string } = {},
) {
  const operation = captureClientWriteOperation()
  let drawHeight = 0
  let drawWidth = 0
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  await waitForInlayImageLoad(imgObj)
  assertClientWriteOperation(operation)
  ;({ height: drawHeight, width: drawWidth } = getLoadedImageDimensions(imgObj))
  assertInlayImageDecodeBudget(drawWidth, drawHeight)

  //resize image to fit inlay, if total pixels exceed 1024*1024
  const maxPixels = 1024 * 1024
  const currentPixels = drawHeight * drawWidth

  if (currentPixels > maxPixels) {
    const scaleFactor = Math.sqrt(maxPixels / currentPixels)
    drawWidth = Math.floor(drawWidth * scaleFactor)
    drawHeight = Math.floor(drawHeight * scaleFactor)
  }

  canvas.width = drawWidth
  canvas.height = drawHeight
  ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
  const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))

  const bytes = await blobToBytes(imageBlob as Blob)
  assertClientWriteOperation(operation)
  const assetId = await uploadServerAssetBytes(bytes, 'image/png')
  assertClientWriteOperation(operation)
  await rememberServerInlayAsset(
    assetId,
    {
      name: arg.name ?? assetId,
      ext: 'png',
      height: drawHeight,
      width: drawWidth,
      type: 'image',
      serverAssetId: assetId,
    },
    arg.id && arg.id !== assetId ? [arg.id] : [],
    operation,
  )
  return assetId
}

export type InlaySignature = {
  signatures: {
    type: 'function' | 'text'
    content: string
  }[]
  sourceFormat: LLMFormat
  source: string
}

export async function saveInlayedSignature(sigid: string, signature: InlaySignature) {
  const operation = captureClientWriteOperation()
  const data = JSON.stringify(signature)
  const assetId = await uploadServerAssetBytes(new TextEncoder().encode(data), SERVER_INLAY_SIGNATURE_CONTENT_TYPE)
  await rememberServerInlayAsset(
    assetId,
    {
      name: sigid,
      ext: 'json',
      type: 'signature',
      serverAssetId: assetId,
    },
    sigid !== assetId ? [sigid] : [],
    operation,
  )
  return assetId
}

function base64ToBlob(b64: string): Blob {
  const splitDataURI = b64.split(',')
  const byteString = atob(splitDataURI[1])
  const mimeString = splitDataURI[0].split(':')[1].split(';')[0]

  const ab = new ArrayBuffer(byteString.length)
  const ia = new Uint8Array(ab)
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i)
  }

  return new Blob([ab], { type: mimeString })
}

function blobToBase64(blob: Blob): Promise<string> {
  const reader = new FileReader()
  reader.readAsDataURL(blob)
  return new Promise<string>((resolve, reject) => {
    reader.onloadend = () => {
      resolve(reader.result as string)
    }
    reader.onerror = reject
  })
}

function catalogEntryToInlayAsset(entry: ServerInlayCatalogEntry): InlayAsset {
  return {
    ext: entry.ext,
    ...(entry.height !== undefined ? { height: entry.height } : {}),
    name: entry.name,
    serverAssetId: entry.assetId,
    size: entry.size,
    type: entry.type,
    ...(entry.width !== undefined ? { width: entry.width } : {}),
  }
}

async function ensureServerInlayCatalog(): Promise<void> {
  if (getServerInlayCatalogResource()) return
  const result = await fetchServerInlayCatalog()
  if (result.status !== 'ok') {
    throw new Error(result.status === 'error' ? result.error : 'Inlay catalog is unavailable')
  }
  if (!applyServerInlayCatalogResource(result)) throw new Error('Unable to apply the server inlay catalog')
}

let legacyCatalogMigration: Promise<void> | null = null

async function migrateLegacyInlayCatalog(): Promise<void> {
  if (!canUseClientWriteAccess()) {
    await ensureServerInlayCatalog()
    return
  }
  const operation = captureClientWriteOperation()
  if (legacyCatalogMigration) return legacyCatalogMigration
  const migration = (async () => {
    await ensureServerInlayCatalog()
    const localEntries: Array<[string, InlayAsset]> = []
    await inlayStorage.iterate<InlayAsset, void>((value, key) => {
      localEntries.push([key, value])
    })

    assertClientWriteOperation(operation)
    const grouped = new Map<string, { aliases: Set<string>; asset: InlayAsset & { serverAssetId: string } }>()
    for (const [key, local] of localEntries) {
      assertClientWriteOperation(operation)
      if (local.serverCatalogCache) {
        const cachedAssetId = local.serverAssetId ?? serverAssetIdFromReference(key)
        if (!cachedAssetId || !findServerInlayCatalogEntry(cachedAssetId)) await inlayStorage.removeItem(key)
        continue
      }
      let assetId = local.serverAssetId ?? serverAssetIdFromReference(key)
      if (!assetId && local.data !== undefined) assetId = await uploadInlayAssetToServer(local, operation)
      if (!assetId) {
        // Metadata without either durable bytes or a server id is a stale
        // browser-only ghost, not an authoritative catalog row.
        await inlayStorage.removeItem(key)
        continue
      }
      const group = grouped.get(assetId) ?? {
        aliases: new Set<string>(),
        asset: { ...local, serverAssetId: assetId },
      }
      if (key !== assetId) group.aliases.add(key)
      grouped.set(assetId, group)
    }

    for (const [assetId, group] of grouped) {
      const existing = findServerInlayCatalogEntry(assetId)
      const aliases = [...group.aliases]
      if (existing && aliases.every((alias) => existing.aliases.includes(alias))) continue
      try {
        await rememberServerInlayAsset(assetId, group.asset, aliases, operation)
      } catch (error) {
        if (!(error instanceof MissingServerInlayAssetError)) throw error
        await Promise.all([assetId, ...aliases].map((key) => inlayStorage.removeItem(key)))
      }
    }
  })()
  legacyCatalogMigration = migration
  try {
    await migration
  } finally {
    if (legacyCatalogMigration === migration) legacyCatalogMigration = null
  }
}

// Returns with base64 data URI
export async function getInlayAsset(id: string) {
  const serverAsset = await getServerInlayAssetId(id)
  if (serverAsset) {
    const meta = findServerInlayCatalogEntry(id) ?? findServerInlayCatalogEntry(serverAsset)
    const localMeta = await inlayStorage.getItem<InlayAsset | null>(id)
    try {
      const stored = await readServerAsset(serverAsset)
      const type = inlayTypeFromContentType(stored.contentType)
      if (type) {
        const data =
          type === 'signature'
            ? new TextDecoder().decode(stored.bytes)
            : `data:${stored.contentType};base64,${Buffer.from(stored.bytes).toString('base64')}`
        return {
          name: meta?.name ?? localMeta?.name ?? serverAsset,
          ext: meta?.ext ?? localMeta?.ext ?? stored.extension,
          height: meta?.height ?? localMeta?.height,
          width: meta?.width ?? localMeta?.width,
          type,
          serverAssetId: serverAsset,
          data,
        } satisfies InlayAsset & { data: string }
      }
    } catch {
      // Fall through to the browser-local legacy read below.
    }
  }

  const img = await inlayStorage.getItem<InlayAsset | null>(id)
  if (img === null) {
    return null
  }
  if (img.data === undefined) return null

  let data: string
  if (img.data instanceof Blob) {
    data = await blobToBase64(img.data)
  } else {
    data = img.data as string
  }

  return { ...img, data }
}

// Returns with Blob
export async function getInlayAssetBlob(id: string) {
  const operation = captureClientSessionGeneration()
  const serverAsset = await getServerInlayAssetId(id)
  if (serverAsset) {
    const meta = findServerInlayCatalogEntry(id) ?? findServerInlayCatalogEntry(serverAsset)
    const localMeta = await inlayStorage.getItem<InlayAsset | null>(id)
    try {
      const stored = await readServerAsset(serverAsset)
      const type = inlayTypeFromContentType(stored.contentType)
      if (type) {
        return {
          name: meta?.name ?? localMeta?.name ?? serverAsset,
          ext: meta?.ext ?? localMeta?.ext ?? stored.extension,
          height: meta?.height ?? localMeta?.height,
          width: meta?.width ?? localMeta?.width,
          type,
          serverAssetId: serverAsset,
          data: new Blob([asBuffer(stored.bytes)], { type: stored.contentType }),
        } satisfies InlayAsset & { data: Blob }
      }
    } catch {
      // Fall through to the browser-local legacy read below.
    }
  }

  const img = await inlayStorage.getItem<InlayAsset | null>(id)
  if (img === null) {
    return null
  }
  if (img.data === undefined) return null

  let data: Blob
  if (typeof img.data === 'string') {
    // Migrate to Blob
    data = base64ToBlob(img.data)
    if (isClientWriteOperationCurrent(operation))
      void setInlayAsset(id, { ...img, data }).catch((error) => {
        console.warn('Unable to migrate the browser-local inlay asset', error)
      })
  } else {
    data = img.data
  }

  return { ...img, data }
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
  await migrateLegacyInlayCatalog()
  return (getServerInlayCatalogResource()?.assets ?? []).map((entry) => [
    entry.assetId,
    catalogEntryToInlayAsset(entry),
  ])
}

export async function setInlayAsset(id: string, img: InlayAsset) {
  const operation = captureClientWriteOperation()
  const assetId = await uploadInlayAssetToServer(img, operation)
  await rememberServerInlayAsset(id, { ...img, serverAssetId: assetId }, [], operation)
  return assetId
}

export async function removeInlayAsset(id: string) {
  const operation = captureClientWriteOperation()
  await ensureServerInlayCatalog()
  assertClientWriteOperation(operation)
  const catalogEntry = findServerInlayCatalogEntry(id)
  if (!catalogEntry) {
    await inlayStorage.removeItem(id)
    return
  }

  const result = await runServerCommand({
    command: (baseRevision) => deleteServerInlayCatalogCommand({ assetId: catalogEntry.assetId, baseRevision }),
  })
  if (result.status !== 'ok') {
    throw new Error(
      result.status === 'conflict'
        ? `Inlay catalog changed on another client (revision ${result.currentRevision})`
        : result.status === 'error'
          ? result.error
          : 'Inlay catalog is unavailable',
    )
  }
  if (!isClientWriteOperationCurrent(operation)) return
  applyServerInlayCatalogDeletionReceipt(catalogEntry.assetId, result.revision)

  const aliases: string[] = []
  await inlayStorage.iterate<InlayAsset, void>((value, key) => {
    if (key === id || value.serverAssetId === catalogEntry.assetId) {
      aliases.push(key)
    }
  })
  assertClientWriteOperation(operation)
  await Promise.all(aliases.map((key) => inlayStorage.removeItem(key)))
}

export function supportsInlayImage(modelInfo?: Pick<LLMModel, 'flags'>) {
  if (modelInfo) return modelInfo.flags.includes(LLMFlags.hasImageInput)
  return false
}

export async function getServerInlayAssetId(id: string): Promise<string | null> {
  const operation = captureClientSessionGeneration()
  const direct = serverAssetIdFromReference(id)
  if (direct) return direct

  await ensureServerInlayCatalog()
  const catalogEntry = findServerInlayCatalogEntry(id)
  if (catalogEntry) return catalogEntry.assetId

  const img = await inlayStorage.getItem<InlayAsset | null>(id)
  if (!img) return null
  if (img.serverCatalogCache) {
    await inlayStorage.removeItem(id)
    return null
  }
  if (img.serverAssetId) return img.serverAssetId
  if (!isClientWriteOperationCurrent(operation)) return null

  const assetId = await uploadInlayAssetToServer(img, operation)
  await rememberServerInlayAsset(id, { ...img, serverAssetId: assetId }, [], operation)
  return assetId
}

export async function getInlayAssetMetadata(
  id: string,
): Promise<Pick<InlayAsset, 'height' | 'name' | 'type' | 'width'> | null> {
  await ensureServerInlayCatalog()
  const catalogEntry = findServerInlayCatalogEntry(id)
  if (catalogEntry) {
    return {
      name: catalogEntry.name,
      type: catalogEntry.type,
      ...(catalogEntry.height !== undefined ? { height: catalogEntry.height } : {}),
      ...(catalogEntry.width !== undefined ? { width: catalogEntry.width } : {}),
    }
  }
  const img = await inlayStorage.getItem<InlayAsset | null>(id)
  if (!img) return null
  if (img.serverCatalogCache) {
    await inlayStorage.removeItem(id)
    return null
  }
  return {
    name: img.name,
    type: img.type,
    ...(typeof img.height === 'number' ? { height: img.height } : {}),
    ...(typeof img.width === 'number' ? { width: img.width } : {}),
  }
}

export async function reencodeImage(img: Uint8Array) {
  if (getImageType(img) === 'PNG') {
    return img
  }
  const canvas = document.createElement('canvas')
  const imgObj = new Image()
  const imgURL = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/png` }))
  try {
    imgObj.src = imgURL
    await imgObj.decode()
    let drawHeight = imgObj.height
    let drawWidth = imgObj.width
    assertInlayImageDecodeBudget(drawWidth, drawHeight)
    canvas.width = drawWidth
    canvas.height = drawHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    const b = Buffer.from(b64, 'base64')
    return b
  } finally {
    URL.revokeObjectURL(imgURL)
  }
}
