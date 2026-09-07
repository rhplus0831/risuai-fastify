import { resetClientSessionForTests, canUseClientWriteAccess } from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const assetAuthMocks = vi.hoisted(() => ({
  getNodeServerProxyAuth: vi.fn(async () => 'asset-upload-auth'),
}))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: assetAuthMocks.getNodeServerProxyAuth,
}))

import {
  readServerAsset,
  readServerAssetBytes,
  serverAssetIdFromReference,
  serverAssetUrl,
  uploadServerAsset,
} from './assets'
import { clearCachedServerCommandRevision, peekCachedServerCommandRevision } from './commands'
import { getProtocolDiagnosticsSnapshot } from './protocolDiagnostics'

beforeEach(() => {
  clearCachedServerCommandRevision()
  assetAuthMocks.getNodeServerProxyAuth.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Fastify server asset helpers', () => {
  it('resolves raw server asset ids and legacy asset paths', () => {
    const rawId = 'a'.repeat(64)
    const legacyId = 'b'.repeat(64)

    expect(serverAssetIdFromReference(rawId)).toBe(rawId)
    expect(serverAssetIdFromReference(`assets/${legacyId}.wav`)).toBe(legacyId)
    expect(serverAssetIdFromReference('assets/not-a-sha.wav')).toBeNull()
    expect(serverAssetUrl(rawId)).toBe(`/api/v1/assets/${rawId}`)
    expect(serverAssetUrl(`assets/${legacyId}.png`)).toBe(`/api/v1/assets/${legacyId}`)
  })

  it('reads server asset bytes with auth headers', async () => {
    const assetId = 'c'.repeat(64)
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))

    await expect(readServerAssetBytes(assetId, { auth: 'asset-auth', fetchImpl })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    )

    expect(fetchImpl).toHaveBeenCalledWith(`/api/v1/assets/${assetId}`, {
      headers: { 'risu-auth': 'asset-auth' },
    })
  })

  it('rejects unsupported references before attaching auth', async () => {
    const fetchImpl = vi.fn()

    await expect(
      readServerAssetBytes('https://example.invalid/missing.png', {
        auth: 'asset-auth',
        fetchImpl,
      }),
    ).rejects.toThrow('Unsupported server asset reference')

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('surfaces server asset read failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }))

    await expect(
      readServerAssetBytes('d'.repeat(64), {
        auth: 'asset-auth',
        fetchImpl,
      }),
    ).rejects.toThrow('Failed to read server asset: 404')
  })

  it('uploads only the visible byte range with mutation headers and advances the cached revision', async () => {
    const assetId = 'e'.repeat(64)
    let request: RequestInit | undefined
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      request = init
      return new Response(JSON.stringify({ assetId, revision: 37 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backingBytes = new Uint8Array([9, 1, 2, 8])

    await expect(uploadServerAsset(backingBytes.subarray(1, 3), 'jpg')).resolves.toBe(assetId)

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/assets', expect.any(Object))
    expect(request?.method).toBe('POST')
    expect(request?.headers).toMatchObject({
      'content-type': 'image/jpeg',
      prefer: 'return=minimal',
      'risu-auth': 'asset-upload-auth',
      'risu-writer-session': expect.any(String),
    })
    expect((request?.headers as Record<string, string>)['risu-writer-session']).not.toBe('')
    expect(new Uint8Array(request?.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2]))
    expect(peekCachedServerCommandRevision()).toBe(37)
  })

  it('rejects unsupported upload extensions before resolving auth or fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadServerAsset(new Uint8Array([1]), 'bmp')).rejects.toThrow(
      'Unsupported server asset extension: bmp',
    )

    expect(assetAuthMocks.getNodeServerProxyAuth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects successful upload responses that omit the asset id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ revision: 38 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

    await expect(uploadServerAsset(new Uint8Array([1]), 'png')).rejects.toThrow(
      'Server asset upload response missing assetId',
    )
    expect(peekCachedServerCommandRevision()).toBeNull()
  })
})

// Asset-byte fanout diagnostics count JS-driven reads and repeated ids without
// changing read behavior.
describe('asset byte read fanout diagnostics', () => {
  it('counts requests, unique ids, and repeated-id fanout', async () => {
    const idA = 'a'.repeat(64)
    const idB = 'b'.repeat(64)
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }))

    const before = getProtocolDiagnosticsSnapshot().assetByteReads

    // Two reads of A (one repeat) and one of B: 3 requests, 2 unique ids, 1
    // repeated read, worst single-id read count is 2.
    await readServerAsset(idA, { auth: 'asset-auth', fetchImpl })
    await readServerAsset(idA, { auth: 'asset-auth', fetchImpl })
    await readServerAsset(`assets/${idB}.png`, { auth: 'asset-auth', fetchImpl })

    const after = getProtocolDiagnosticsSnapshot().assetByteReads
    expect(after.requests - before.requests).toBe(3)
    expect(after.uniqueIds - before.uniqueIds).toBe(2)
    expect(after.repeatedReads - before.repeatedReads).toBe(1)
    expect(after.maxReadsForSingleId).toBeGreaterThanOrEqual(2)
  })

  it('does not record a byte read for an unsupported reference', async () => {
    const fetchImpl = vi.fn()
    const before = getProtocolDiagnosticsSnapshot().assetByteReads

    await expect(
      readServerAsset('https://example.invalid/missing.png', { auth: 'asset-auth', fetchImpl }),
    ).rejects.toThrow('Unsupported server asset reference')

    const after = getProtocolDiagnosticsSnapshot().assetByteReads
    expect(after.requests - before.requests).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Each case starts on the conservative path unless it explicitly manages a session.
beforeEach(() => resetClientSessionForTests())

describe('asset writer admission', () => {
  it('denies uploads while preserving immutable reader downloads', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2])))
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadServerAsset(new Uint8Array([1]), 'png')).rejects.toThrow('client_write_access_required')
    expect(assetAuthMocks.getNodeServerProxyAuth).not.toHaveBeenCalled()
    await expect(readServerAssetBytes('a'.repeat(64))).resolves.toEqual(new Uint8Array([1, 2]))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not upload after authentication crosses demotion and repromotion', async () => {
    setManagedWriterForTest()
    let release!: (auth: string) => void
    assetAuthMocks.getNodeServerProxyAuth.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const pending = uploadServerAsset(new Uint8Array([1]), 'png')
    demoteAndRepromoteForTest()
    release('old-auth')
    await expect(pending).rejects.toThrow('client_write_operation_stale')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([200, 423])('does not apply old upload response %s to the new writer', async (status) => {
    setManagedWriterForTest()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = uploadServerAsset(new Uint8Array([1]), 'png')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(
      Response.json(status === 200 ? { assetId: 'a'.repeat(64), revision: 50 } : { error: 'active_writer_stale' }, {
        status,
      }),
    )
    await expect(pending).rejects.toThrow()
    expect(canUseClientWriteAccess()).toBe(true)
    expect(peekCachedServerCommandRevision()).toBeNull()
  })
})
