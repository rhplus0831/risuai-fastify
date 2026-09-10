import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'

const state = vi.hoisted(() => ({
  auth: vi.fn(async () => 'test-auth'),
}))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: state.auth,
}))

import {
  embeddingOperationCredential,
  requestRemoteEmbeddingGroups,
  requestRemoteEmbeddingTexts,
} from './embeddingOperations'

beforeEach(() => {
  state.auth.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embedding operation client', () => {
  it('keeps masked credentials server-owned and preserves one-shot drafts', () => {
    expect(embeddingOperationCredential(MASKED_PROVIDER_SECRET)).toEqual({ source: 'stored' })
    expect(embeddingOperationCredential('')).toEqual({ source: 'none' })
    expect(embeddingOperationCredential(' draft-key ')).toEqual({
      source: 'provided',
      apiKey: ' draft-key ',
    })
  })

  it('posts a closed text request with auth, cancellation, and no-store semantics', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            operation: 'texts',
            model: 'custom-model',
            dimension: 2,
            vectors: [[1, 2]],
          }),
        ),
      ),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      requestRemoteEmbeddingTexts({
        model: 'custom',
        inputType: 'document',
        input: ['hello'],
        credential: { source: 'provided', apiKey: 'draft-key' },
        custom: { source: 'provided', url: 'https://draft.example.test/v1', model: 'custom-model' },
        signal: controller.signal,
      }),
    ).resolves.toEqual([[1, 2]])

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/api/v1/embedding-operations')
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store', signal: controller.signal })
    expect(new Headers(init?.headers).get('risu-auth')).toBe('test-auth')
    expect(JSON.parse(init?.body as string)).toEqual({
      operation: 'texts',
      model: 'custom',
      inputType: 'document',
      input: ['hello'],
      credential: { source: 'provided', apiKey: 'draft-key' },
      custom: { source: 'provided', url: 'https://draft.example.test/v1', model: 'custom-model' },
    })
  })

  it('validates grouped response counts and dimensions before returning vectors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              operation: 'groups',
              model: 'voyage-context-3',
              dimension: 2,
              groups: [[[1]]],
            }),
          ),
        ),
      ),
    )

    await expect(
      requestRemoteEmbeddingGroups({
        model: 'voyageContext4',
        inputType: 'query',
        groups: [['query']],
        credential: { source: 'stored' },
      }),
    ).rejects.toThrow('Embedding operation response was malformed')
  })

  it('surfaces only the server error code on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'embedding_credential_unavailable', secret: 'must-not-surface' }), {
            status: 400,
          }),
        ),
      ),
    )

    const failure = await requestRemoteEmbeddingTexts({
      model: 'openai3small',
      inputType: 'query',
      input: ['hello'],
      credential: { source: 'stored' },
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('embedding_credential_unavailable')
    expect((failure as Error).message).not.toContain('must-not-surface')
  })
})
