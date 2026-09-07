import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetClientSessionForTests } from '../clientSession'
import {
  demoteAndRepromoteForTest,
  setManagedReaderForTest,
  setManagedWriterForTest,
} from '../__tests__/managedClientSession'
import { requestTtsSynthesis } from './tts'
import { requestImageGeneration } from './imageGeneration'
import { requestRemoteEmbeddingTexts, requestRemoteEmbeddingGroups } from './embeddingOperations'
import { requestProviderOperation } from './providerOperations'
import { requestOpenAITranscription } from './openAITranscription'

const mocks = vi.hoisted(() => ({ auth: vi.fn(async () => 'operation-auth') }))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: mocks.auth }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const operations: { name: string; invoke: () => Promise<unknown>; response: () => Response }[] = [
  {
    name: 'TTS synthesis',
    invoke: () =>
      requestTtsSynthesis({
        operation: 'elevenlabs.synthesize',
        credential: { source: 'stored' },
        input: { text: 'hello', voiceId: 'voice' },
      }),
    response: () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }),
  },
  {
    name: 'image generation',
    invoke: () =>
      requestImageGeneration({
        provider: 'dalle',
        credential: { source: 'stored' },
        prompt: 'hello',
        quality: 'standard',
      }),
    response: () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
  },
  {
    name: 'text embeddings',
    invoke: () =>
      requestRemoteEmbeddingTexts({
        model: 'custom',
        inputType: 'document',
        input: ['hello'],
        credential: { source: 'stored' },
      }),
    response: () => Response.json({ operation: 'texts', dimension: 1, vectors: [[1]] }),
  },
  {
    name: 'group embeddings',
    invoke: () =>
      requestRemoteEmbeddingGroups({
        model: 'voyageContext3',
        inputType: 'document',
        groups: [['hello']],
        credential: { source: 'stored' },
      }),
    response: () => Response.json({ operation: 'groups', dimension: 1, groups: [[[1]]] }),
  },
  {
    name: 'provider catalogs',
    invoke: () => requestProviderOperation('elevenlabs.voices', { credential: { source: 'stored' } }),
    response: () => Response.json({ operation: 'elevenlabs.voices', data: { voices: [] } }),
  },
  {
    name: 'transcription',
    invoke: () => requestOpenAITranscription(new File(['audio'], 'audio.wav')),
    response: () => new Response('WEBVTT\n\n'),
  },
]

beforeEach(() => {
  resetClientSessionForTests()
  mocks.auth.mockReset().mockResolvedValue('operation-auth')
})
afterEach(() => {
  resetClientSessionForTests()
  vi.unstubAllGlobals()
})

describe.each(operations)('$name writer admission', ({ invoke, response }) => {
  it('rejects a managed reader before auth or network work', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(invoke()).rejects.toThrow('client_write_access_required')
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not dispatch when auth crosses demotion and repromotion', async () => {
    setManagedWriterForTest()
    const auth = deferred<string>()
    mocks.auth.mockReturnValueOnce(auth.promise)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const pending = invoke()
    demoteAndRepromoteForTest()
    auth.resolve('old-auth')
    await expect(pending).rejects.toThrow('client_write_operation_stale')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not return an old result after demotion and repromotion', async () => {
    setManagedWriterForTest()
    const result = deferred<Response>()
    const fetchMock = vi.fn(() => result.promise)
    vi.stubGlobal('fetch', fetchMock)
    const pending = invoke()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    result.resolve(response())
    await expect(pending).rejects.toThrow('client_write_operation_stale')
  })
})
