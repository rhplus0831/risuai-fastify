import { resetClientSessionForTests } from '../../../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../../../__tests__/managedClientSession'
import fc from 'fast-check'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InlayAsset } from '../inlays'
import {
  getInlayAsset,
  getInlayAssetBlob,
  listInlayAssets,
  MAX_INLAY_SOURCE_PIXELS,
  postInlayAsset,
  reencodeImage,
  removeInlayAsset,
  setInlayAsset,
  supportsInlayImage,
  writeInlayImage,
} from '../inlays'
import { getImageType } from 'src/ts/media'
import { getModelInfo, LLMFlags } from 'src/ts/model/modellist'
import { uploadServerAssetBytes } from 'src/ts/server/assets'

const settingsOwnerState = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  groupStatuses: {} as Record<string, 'idle' | 'loading' | 'ready' | 'error'>,
}))

//#region module mocks

/** Server asset upload stub: returns a deterministic asset id from content bytes. */
const serverAssetStore = new Map<string, { bytes: Uint8Array; contentType: string }>()
const catalogStore = new Map<string, any>()
let catalogRevision = 0

function fakeAssetId(bytes: Uint8Array): string {
  // Deterministic 64-hex-char id based on byte length for test reproducibility.
  return 'a'.repeat(64 - String(bytes.length).length) + String(bytes.length)
}

vi.mock('src/ts/server/assets', () => ({
  SERVER_INLAY_SIGNATURE_CONTENT_TYPE: 'application/x-risu-inlay-signature+json',
  serverAssetIdFromReference: vi.fn((id: string) => (/^[a-f0-9]{64}$/.test(id) ? id : null)),
  uploadServerAssetBytes: vi.fn(async (data: Uint8Array, contentType: string) => {
    const id = fakeAssetId(data)
    serverAssetStore.set(id, { bytes: data, contentType })
    return id
  }),
  readServerAsset: vi.fn(async (id: string) => {
    const entry = serverAssetStore.get(id)
    if (!entry) throw new Error(`Asset not found: ${id}`)
    return {
      bytes: entry.bytes,
      contentType: entry.contentType,
      extension: 'png',
    }
  }),
}))

vi.mock('src/ts/server/commands', () => ({
  runServerCommand: vi.fn(async ({ command }: { command: (revision: number) => Promise<unknown> }) =>
    command(catalogRevision),
  ),
  upsertServerInlayCatalogCommand: vi.fn(async (input: any) => {
    const stored = serverAssetStore.get(input.assetId)
    if (!stored) return { status: 'error', error: 'Asset not found' }
    catalogRevision += 1
    const type = stored.contentType.startsWith('image/')
      ? 'image'
      : stored.contentType.startsWith('audio/')
        ? 'audio'
        : stored.contentType.startsWith('video/')
          ? 'video'
          : 'signature'
    const existing = catalogStore.get(input.assetId)
    const asset = {
      assetId: input.assetId,
      aliases: Array.from(new Set([...(existing?.aliases ?? []), ...(input.aliases ?? [])])),
      ext: input.name.split('.').at(-1) || (type === 'signature' ? 'json' : 'png'),
      name: input.name,
      size: stored.bytes.byteLength,
      type,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
    }
    catalogStore.set(input.assetId, asset)
    return {
      status: 'ok',
      revision: catalogRevision,
      event: { type: 'inlayCatalog.upserted', resource: 'inlayCatalog', id: input.assetId, revision: catalogRevision },
      asset,
    }
  }),
  deleteServerInlayCatalogCommand: vi.fn(async (input: any) => {
    if (!catalogStore.delete(input.assetId)) return { status: 'error', error: 'Inlay catalog asset not found' }
    catalogRevision += 1
    return {
      status: 'ok',
      revision: catalogRevision,
      event: { type: 'inlayCatalog.deleted', resource: 'inlayCatalog', id: input.assetId, revision: catalogRevision },
      assetId: input.assetId,
    }
  }),
}))

vi.mock('src/ts/server/inlayCatalog', () => ({
  applyServerInlayCatalogDeletionReceipt: vi.fn(() => true),
  applyServerInlayCatalogEntryReceipt: vi.fn(() => true),
  applyServerInlayCatalogResource: vi.fn((resource: any) => {
    catalogRevision = resource.revision
    catalogStore.clear()
    for (const asset of resource.assets) catalogStore.set(asset.assetId, asset)
    return true
  }),
  fetchServerInlayCatalog: vi.fn(async () => ({
    status: 'ok',
    revision: catalogRevision,
    assets: [...catalogStore.values()],
  })),
  findServerInlayCatalogEntry: vi.fn(
    (id: string) =>
      [...catalogStore.values()].find((entry) => entry.assetId === id || entry.aliases.includes(id)) ?? null,
  ),
  getServerInlayCatalogResource: vi.fn(() => ({
    revision: catalogRevision,
    assets: [...catalogStore.values()],
  })),
}))

vi.mock('src/ts/server/resourceReads', () => ({
  fetchServerInlayCatalog: vi.fn(async () => ({
    status: 'ok',
    revision: catalogRevision,
    assets: [...catalogStore.values()],
  })),
}))

// happy-dom canvas getContext returns null
const fakeCtx = {
  drawImage: vi.fn(),
}
const origCreateElement = document.createElement.bind(document)
vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: any) => {
  const el = origCreateElement(tag, options)
  if (tag === 'canvas') {
    ;(el as HTMLCanvasElement).getContext = (() => fakeCtx) as any
    ;(el as HTMLCanvasElement).toBlob = ((cb: BlobCallback) => {
      cb(new Blob(['fake-png'], { type: 'image/png' }))
    }) as any
  }
  return el
})

const store = new Map<string, unknown>()

vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value)
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key)
      }),
      iterate: vi.fn(async (cb: (value: unknown, key: string) => void) => {
        for (const [key, value] of store) {
          cb(value, key)
        }
      }),
    }),
  },
}))

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}))

vi.mock(import('src/ts/media'), () => ({
  getImageType: vi.fn(),
}))

vi.mock(import('src/ts/model/modellist'), () => ({
  getModelInfo: vi.fn(),
  LLMFlags: { hasImageInput: 0 } as never,
}))

vi.mock(
  import('src/ts/server/resourceState.svelte'),
  () =>
    ({
      settingsResourceState: settingsOwnerState,
    }) as unknown as typeof import('src/ts/server/resourceState.svelte'),
)

vi.mock(
  import('src/ts/util'),
  () =>
    ({
      asBuffer: (arr: Uint8Array) => arr,
    }) as typeof import('src/ts/util'),
)

//#endregion

const supportedAudioExts = ['wav', 'mp3', 'ogg', 'flac'] as const
const supportedVideoExts = ['webm', 'mp4', 'mkv'] as const
const supportedImageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'] as const
const allSupportedExts = [...supportedAudioExts, ...supportedVideoExts, ...supportedImageExts]

function makeImage(
  w: number,
  h: number,
  options: {
    complete?: boolean
    decode?: (() => Promise<void>) | null
    naturalHeight?: number
    naturalWidth?: number
  } = {},
): HTMLImageElement {
  const img = new Image()
  const decode = options.decode === null ? undefined : (options.decode ?? vi.fn(async () => {}))
  Object.defineProperty(img, 'width', { get: () => w })
  Object.defineProperty(img, 'height', { get: () => h })
  Object.defineProperty(img, 'naturalWidth', { get: () => options.naturalWidth ?? w })
  Object.defineProperty(img, 'naturalHeight', { get: () => options.naturalHeight ?? h })
  Object.defineProperty(img, 'complete', { get: () => options.complete ?? true })
  Object.defineProperty(img, 'decode', { value: decode })
  return img
}

class FakeLoadedImage extends EventTarget {
  complete = true
  height = 24
  naturalHeight = 24
  naturalWidth = 32
  width = 32
  decode = vi.fn(async () => {})
  src = ''
}

class FakeBrokenImage extends EventTarget {
  complete = false
  height = 0
  naturalHeight = 0
  naturalWidth = 0
  width = 0
  decode = vi.fn(async () => {
    throw new Error('decode failed')
  })
  src = ''
}

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  serverAssetStore.clear()
  catalogStore.clear()
  catalogRevision = 0
  settingsOwnerState.value = {}
  settingsOwnerState.status = 'idle'
  settingsOwnerState.groupStatuses = {}
})

describe('supportsInlayImage', () => {
  test('uses request-scoped model flags when provided', () => {
    expect(supportsInlayImage({ flags: [LLMFlags.hasImageInput] })).toBe(true)
    expect(supportsInlayImage({ flags: [] })).toBe(false)
    expect(getModelInfo).not.toHaveBeenCalled()
  })

  test('requires request-scoped model flags', () => {
    vi.mocked(getModelInfo).mockReturnValue({ flags: [LLMFlags.hasImageInput] } as never)

    expect(supportsInlayImage()).toBe(false)
    expect(getModelInfo).not.toHaveBeenCalled()
  })

  test('fails closed instead of using the legacy fallback after an owner error', () => {
    settingsOwnerState.status = 'ready'
    settingsOwnerState.groupStatuses.providers = 'error'
    expect(supportsInlayImage()).toBe(false)
    expect(getModelInfo).not.toHaveBeenCalled()
  })
})

describe('setInlayAsset', () => {
  test('uploads to server and remembers metadata in local storage', async () => {
    const asset: InlayAsset = {
      data: new Blob(['hello'], { type: 'text/plain' }),
      ext: 'png',
      height: 100,
      width: 100,
      name: 'test.png',
      type: 'image',
    }

    const assetId = await setInlayAsset('asset-1', asset)

    // The server store received the upload.
    expect(serverAssetStore.has(assetId)).toBe(true)
    // Local store holds metadata without data, keyed by the original id.
    const remembered = store.get('asset-1') as InlayAsset
    expect(remembered).toMatchObject({
      name: 'test.png',
      ext: 'png',
      height: 100,
      width: 100,
      type: 'image',
      serverAssetId: assetId,
    })
    expect(remembered.data).toBeUndefined()
  })

  test('overwrites an existing asset with the same id', async () => {
    const first: InlayAsset = {
      data: new Blob(['a']),
      ext: 'png',
      height: 10,
      name: 'first.png',
      type: 'image',
      width: 10,
    }
    const second: InlayAsset = {
      data: new Blob(['b']),
      ext: 'png',
      height: 20,
      name: 'second.png',
      type: 'image',
      width: 20,
    }

    await setInlayAsset('id-1', first)
    await setInlayAsset('id-1', second)

    expect(store.get('id-1') as InlayAsset).toMatchObject({
      height: 20,
      name: 'second.png',
      type: 'image',
      width: 20,
    })
  })
})

describe('getInlayAsset', () => {
  test('returns null for a non-existent id', async () => {
    const result = await getInlayAsset('does-not-exist')
    expect(result).toBeNull()
  })

  test('returns asset with base64 data URI when metadata has serverAssetId', async () => {
    const serverBytes = new TextEncoder().encode('test-data')
    const assetId = fakeAssetId(serverBytes)
    serverAssetStore.set(assetId, { bytes: serverBytes, contentType: 'image/png' })
    store.set('blob-id', {
      ext: 'png',
      height: 50,
      width: 50,
      name: 'blob-asset.png',
      type: 'image',
      serverAssetId: assetId,
    } satisfies InlayAsset)

    const result = await getInlayAsset('blob-id')

    expect(result!.data).toMatch(/^data:/)
    expect(result!.name).toBe('blob-asset.png')
  })

  test('falls back to legacy local Blob data when no serverAssetId', async () => {
    const blob = new Blob(['legacy-local'], { type: 'image/png' })
    store.set('legacy-id', {
      data: blob,
      ext: 'png',
      height: 50,
      width: 50,
      name: 'legacy.png',
      type: 'image',
    } satisfies InlayAsset)

    const result = await getInlayAsset('legacy-id')

    expect(result!.data).toMatch(/^data:/)
    expect(result!.name).toBe('legacy.png')
  })

  test('falls back to legacy local string data when no serverAssetId', async () => {
    const b64 = 'data:image/png;base64,aGVsbG8='
    store.set('str-id', {
      data: b64,
      ext: 'png',
      height: 50,
      width: 50,
      name: 'string-asset.png',
      type: 'image',
    } satisfies InlayAsset)

    const result = await getInlayAsset('str-id')
    expect(result!.data).toBe(b64)
  })
})

describe('getInlayAssetBlob', () => {
  test('returns null for a non-existent id', async () => {
    const result = await getInlayAssetBlob('does-not-exist')
    expect(result).toBeNull()
  })

  test('returns Blob from server when metadata has serverAssetId', async () => {
    const serverBytes = new TextEncoder().encode('binary-data')
    const assetId = fakeAssetId(serverBytes)
    serverAssetStore.set(assetId, { bytes: serverBytes, contentType: 'image/png' })
    store.set('blob-id', {
      ext: 'png',
      height: 64,
      width: 64,
      name: 'blob.png',
      type: 'image',
      serverAssetId: assetId,
    } satisfies InlayAsset)

    const result = await getInlayAssetBlob('blob-id')
    expect(result!.data).toBeInstanceOf(Blob)
  })

  test('falls back to legacy local Blob when no serverAssetId', async () => {
    const blob = new Blob(['binary-data'], { type: 'image/png' })
    store.set('blob-id', {
      data: blob,
      ext: 'png',
      height: 64,
      width: 64,
      name: 'blob.png',
      type: 'image',
    } satisfies InlayAsset)

    const result = await getInlayAssetBlob('blob-id')
    expect(result!.data).toBeInstanceOf(Blob)
  })

  test('migrates legacy string data to Blob and updates storage', async () => {
    const b64 = 'data:image/png;base64,aGVsbG8='
    store.set('legacy-id', {
      data: b64,
      ext: 'png',
      height: 32,
      width: 32,
      name: 'legacy.png',
      type: 'image',
    } satisfies InlayAsset)

    const result = await getInlayAssetBlob('legacy-id')
    expect(result!.data).toBeInstanceOf(Blob)
    expect(await (result!.data as Blob).text()).toBe('hello')

    const expectedBytes = new TextEncoder().encode('hello')
    const expectedAssetId = fakeAssetId(expectedBytes)
    await vi.waitFor(() => {
      expect(store.get('legacy-id')).toMatchObject({
        ext: 'png',
        height: 32,
        name: 'legacy.png',
        serverAssetId: expectedAssetId,
        type: 'image',
        width: 32,
      })
    })

    expect(uploadServerAssetBytes).toHaveBeenCalledTimes(1)
    const [uploadedBytes, uploadedContentType] = vi.mocked(uploadServerAssetBytes).mock.calls[0]
    expect(uploadedBytes).toEqual(expectedBytes)
    expect(uploadedContentType).toBe('image/png')
    expect((store.get('legacy-id') as InlayAsset).data).toBeUndefined()
  })

  test('returns a legacy Blob without an unhandled rejection when background migration fails', async () => {
    const id = 'b'.repeat(64)
    const b64 = 'data:image/png;base64,aGVsbG8='
    store.set(id, {
      data: b64,
      ext: 'png',
      height: 32,
      width: 32,
      name: 'legacy.png',
      type: 'image',
    } satisfies InlayAsset)
    vi.mocked(uploadServerAssetBytes).mockRejectedValueOnce(new Error('migration unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unhandledRejection = vi.fn()
    process.on('unhandledRejection', unhandledRejection)

    try {
      const result = await getInlayAssetBlob(id)

      expect(result).toMatchObject({
        ext: 'png',
        height: 32,
        name: 'legacy.png',
        type: 'image',
        width: 32,
      })
      expect(result!.data).toBeInstanceOf(Blob)
      expect(await (result!.data as Blob).text()).toBe('hello')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandledRejection).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        'Unable to migrate the browser-local inlay asset',
        expect.objectContaining({ message: 'migration unavailable' }),
      )
    } finally {
      process.off('unhandledRejection', unhandledRejection)
      warn.mockRestore()
    }
  })
})

describe('listInlayAssets', () => {
  test('returns empty array when no assets exist', async () => {
    const result = await listInlayAssets()
    expect(result).toEqual([])
  })

  test('returns all stored assets as [id, asset] tuples', async () => {
    const asset1: InlayAsset = {
      data: new Blob(['a']),
      ext: 'png',
      height: 10,
      width: 10,
      name: 'a.png',
      type: 'image',
    }
    const asset2: InlayAsset = {
      data: new Blob(['bb']),
      ext: 'mp3',
      height: 0,
      width: 0,
      name: 'b.mp3',
      type: 'audio',
    }
    store.set('id-a', asset1)
    store.set('id-b', asset2)

    const result = await listInlayAssets()
    expect(result.map(([, asset]) => asset.name).sort()).toEqual(['a.png', 'b.mp3'])
    expect(result.every(([id]) => /^[a-f0-9]{64}$/.test(id))).toBe(true)
  })

  test('collapses a server asset hash and its custom id into one logical row', async () => {
    const assetId = await setInlayAsset('friendly-id', {
      data: new Blob(['same bytes'], { type: 'image/png' }),
      ext: 'png',
      name: 'friendly.png',
      type: 'image',
    })

    expect(store.has(assetId)).toBe(true)
    expect(store.has('friendly-id')).toBe(true)
    await expect(listInlayAssets()).resolves.toMatchObject([
      [assetId, { name: 'friendly.png', serverAssetId: assetId }],
    ])
  })
})

describe('removeInlayAsset', () => {
  test('does not throw when removing a non-existent id', async () => {
    await expect(removeInlayAsset('nope')).resolves.not.toThrow()
  })

  test('removes every local alias for the same server-backed asset', async () => {
    const assetId = await setInlayAsset('friendly-id', {
      data: new Blob(['same bytes'], { type: 'image/png' }),
      ext: 'png',
      name: 'friendly.png',
      type: 'image',
    })

    await removeInlayAsset('friendly-id')

    expect(store.has('friendly-id')).toBe(false)
    expect(store.has(assetId)).toBe(false)
    await expect(listInlayAssets()).resolves.toEqual([])
  })
})

describe('postInlayAsset', () => {
  test('uploads audio asset to server and returns server asset id', async () => {
    const data = new Uint8Array([0xff, 0xfb, 0x90, 0x00])
    const result = await postInlayAsset({
      name: 'clip.mp3',
      data,
    })
    expect(result).not.toBeNull()
    expect(serverAssetStore.has(result!)).toBe(true)

    // Local store holds metadata without data.
    const stored = store.get(result!) as InlayAsset
    expect(stored).toMatchObject({
      ext: 'mp3',
      name: 'clip.mp3',
      type: 'audio',
      serverAssetId: result,
    })
    expect(stored.data).toBeUndefined()
  })

  test('uploads video asset to server and returns server asset id', async () => {
    const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
    const result = await postInlayAsset({
      name: 'video.webm',
      data,
    })
    expect(result).not.toBeNull()
    expect(serverAssetStore.has(result!)).toBe(true)

    const stored = store.get(result!) as InlayAsset
    expect(stored).toMatchObject({
      ext: 'webm',
      name: 'video.webm',
      type: 'video',
      serverAssetId: result,
    })
    expect(stored.data).toBeUndefined()
  })

  test('returns null for any unsupported extension', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 10 }).filter((ext) => !allSupportedExts.includes(ext as any)),
        async (ext) => {
          store.clear()
          serverAssetStore.clear()
          const result = await postInlayAsset({
            name: `file.${ext}`,
            data: new Uint8Array([0x00]),
          })
          expect(result).toBeNull()
        },
      ),
    )
  })

  test('routes audio extensions to audio type', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...supportedAudioExts), async (ext) => {
        store.clear()
        serverAssetStore.clear()
        const result = await postInlayAsset({
          name: `sound.${ext}`,
          data: new Uint8Array([0x00]),
        })
        expect(result).not.toBeNull()
        const stored = store.get(result!) as InlayAsset
        expect(stored.type).toBe('audio')
        expect(stored.ext).toBe(ext)
      }),
    )
  })

  test('routes video extensions to video type', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...supportedVideoExts), async (ext) => {
        store.clear()
        serverAssetStore.clear()
        const result = await postInlayAsset({
          name: `clip.${ext}`,
          data: new Uint8Array([0x00]),
        })
        expect(result).not.toBeNull()
        const stored = store.get(result!) as InlayAsset
        expect(stored.type).toBe('video')
        expect(stored.ext).toBe(ext)
      }),
    )
  })

  test('revokes the temporary image object URL after upload', async () => {
    vi.stubGlobal('Image', FakeLoadedImage)
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:inlay-upload')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      const result = await postInlayAsset({
        name: 'photo.jpg',
        data: new Uint8Array([0xff, 0xd8, 0xff]),
      })

      expect(result).not.toBeNull()
      expect(createUrl).toHaveBeenCalledTimes(1)
      expect(revokeUrl).toHaveBeenCalledWith('blob:inlay-upload')
    } finally {
      createUrl.mockRestore()
      revokeUrl.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

describe('writeInlayImage', () => {
  test('already-complete inlay images decode and upload without waiting for onload', async () => {
    const decode = vi.fn(async () => {})
    const imgObj = makeImage(120, 80, { complete: true, decode })
    let assignedOnload = false
    Object.defineProperty(imgObj, 'onload', {
      configurable: true,
      set() {
        assignedOnload = true
      },
    })

    const result = await writeInlayImage(imgObj, {
      name: 'complete.png',
    })

    expect(decode).toHaveBeenCalledTimes(1)
    expect(assignedOnload).toBe(false)
    expect(serverAssetStore.has(result)).toBe(true)
    expect(store.get(result)).toMatchObject({
      height: 80,
      name: 'complete.png',
      type: 'image',
      width: 120,
    })
  })

  test('broken inlay images reject instead of hanging', async () => {
    const imgObj = makeImage(0, 0, {
      complete: false,
      decode: null,
      naturalHeight: 0,
      naturalWidth: 0,
    })

    const result = writeInlayImage(imgObj)
    imgObj.dispatchEvent(new Event('error'))

    await expect(result).rejects.toThrow('Inlay image failed to load')
    expect(fakeCtx.drawImage).not.toHaveBeenCalled()
    expect(serverAssetStore.size).toBe(0)
  })

  test('decode rejection without dimensions rejects instead of uploading', async () => {
    const decode = vi.fn(async () => {
      throw new Error('decode failed')
    })
    const imgObj = makeImage(0, 0, {
      complete: true,
      decode,
      naturalHeight: 0,
      naturalWidth: 0,
    })

    await expect(writeInlayImage(imgObj)).rejects.toThrow('decode failed')
    expect(fakeCtx.drawImage).not.toHaveBeenCalled()
    expect(serverAssetStore.size).toBe(0)
  })

  test('uploads image to server and stores metadata under both server and custom id', async () => {
    const imgObj = makeImage(200, 100)

    const result = await writeInlayImage(imgObj, {
      name: 'photo.jpg',
      ext: 'jpg',
      id: 'custom-id',
    })

    // Returns the server asset id, not the custom id.
    expect(serverAssetStore.has(result)).toBe(true)

    // Metadata stored under the server asset id.
    const storedByServer = store.get(result) as InlayAsset
    expect(storedByServer).toMatchObject({
      ext: 'png',
      height: 100,
      name: 'photo.jpg',
      type: 'image',
      width: 200,
      serverAssetId: result,
    })
    expect(storedByServer.data).toBeUndefined()

    // Metadata also stored under the caller-provided custom id.
    const storedByCustom = store.get('custom-id') as InlayAsset
    expect(storedByCustom).toMatchObject({
      name: 'photo.jpg',
      serverAssetId: result,
    })
  })

  test('returns server asset id when no custom id is provided', async () => {
    const imgObj = makeImage(50, 50)

    const result = await writeInlayImage(imgObj)
    expect(serverAssetStore.has(result)).toBe(true)

    const stored = store.get(result) as InlayAsset
    expect(stored).toMatchObject({
      type: 'image',
      serverAssetId: result,
    })
  })

  test('output pixels never exceed 1024 * 1024', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4096 }), fc.integer({ min: 1, max: 4096 }), async (w, h) => {
        store.clear()
        serverAssetStore.clear()
        const img = makeImage(w, h)
        const assetId = await writeInlayImage(img, { id: 'prop-img' })
        const stored = store.get(assetId) as InlayAsset

        expect(stored.width * stored.height).toBeLessThanOrEqual(1024 * 1024)
        expect(stored.width).toBeGreaterThan(0)
        expect(stored.height).toBeGreaterThan(0)
      }),
    )
  })

  test('preserves aspect ratio when downscaling', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1025, max: 4096 }), fc.integer({ min: 1025, max: 4096 }), async (w, h) => {
        store.clear()
        serverAssetStore.clear()
        const img = makeImage(w, h)
        const assetId = await writeInlayImage(img, { id: 'ratio-img' })
        const stored = store.get(assetId) as InlayAsset

        const originalRatio = w / h
        const storedRatio = stored.width / stored.height
        expect(Math.abs(originalRatio - storedRatio) / originalRatio).toBeLessThan(0.01)
      }),
    )
  })

  test('does not resize images within pixel budget', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1024 }), fc.integer({ min: 1, max: 1024 }), async (w, h) => {
        store.clear()
        serverAssetStore.clear()
        const img = makeImage(w, h)
        const assetId = await writeInlayImage(img, { id: 'small-img' })

        const stored = store.get(assetId) as InlayAsset
        expect(stored).toMatchObject({
          height: h,
          width: w,
        })
      }),
    )
  })

  test('rejects oversized source images before canvas work', async () => {
    const edge = Math.ceil(Math.sqrt(MAX_INLAY_SOURCE_PIXELS)) + 1
    const imgObj = makeImage(edge, edge)

    await expect(writeInlayImage(imgObj)).rejects.toThrow('Inlay image is too large to process safely')
    expect(fakeCtx.drawImage).not.toHaveBeenCalled()
    expect(serverAssetStore.size).toBe(0)
  })
})

describe('reencodeImage', () => {
  test('revokes the object URL when decode fails', async () => {
    vi.mocked(getImageType).mockReturnValue('JPEG')
    vi.stubGlobal('Image', FakeBrokenImage)
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reencode')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

    try {
      await expect(reencodeImage(new Uint8Array([1, 2, 3]))).rejects.toThrow('decode failed')
      expect(createUrl).toHaveBeenCalledTimes(1)
      expect(revokeUrl).toHaveBeenCalledWith('blob:reencode')
    } finally {
      createUrl.mockRestore()
      revokeUrl.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

describe('set -> get round-trip', () => {
  test('preserves metadata through setInlayAsset -> getInlayAsset via server', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.nat({ max: 5000 }),
        fc.nat({ max: 5000 }),
        async (id, name, width, height) => {
          store.clear()
          serverAssetStore.clear()
          // Use a proper image content type so the server read-back resolves to 'image'.
          const blob = new Blob(['data'], { type: 'image/png' })
          const asset: InlayAsset = {
            data: blob,
            ext: 'png',
            height,
            width,
            name,
            type: 'image',
          }

          await setInlayAsset(id, asset)

          const result = await getInlayAsset(id)
          expect(result).toMatchObject({
            data: expect.any(String),
            height,
            width,
            name,
            type: 'image',
          })
        },
      ),
    )
  })
})

describe('set -> remove -> get', () => {
  test('asset is always null after removal', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async (id) => {
        store.clear()
        serverAssetStore.clear()
        const asset: InlayAsset = {
          data: new Blob(['x']),
          ext: 'png',
          height: 1,
          width: 1,
          name: 'tmp.png',
          type: 'image',
        }

        await setInlayAsset(id, asset)
        expect(await getInlayAsset(id)).not.toBeNull()

        await removeInlayAsset(id)
        expect(await getInlayAsset(id)).toBeNull()
      }),
    )
  })
})

beforeEach(() => resetClientSessionForTests())

describe('inlay managed-session admission', () => {
  test('denies reader asset writes and lists canonical assets without legacy migration', async () => {
    store.set('legacy', {
      name: 'old.png',
      ext: 'png',
      type: 'image',
      data: new Blob(['legacy'], { type: 'image/png' }),
    })
    setManagedReaderForTest()
    await expect(postInlayAsset({ name: 'new.png', data: new Uint8Array([1]) })).rejects.toThrow(
      'client_write_access_required',
    )
    await expect(
      setInlayAsset('new', { name: 'new', ext: 'png', type: 'image', data: new Blob(['new']) }),
    ).rejects.toThrow('client_write_access_required')
    await expect(removeInlayAsset('legacy')).rejects.toThrow('client_write_access_required')
    await expect(listInlayAssets()).resolves.toEqual([])
    expect(uploadServerAssetBytes).not.toHaveBeenCalled()
    expect(store.has('legacy')).toBe(true)
  })

  test('does not upload an inlay whose blob read crosses demotion and repromotion', async () => {
    setManagedWriterForTest()
    const blob = new Blob(['pending'])
    let release!: (bytes: ArrayBuffer) => void
    vi.spyOn(blob, 'arrayBuffer').mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = setInlayAsset('old', { name: 'old', ext: 'png', type: 'image', data: blob })
    demoteAndRepromoteForTest()
    release(new Uint8Array([1]).buffer)
    await expect(pending).rejects.toThrow('client_write_operation_stale')
    expect(uploadServerAssetBytes).not.toHaveBeenCalled()
    expect(catalogStore.size).toBe(0)
  })
})
