import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { language } from '../../lang'
import { OPENAI_TRANSCRIPTION_MAX_FILE_BYTES, requestOpenAITranscription } from './openAITranscription'

const getProxyAuth = vi.hoisted(() => vi.fn(async () => 'browser-auth'))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: getProxyAuth,
}))

const fetchMock = vi.fn()

describe('requestOpenAITranscription', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    getProxyAuth.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uploads only the selected media and browser authentication to the fixed server route', async () => {
    fetchMock.mockResolvedValue(new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n'))
    const file = new File(['audio-bytes'], 'sample.mp3', { type: 'audio/mpeg' })

    await expect(requestOpenAITranscription(file)).resolves.toContain('WEBVTT')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/media/openai/transcriptions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'risu-auth': 'browser-auth' },
      cache: 'no-store',
    })
    expect(init.headers).not.toHaveProperty('authorization')
    const form = init.body as FormData
    expect(Array.from(form.keys())).toEqual(['file'])
    expect((form.get('file') as File).name).toBe('sample.mp3')
  })

  it('rejects empty or oversized uploads before authentication or fetch', async () => {
    await expect(requestOpenAITranscription(new File([], 'empty.mp3'))).rejects.toThrow(
      language.errors.openAITranscriptionFileSize,
    )
    const oversized = new Proxy(new File(['audio'], 'oversized.mp3'), {
      get(target, property, receiver) {
        if (property === 'size') return OPENAI_TRANSCRIPTION_MAX_FILE_BYTES + 1
        return Reflect.get(target, property, receiver)
      },
    })
    await expect(requestOpenAITranscription(oversized)).rejects.toThrow(language.errors.openAITranscriptionFileSize)
    expect(getProxyAuth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects failed and malformed server responses', async () => {
    const file = new File(['audio'], 'sample.mp3')
    const secretCanary = 'private-upstream-detail'
    fetchMock.mockResolvedValueOnce(new Response(secretCanary, { status: 502 }))
    const error = await requestOpenAITranscription(file).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(language.errors.openAITranscriptionFailed(502))
    expect((error as Error).message).not.toContain(secretCanary)

    fetchMock.mockResolvedValueOnce(new Response('{"text":"not vtt"}'))
    await expect(requestOpenAITranscription(file)).rejects.toThrow(language.errors.openAITranscriptionResponseMalformed)
  })
})
