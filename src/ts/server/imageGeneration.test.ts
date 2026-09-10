import { Buffer } from 'buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../../lang'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'
import { imageGenerationCredential, requestImageGeneration } from './imageGeneration'

const state = vi.hoisted(() => ({
  auth: vi.fn(async () => 'browser-auth'),
}))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: state.auth,
}))

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('imageGenerationCredential', () => {
  it('preserves stored, provided, and intentionally empty credential intent', () => {
    expect(imageGenerationCredential(MASKED_PROVIDER_SECRET)).toEqual({ source: 'stored' })
    expect(imageGenerationCredential('draft-key')).toEqual({ source: 'provided', apiKey: 'draft-key' })
    expect(imageGenerationCredential('')).toEqual({ source: 'none' })
    expect(imageGenerationCredential(undefined)).toEqual({ source: 'none' })
  })
})

describe('requestImageGeneration', () => {
  beforeEach(() => {
    state.auth.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the authenticated closed endpoint and converts bounded image bytes to a data URL', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(PNG_BYTES, {
          headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.byteLength) },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const request = {
      provider: 'dalle' as const,
      credential: { source: 'stored' as const },
      prompt: 'prompt',
      quality: 'standard',
    }

    await expect(requestImageGeneration(request, controller.signal)).resolves.toBe(
      `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
    )
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/image-generation', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'risu-auth': 'browser-auth' },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
  })

  it('rejects non-image and oversized server responses before buffering them', async () => {
    const nonImageFetch = vi.fn(async () =>
      Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })),
    )
    vi.stubGlobal('fetch', nonImageFetch)
    const request = {
      provider: 'dalle' as const,
      credential: { source: 'stored' as const },
      prompt: 'prompt',
      quality: 'standard',
    }
    await expect(requestImageGeneration(request)).rejects.toThrow(language.errors.imageGenerationResponseMalformed)

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG_BYTES)
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(body, {
            headers: { 'content-type': 'image/png', 'content-length': String(21 * 1024 * 1024) },
          }),
        ),
      ),
    )
    await expect(requestImageGeneration(request)).rejects.toThrow(language.errors.imageGenerationResponseTooLarge)
  })

  it('does not include a sanitized server error body in the thrown browser error', async () => {
    const providerSecretCanary = 'provider-secret-detail'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(new Response(JSON.stringify({ error: providerSecretCanary }), { status: 502 })),
      ),
    )
    const error = await requestImageGeneration({
      provider: 'dalle',
      credential: { source: 'provided', apiKey: 'browser-secret' },
      prompt: 'prompt',
      quality: 'standard',
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(language.errors.imageGenerationFailed(502))
    expect((error as Error).message).not.toContain(providerSecretCanary)
  })
})
