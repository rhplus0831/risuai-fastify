import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  alertError: vi.fn(),
  charEmotionValue: {} as Record<string, unknown>,
  charEmotionSet: vi.fn((value: Record<string, unknown>) => {
    state.charEmotionValue = value
  }),
  db: {} as any,
  fetchNative: vi.fn(),
  globalFetch: vi.fn(),
  requestImageGeneration: vi.fn(),
  readImage: vi.fn(),
  requestChatData: vi.fn(),
  settingsResourceState: {
    value: {} as any,
    status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    groupStatuses: {} as Record<string, 'idle' | 'loading' | 'ready' | 'error'>,
  },
}))

vi.mock('../alert', () => ({
  alertError: state.alertError,
}))

vi.mock('../globalApi.svelte', () => ({
  fetchNative: state.fetchNative,
  globalFetch: state.globalFetch,
  readImage: state.readImage,
}))

vi.mock('../storage/database.svelte', () => ({
  getDatabase: () => state.db,
}))

vi.mock('../server/resourceState.svelte', () => ({
  settingsResourceState: state.settingsResourceState,
}))

vi.mock('../stores.svelte', () => ({
  CharEmotion: {
    subscribe(fn: (value: Record<string, unknown>) => void) {
      fn(state.charEmotionValue)
      return () => {}
    },
    set: state.charEmotionSet,
  },
}))

vi.mock('./request/request', () => ({
  requestChatData: state.requestChatData,
}))

vi.mock('../server/imageGeneration', () => ({
  imageGenerationCredential: (apiKey: string) =>
    apiKey === '__RISU_SECRET_MASKED__'
      ? { source: 'stored' }
      : apiKey
        ? { source: 'provided', apiKey }
        : { source: 'none' },
  requestImageGeneration: state.requestImageGeneration,
}))

vi.mock('../kei/kei', () => ({
  keiServerURL: () => 'https://kei.example.test',
}))

vi.mock('lodash/random', () => ({
  default: () => 42,
}))

import { generateAIImage, loadStableDiffReferenceImageForTests, stableDiff } from './stableDiff'
import type { character } from '../storage/database.svelte'

function makeCharacter(): character {
  return {
    chaId: 'char-img',
    image: 'char.png',
    newGenData: {
      instructions: 'describe',
      negative: '',
      prompt: '{{slot}}',
    },
  } as unknown as character
}

function seedNovelAiDb(extra: Record<string, unknown> = {}) {
  state.db = {
    sdProvider: 'novelai',
    NAIApiKey: 'nai-key',
    NAIImgModel: 'nai-diffusion-3',
    NAIImgUrl: 'https://novelai.example.test/generate',
    NAII2I: false,
    NAIImgConfig: {
      cfg_rescale: 0,
      decrisp: false,
      height: 512,
      width: 512,
      sampler: 'k_euler',
      steps: 10,
      scale: 5,
      sm: false,
      sm_dyn: false,
      noise_schedule: 'native',
      legacy_uc: false,
      variety_plus: false,
      reference_mode: 'none',
      vibe_data: null,
      image: '',
      base64image: '',
      strength: 0.7,
      noise: 0,
      ...extra,
    },
  }
  state.settingsResourceState.status = 'ready'
  state.settingsResourceState.groupStatuses = { account: 'ready', media: 'ready', providers: 'ready' }
  state.settingsResourceState.value = state.db
}

beforeEach(() => {
  vi.clearAllMocks()
  state.charEmotionValue = {}
  state.db = {}
  state.settingsResourceState.value = {}
  state.settingsResourceState.status = 'idle'
  state.settingsResourceState.groupStatuses = {}
})

describe('stableDiff image-generation hygiene', () => {
  it('uses the ready image-settings owner instead of a stale aggregate provider', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'dalle',
      openAIKey: 'stale-key',
      dallEQuality: 'standard',
    }
    state.settingsResourceState.status = 'ready'
    state.settingsResourceState.groupStatuses = { account: 'ready', media: 'ready', providers: 'ready' }
    state.settingsResourceState.value = {
      sdProvider: 'kei',
      account: { token: '__RISU_SECRET_MASKED__' },
    }
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,owner')

    await expect(generateAIImage('prompt', char, '', 'inlay')).resolves.toBe('data:image/png;base64,owner')
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      {
        provider: 'kei',
        credential: { source: 'stored' },
        prompt: 'prompt',
      },
      expect.any(AbortSignal),
    )
  })

  it('fails closed instead of using the aggregate after a settings owner error', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'dalle',
      openAIKey: 'stale-key',
      dallEQuality: 'standard',
    }
    state.settingsResourceState.status = 'ready'
    state.settingsResourceState.groupStatuses = { media: 'error' }

    await expect(generateAIImage('prompt', char, '', 'inlay')).resolves.toBe(false)
    expect(state.requestImageGeneration).not.toHaveBeenCalled()
  })

  it('resolves a saved NovelAI I2I asset only when constructing the provider request', async () => {
    const char = makeCharacter()
    seedNovelAiDb({
      image: 'saved-i2i-asset',
      base64image: undefined,
    })
    state.db.NAII2I = true
    state.readImage.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,zip-image')

    await expect(generateAIImage('prompt', char, 'negative', 'inlay')).resolves.toBe('data:image/png;base64,zip-image')

    expect(state.readImage).toHaveBeenCalledTimes(1)
    expect(state.readImage).toHaveBeenCalledWith('saved-i2i-asset')
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'novelai',
        credential: { source: 'provided', apiKey: 'nai-key' },
        payload: expect.objectContaining({
          action: 'img2img',
          parameters: expect.objectContaining({
            image: 'AQID',
            strength: 0.7,
            noise: 0,
          }),
        }),
      }),
      expect.any(AbortSignal),
    )
  })

  it('keeps legacy base64-only NovelAI I2I settings working without an asset read', async () => {
    const char = makeCharacter()
    seedNovelAiDb({
      image: '',
      base64image: 'legacy-inline-image',
    })
    state.db.NAII2I = true
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,zip-image')

    await expect(generateAIImage('prompt', char, 'negative', 'inlay')).resolves.toBe('data:image/png;base64,zip-image')

    expect(state.readImage).not.toHaveBeenCalled()
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'novelai',
        payload: expect.objectContaining({
          parameters: expect.objectContaining({
            image: 'legacy-inline-image',
          }),
        }),
      }),
      expect.any(AbortSignal),
    )
  })

  it('falls back to legacy inline bytes when an imported asset reference is unreadable', async () => {
    const char = makeCharacter()
    seedNovelAiDb({
      image: 'missing-imported-asset',
      base64image: 'legacy-fallback-image',
    })
    state.db.NAII2I = true
    state.readImage.mockRejectedValueOnce(new Error('asset missing'))
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,zip-image')

    await expect(generateAIImage('prompt', char, 'negative', 'inlay')).resolves.toBe('data:image/png;base64,zip-image')

    expect(state.readImage).toHaveBeenCalledWith('missing-imported-asset')
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'novelai',
        payload: expect.objectContaining({
          parameters: expect.objectContaining({
            image: 'legacy-fallback-image',
          }),
        }),
      }),
      expect.any(AbortSignal),
    )
  })

  it('resolves a saved WaveSpeed reference asset and preserves its image request shape', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'wavespeed',
      wavespeedImage: {
        key: 'wavespeed-key',
        model: 'wavespeed/model-a',
        loras: [],
        reference_mode: 'image',
        reference_image: 'saved-wavespeed-asset',
      },
    }
    state.readImage.mockResolvedValueOnce(new Uint8Array([4, 5, 6]))
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,BwgJ')

    await expect(generateAIImage('prompt', char, 'negative', 'inlay', { database: state.db })).resolves.toBe(
      'data:image/png;base64,BwgJ',
    )

    expect(state.readImage).toHaveBeenCalledTimes(1)
    expect(state.readImage).toHaveBeenCalledWith('saved-wavespeed-asset')
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      {
        provider: 'wavespeed',
        credential: { source: 'provided', apiKey: 'wavespeed-key' },
        prompt: 'prompt',
        model: 'wavespeed/model-a',
        images: ['BAUG'],
      },
      expect.any(AbortSignal),
    )
  })

  it('routes prompt generation through otherAx and forwards the stripped prompt to the image provider', async () => {
    const char = {
      ...makeCharacter(),
      newGenData: {
        instructions: 'Turn chat into a compact image prompt.',
        negative: 'bad anatomy',
        prompt: 'cinematic portrait of {{slot}}',
      },
    } as character
    const abortController = new AbortController()

    state.db = {
      sdProvider: 'dalle',
      openAIKey: 'openai-key',
      dallEQuality: 'standard',
    }
    state.requestChatData.mockResolvedValueOnce({
      type: 'success',
      result: '<Thoughts>private chain</Thoughts>\nblue-haired mage with lantern',
    })
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,dalle-image')

    await expect(
      stableDiff(char, 'User asks for a moonlit character image.', {
        signal: abortController.signal,
        database: state.db,
      }),
    ).resolves.toBe('')

    expect(state.requestChatData).toHaveBeenCalledTimes(1)
    expect(state.requestChatData).toHaveBeenCalledWith(
      {
        formated: [
          {
            role: 'system',
            content: 'Turn chat into a compact image prompt.',
          },
          {
            role: 'user',
            content: 'Chat:\nUser asks for a moonlit character image.',
          },
        ],
        currentChar: char,
        temperature: 0.2,
        maxTokens: 300,
        bias: {},
        useStreaming: false,
        noMultiGen: true,
        database: state.db,
      },
      'otherAx',
      abortController.signal,
    )
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      {
        provider: 'dalle',
        credential: { source: 'provided', apiKey: 'openai-key' },
        prompt: 'cinematic portrait of blue-haired mage with lantern',
        quality: 'standard',
      },
      expect.any(AbortSignal),
    )
  })

  it('uses the stored credential sentinel without sending it upstream from the browser', async () => {
    const char = makeCharacter()
    seedNovelAiDb()
    state.db.NAIApiKey = '__RISU_SECRET_MASKED__'
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,server-image')

    await expect(generateAIImage('prompt', char, 'negative', 'inlay')).resolves.toBe(
      'data:image/png;base64,server-image',
    )
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ credential: { source: 'stored' }, provider: 'novelai' }),
      expect.any(AbortSignal),
    )
  })

  it('aborts and suppresses an older server image result for the same character target', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'dalle',
      openAIKey: '__RISU_SECRET_MASKED__',
      dallEQuality: 'standard',
    }
    const pending: Array<{ resolve: (value: string) => void; signal: AbortSignal }> = []
    state.requestImageGeneration.mockImplementation(
      async (_request: unknown, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          pending.push({ resolve, signal })
        }),
    )

    const first = generateAIImage('first', char, '', '', { database: state.db })
    const second = generateAIImage('second', char, '', '', { database: state.db })
    expect(pending).toHaveLength(2)
    expect(pending[0].signal.aborted).toBe(true)

    pending[1].resolve('data:image/png;base64,newer')
    await expect(second).resolves.toBe('')
    pending[0].resolve('data:image/png;base64,older')
    await expect(first).resolves.toBe(false)
    expect(state.charEmotionValue[char.chaId]).toEqual([
      ['data:image/png;base64,newer', 'data:image/png;base64,newer', expect.any(Number)],
    ])
    expect(state.alertError).not.toHaveBeenCalled()
  })

  it('applies Imagen results to the character emotion view in non-inlay mode', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'Imagen',
      google: { accessToken: '__RISU_SECRET_MASKED__' },
      ImagenModel: 'imagen-4.0-generate-001',
      ImagenImageSize: '1K',
      ImagenAspectRatio: '1:1',
      ImagenPersonGeneration: 'allow_all',
    }
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,imagen')

    await expect(generateAIImage('prompt', char, '', '', { database: state.db })).resolves.toBe('')
    expect(state.charEmotionValue[char.chaId]).toEqual([
      ['data:image/png;base64,imagen', 'data:image/png;base64,imagen', expect.any(Number)],
    ])
  })

  it('forwards caller cancellation and never applies a cancelled server response', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'dalle',
      openAIKey: '__RISU_SECRET_MASKED__',
      dallEQuality: 'standard',
    }
    let resolveRequest!: (value: string) => void
    let forwardedSignal!: AbortSignal
    state.requestImageGeneration.mockImplementation(
      async (_request: unknown, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          forwardedSignal = signal
          resolveRequest = resolve
        }),
    )
    const controller = new AbortController()

    const pending = generateAIImage('prompt', char, '', '', { signal: controller.signal, database: state.db })
    controller.abort()
    expect(forwardedSignal.aborted).toBe(true)
    resolveRequest('data:image/png;base64,cancelled')

    await expect(pending).resolves.toBe(false)
    expect(state.charEmotionValue[char.chaId]).toBeUndefined()
    expect(state.alertError).not.toHaveBeenCalled()
  })

  it('suppresses caller cancellation errors from browser image providers', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'webui',
      webUiUrl: 'https://webui.example.test',
      sdConfig: {},
    }
    let forwardedSignal!: AbortSignal
    state.globalFetch.mockImplementation(
      async (_url: string, options: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          forwardedSignal = options.abortSignal
          forwardedSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Image generation cancelled', 'AbortError')),
            { once: true },
          )
        }),
    )
    const controller = new AbortController()

    const pending = generateAIImage('prompt', char, '', 'inlay', {
      signal: controller.signal,
      database: state.db,
    })
    controller.abort()

    expect(forwardedSignal.aborted).toBe(true)
    await expect(pending).resolves.toBe(false)
    expect(state.alertError).not.toHaveBeenCalled()
  })

  it('keeps the legacy Kei account token behind the same stored-secret operation', async () => {
    const char = makeCharacter()
    state.db = {
      sdProvider: 'kei',
      account: { token: '__RISU_SECRET_MASKED__' },
    }
    state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,kei')

    await expect(generateAIImage('prompt', char, '', 'inlay', { database: state.db })).resolves.toBe(
      'data:image/png;base64,kei',
    )
    expect(state.requestImageGeneration).toHaveBeenCalledWith(
      {
        provider: 'kei',
        credential: { source: 'stored' },
        prompt: 'prompt',
      },
      expect.any(AbortSignal),
    )
  })

  it('image generation providers do not console-log payloads or poll bodies', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const char = makeCharacter()
    try {
      seedNovelAiDb()
      state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,novel-image')
      await expect(generateAIImage('prompt', char, 'neg', 'inlay')).resolves.toMatch(/^data:image\/png;base64,/)

      state.db = {
        sdProvider: 'dalle',
        openAIKey: 'openai-key',
        dallEQuality: 'standard',
      }
      state.requestImageGeneration.mockResolvedValueOnce('data:image/png;base64,dalle-image')
      await expect(generateAIImage('prompt', char, 'neg', 'inlay', { database: state.db })).resolves.toBe(
        'data:image/png;base64,dalle-image',
      )

      state.db = {
        sdProvider: 'comfyui',
        comfyUiUrl: 'https://comfy.example.test',
        comfyConfig: {
          workflow: JSON.stringify({
            '1': { inputs: { prompt: '{{risu_prompt}}', negative: '{{risu_neg}}', seed: 1 } },
          }),
          posNodeID: '1',
          posInputName: 'prompt',
          negNodeID: '1',
          negInputName: 'negative',
          timeout: 1,
        },
      }
      state.globalFetch.mockResolvedValueOnce({
        ok: true,
        data: { prompt_id: 'prompt-1' },
      })
      state.fetchNative
        .mockResolvedValueOnce({
          json: vi.fn(async () => ({
            'prompt-1': {
              outputs: {
                '1': {
                  images: [{ filename: 'out.png', subfolder: '', type: 'output' }],
                },
              },
            },
          })),
        })
        .mockResolvedValueOnce({
          arrayBuffer: vi.fn(async () => new Uint8Array([9, 8, 7]).buffer),
        })

      await expect(generateAIImage('prompt', char, 'neg', 'inlay', { database: state.db })).resolves.toMatch(
        /^data:image\/png;base64/,
      )

      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })

  it('reference image loading rejects onerror and timeout instead of hanging', async () => {
    class ErrorImage {
      onerror: ((event: Event) => void) | null = null
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.(new Event('error')))
      }
    }
    class NeverImage {
      onerror: ((event: Event) => void) | null = null
      onload: (() => void) | null = null
      set src(_value: string) {}
    }

    await expect(
      loadStableDiffReferenceImageForTests(
        new ErrorImage() as unknown as HTMLImageElement,
        'data:image/png;base64,bad',
        { timeoutMs: 1000 },
      ),
    ).rejects.toThrow('Reference image failed to load')

    vi.useFakeTimers()
    try {
      const pending = loadStableDiffReferenceImageForTests(
        new NeverImage() as unknown as HTMLImageElement,
        'data:image/png;base64,never',
        { timeoutMs: 1000 },
      )
      const assertion = expect(pending).rejects.toThrow('Reference image load timed out')
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

// Each case starts on the conservative path unless it explicitly manages a session.
beforeEach(() => resetClientSessionForTests())

describe('image runtime reader admission', () => {
  it('does not run prompt preparation or image generation in a reader', async () => {
    setManagedReaderForTest()
    seedNovelAiDb()
    await expect(stableDiff(makeCharacter(), 'hello')).resolves.toBe(false)
    await expect(generateAIImage('hello', makeCharacter(), '', 'inlay')).resolves.toBe(false)
    expect(state.requestChatData).not.toHaveBeenCalled()
    expect(state.requestImageGeneration).not.toHaveBeenCalled()
    expect(state.globalFetch).not.toHaveBeenCalled()
  })

  it('does not apply a delayed image after demotion and repromotion', async () => {
    setManagedWriterForTest()
    seedNovelAiDb()
    let release!: (image: string) => void
    state.requestImageGeneration.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = generateAIImage('hello', makeCharacter(), '', '')
    await vi.waitFor(() => expect(state.requestImageGeneration).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release('data:image/png;base64,stale')
    await expect(pending).resolves.toBe(false)
    expect(state.charEmotionSet).not.toHaveBeenCalled()
  })
})
