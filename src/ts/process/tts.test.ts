import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { character } from '../storage/database.svelte'

const testState = vi.hoisted(() => ({
  alertError: vi.fn(),
  db: {} as any,
  currentCharacter: null as character | null,
  globalFetch: vi.fn(),
  loadAsset: vi.fn(),
  runTranslator: vi.fn(),
  requestProviderOperation: vi.fn(),
  requestTtsSynthesis: vi.fn(),
  translateVox: vi.fn(),
  runVITS: vi.fn(),
  settingsResourceState: {
    value: {} as any,
    groupStatuses: { media: 'ready', providers: 'ready' },
  },
  charactersResourceState: {
    characters: [] as character[],
    currentChar: -1,
    status: 'ready',
  },
}))

vi.mock('../alert', () => ({
  alertError: testState.alertError,
}))

vi.mock('../globalApi.svelte', () => ({
  globalFetch: testState.globalFetch,
  loadAsset: testState.loadAsset,
}))

vi.mock('../storage/database.svelte', () => ({
  getDatabase: () => testState.db,
}))

vi.mock('../characterState', () => ({
  getSelectedCharacterOwner: () => testState.currentCharacter,
  selectCharacterOwner: (characters: character[], selectedIndex: number) => {
    const candidate = characters[selectedIndex]
    if (!candidate?.chaId) return undefined
    return characters.filter((character) => character?.chaId === candidate.chaId).length === 1 ? candidate : undefined
  },
}))

vi.mock('../server/resourceState.svelte', () => ({
  charactersResourceState: testState.charactersResourceState,
  settingsResourceState: testState.settingsResourceState,
}))

vi.mock('../server/providerOperations', () => ({
  providerOperationCredential: (apiKey: string) =>
    apiKey === '__RISU_SECRET_MASKED__'
      ? { source: 'stored' }
      : apiKey
        ? { source: 'provided', apiKey }
        : { source: 'none' },
  requestProviderOperation: testState.requestProviderOperation,
}))

vi.mock('../server/tts', () => ({
  TtsSynthesisRequestError: class extends Error {
    status: number

    constructor(status: number) {
      super('tts_synthesis_failed')
      this.status = status
    }
  },
  requestTtsSynthesis: testState.requestTtsSynthesis,
  ttsGlobalCredential: (apiKey: string) =>
    apiKey === '__RISU_SECRET_MASKED__'
      ? { source: 'stored' }
      : apiKey
        ? { source: 'provided', apiKey }
        : { source: 'none' },
}))

vi.mock('../translator/translator', () => ({
  runTranslator: testState.runTranslator,
  translateVox: testState.translateVox,
}))

vi.mock('./transformers', () => ({
  runVITS: testState.runVITS,
}))

vi.mock('src/lang', () => ({
  language: {
    errors: {
      httpError: 'HTTP: ',
      ttsFailed: (error: string) => `TTS Error: ${error}`,
      gptSoVitsPathLookupFailed: 'Failed to Auto get path',
      fishSpeechModelMissing: 'FishSpeech Model is not selected',
    },
  },
}))

interface StubSource {
  buffer: AudioBuffer | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onended: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

interface StubGain {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  gain: {
    value: number
  }
}

class StubAudioContext {
  static instances: StubAudioContext[] = []

  decoded: ArrayBuffer[] = []
  destination = { kind: 'destination' }
  gains: StubGain[] = []
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  sources: StubSource[] = []
  state: AudioContextState = 'running'

  constructor() {
    StubAudioContext.instances.push(this)
  }

  async decodeAudioData(audio: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(audio)
    return { kind: 'decoded-audio' } as unknown as AudioBuffer
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: null,
      start: vi.fn(),
      stop: vi.fn(() => {
        source.onended?.()
      }),
    } satisfies StubSource
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }

  createGain(): GainNode {
    const gain = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: {
        value: 1,
      },
    } satisfies StubGain
    this.gains.push(gain)
    return gain as unknown as GainNode
  }
}

function ttsAudio(bytes = new Uint8Array([1, 2, 3]), contentType = 'audio/wav') {
  return {
    audio: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    contentType,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeCharacter(overrides: Partial<character> = {}): character {
  return {
    chaId: 'char-tts',
    name: 'TTS Test',
    ttsMode: 'elevenlab',
    ttsSpeech: 'voice-a',
    ...overrides,
  } as character
}

function makeGptSoVitsCharacter(volume = 0.5): character {
  return makeCharacter({
    ttsMode: 'gptsovits',
    gptSoVitsConfig: {
      url: 'https://gptsovits.example.test',
      use_auto_path: false,
      ref_audio_path: '/voice',
      use_long_audio: false,
      ref_audio_data: {
        fileName: 'ref.wav',
        assetId: 'asset-ref',
      },
      volume,
      text_lang: 'en',
      use_prompt: false,
      prompt: null,
      prompt_lang: 'en',
      top_p: 1,
      temperature: 1,
      speed: 1,
      top_k: 5,
      text_split_method: 'cut0',
    },
  })
}

function makeFishSpeechCharacter(): character {
  return makeCharacter({
    ttsMode: 'fishspeech',
    fishSpeechConfig: {
      chunk_length: 200,
      model: {
        _id: 'fish-voice',
        title: 'Fish Voice',
        description: 'Fish speech voice fixture',
      },
      normalize: true,
    },
  })
}

async function importTTS() {
  return import('./tts')
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  StubAudioContext.instances.length = 0
  testState.db = {
    elevenLabKey: 'eleven-key',
    huggingfaceKey: 'hf-key',
  }
  testState.settingsResourceState.value = testState.db
  testState.settingsResourceState.groupStatuses.media = 'ready'
  testState.settingsResourceState.groupStatuses.providers = 'ready'
  testState.charactersResourceState.characters = []
  testState.charactersResourceState.currentChar = -1
  testState.charactersResourceState.status = 'ready'
  testState.currentCharacter = null
  testState.loadAsset.mockResolvedValue(new Uint8Array([9, 8, 7]))
  testState.runTranslator.mockResolvedValue('translated text')
  testState.translateVox.mockResolvedValue('translated vox')
  testState.globalFetch.mockReset()
  testState.requestProviderOperation.mockReset()
  testState.requestTtsSynthesis.mockReset()
  vi.stubGlobal('AudioContext', StubAudioContext)
  vi.stubGlobal('speechSynthesis', {
    cancel: vi.fn(),
    getVoices: vi.fn(() => []),
    speak: vi.fn(),
  })
  vi.stubGlobal('SpeechSynthesisUtterance', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Web Speech voice catalog', () => {
  it('returns an empty catalog without the browser API and supports an injected synthesis instance', async () => {
    vi.stubGlobal('speechSynthesis', undefined)
    const { getWebSpeechTTSVoices } = await importTTS()

    expect(getWebSpeechTTSVoices()).toEqual([])
    expect(
      getWebSpeechTTSVoices({
        getVoices: () => [{ name: 'Injected Voice' } as SpeechSynthesisVoice],
      }),
    ).toEqual(['Injected Voice'])
  })

  it('silently skips Web Speech playback when the browser API is unavailable', async () => {
    vi.stubGlobal('speechSynthesis', undefined)
    vi.stubGlobal('SpeechSynthesisUtterance', undefined)
    const { sayTTS } = await importTTS()

    await sayTTS(makeCharacter({ ttsMode: 'webspeech' }), 'hello')

    expect(testState.alertError).not.toHaveBeenCalled()
  })
})

describe('TTS resource ownership', () => {
  it('uses the ready selected-character owner when no character is supplied', async () => {
    testState.currentCharacter = makeCharacter({ ttsSpeech: 'owned-voice' })
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio())
    const { sayTTS } = await importTTS()

    await sayTTS(undefined as never, 'owned text')

    expect(testState.requestTtsSynthesis.mock.calls[0][0]).toMatchObject({
      operation: 'elevenlabs.synthesize',
      input: { text: 'owned text', voiceId: 'owned-voice' },
    })
  })

  it('waits for the media settings owner while it is loading', async () => {
    testState.settingsResourceState.groupStatuses.media = 'loading'
    testState.settingsResourceState.value = { elevenLabKey: 'stale-owner-key' }
    testState.db.elevenLabKey = 'compatibility-key'
    testState.requestProviderOperation.mockResolvedValueOnce({ voices: [] })
    const { getElevenTTSVoices } = await importTTS()

    await expect(getElevenTTSVoices()).resolves.toEqual([])
    expect(testState.requestProviderOperation).not.toHaveBeenCalled()
  })

  it('fails closed for settings and character owner errors', async () => {
    testState.settingsResourceState.groupStatuses.media = 'error'
    testState.currentCharacter = makeCharacter()
    testState.charactersResourceState.status = 'error'
    const { getElevenTTSVoices, sayTTS } = await importTTS()

    await expect(getElevenTTSVoices()).resolves.toEqual([])
    await sayTTS(undefined as never, 'do not synthesize')

    expect(testState.requestProviderOperation).not.toHaveBeenCalled()
    expect(testState.requestTtsSynthesis).not.toHaveBeenCalled()
  })
})

describe('TTS provider catalog request caching', () => {
  it('dedupes ElevenLabs catalogs by API key and retries failed requests', async () => {
    const pending = deferred<unknown>()
    testState.requestProviderOperation
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ voices: [{ voice_id: 'voice-b', name: 'Voice B' }] })
      .mockRejectedValueOnce(new Error('temporary catalog failure'))
      .mockResolvedValueOnce({ voices: [{ voice_id: 'voice-c', name: 'Voice C' }] })
    const { getElevenTTSVoices } = await importTTS()

    const first = getElevenTTSVoices()
    const concurrent = getElevenTTSVoices()
    await Promise.resolve()
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(1)
    pending.resolve({ voices: [{ voice_id: 'voice-a', name: 'Voice A' }] })

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      [{ voice_id: 'voice-a', name: 'Voice A' }],
      [{ voice_id: 'voice-a', name: 'Voice A' }],
    ])
    await expect(getElevenTTSVoices()).resolves.toEqual([{ voice_id: 'voice-a', name: 'Voice A' }])
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(1)

    testState.db.elevenLabKey = 'eleven-key-b'
    await expect(getElevenTTSVoices()).resolves.toEqual([{ voice_id: 'voice-b', name: 'Voice B' }])
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(2)
    expect(testState.requestProviderOperation).toHaveBeenNthCalledWith(2, 'elevenlabs.voices', {
      credential: { source: 'provided', apiKey: 'eleven-key-b' },
    })

    testState.db.elevenLabKey = 'eleven-key-retry'
    await expect(getElevenTTSVoices()).rejects.toThrow('temporary catalog failure')
    await expect(getElevenTTSVoices()).resolves.toEqual([{ voice_id: 'voice-c', name: 'Voice C' }])
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(4)
  })

  it('dedupes VOICEVOX catalogs by normalized URL and retries malformed responses', async () => {
    testState.db.voicevoxUrl = 'https://voicevox-a.example.test///'
    const pending = deferred<Response>()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(jsonResponse([{ name: 'Speaker B', styles: [{ name: 'Normal', id: '2' }] }]))
      .mockResolvedValueOnce(jsonResponse({ speakers: [] }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Speaker C', styles: [{ name: 'Normal', id: 3 }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const { getVOICEVOXVoices } = await importTTS()

    const first = getVOICEVOXVoices()
    const concurrent = getVOICEVOXVoices()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    pending.resolve(jsonResponse([{ name: 'Speaker A', styles: [{ name: 'Normal', id: 1 }] }]))

    const expectedFirst = [
      { name: 'None', list: null },
      { name: 'Speaker A', list: JSON.stringify([{ name: 'Normal', id: '1' }]) },
    ]
    await expect(Promise.all([first, concurrent])).resolves.toEqual([expectedFirst, expectedFirst])
    testState.db.voicevoxUrl = 'https://voicevox-a.example.test'
    await expect(getVOICEVOXVoices()).resolves.toEqual(expectedFirst)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://voicevox-a.example.test/speakers')

    testState.db.voicevoxUrl = 'https://voicevox-b.example.test/'
    await expect(getVOICEVOXVoices()).resolves.toEqual([
      { name: 'None', list: null },
      { name: 'Speaker B', list: JSON.stringify([{ name: 'Normal', id: '2' }]) },
    ])
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://voicevox-b.example.test/speakers')

    testState.db.voicevoxUrl = 'https://voicevox-retry.example.test'
    await expect(getVOICEVOXVoices()).rejects.toThrow('VOICEVOX speaker catalog response was malformed')
    await expect(getVOICEVOXVoices()).resolves.toEqual([
      { name: 'None', list: null },
      { name: 'Speaker C', list: JSON.stringify([{ name: 'Normal', id: '3' }]) },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('dedupes Fish Speech catalogs by API key and retries failed requests', async () => {
    testState.db.fishSpeechKey = 'fish-key-a'
    const pending = deferred<unknown>()
    testState.requestProviderOperation
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ items: [{ _id: 'fish-b', title: 'Fish B', description: 'Second' }] })
      .mockRejectedValueOnce(new Error('temporary catalog failure'))
      .mockResolvedValueOnce({ items: [{ _id: 'fish-c', title: 'Fish C', description: 'Retry' }] })
    const { getFishSpeechModels } = await importTTS()

    const first = getFishSpeechModels()
    const concurrent = getFishSpeechModels()
    await Promise.resolve()
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(1)
    pending.resolve({ items: [{ _id: 'fish-a', title: 'Fish A', description: 'First' }] })

    const expectedFirst = [{ _id: 'fish-a', title: 'Fish A', description: 'First' }]
    await expect(Promise.all([first, concurrent])).resolves.toEqual([expectedFirst, expectedFirst])
    await expect(getFishSpeechModels()).resolves.toEqual(expectedFirst)
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(1)

    testState.db.fishSpeechKey = 'fish-key-b'
    await expect(getFishSpeechModels()).resolves.toEqual([{ _id: 'fish-b', title: 'Fish B', description: 'Second' }])
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(2)
    expect(testState.requestProviderOperation).toHaveBeenNthCalledWith(2, 'fish.models', {
      credential: { source: 'provided', apiKey: 'fish-key-b' },
    })

    testState.db.fishSpeechKey = 'fish-key-retry'
    await expect(getFishSpeechModels()).rejects.toThrow('temporary catalog failure')
    await expect(getFishSpeechModels()).resolves.toEqual([{ _id: 'fish-c', title: 'Fish C', description: 'Retry' }])
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(4)
  })

  it('does not retain masked-secret catalogs across stored credential updates', async () => {
    testState.db.elevenLabKey = '__RISU_SECRET_MASKED__'
    testState.requestProviderOperation
      .mockResolvedValueOnce({ voices: [{ voice_id: 'voice-a', name: 'Voice A' }] })
      .mockResolvedValueOnce({ voices: [{ voice_id: 'voice-b', name: 'Voice B' }] })
    const { getElevenTTSVoices } = await importTTS()

    await expect(getElevenTTSVoices()).resolves.toEqual([{ voice_id: 'voice-a', name: 'Voice A' }])
    await expect(getElevenTTSVoices()).resolves.toEqual([{ voice_id: 'voice-b', name: 'Voice B' }])
    expect(testState.requestProviderOperation).toHaveBeenCalledTimes(2)
    expect(testState.requestProviderOperation).toHaveBeenNthCalledWith(1, 'elevenlabs.voices', {
      credential: { source: 'stored' },
    })
  })
})

describe('sayTTS AudioContext lifecycle', () => {
  it('encodes VOICEVOX playback text and speaker as query values', async () => {
    testState.db.voicevoxUrl = 'https://voicevox.example.test/api/'
    testState.translateVox.mockResolvedValueOnce('こんにちは & mood=happy#fragment')
    const queryResponse = jsonResponse({
      accent_phrases: [],
      prePhonemeLength: 0.1,
      postPhonemeLength: 0.1,
      outputSamplingRate: 24_000,
      outputStereo: false,
      kana: 'コンニチハ',
    })
    const audioResponse = {
      status: 200,
      headers: new Headers({ 'content-type': 'audio/wav' }),
      arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(queryResponse).mockResolvedValueOnce(audioResponse)
    vi.stubGlobal('fetch', fetchMock)
    const { sayTTS } = await importTTS()

    await sayTTS(
      makeCharacter({
        ttsMode: 'VOICEVOX',
        ttsSpeech: '7&admin=true#fragment',
        voicevoxConfig: {
          SPEED_SCALE: 1,
          PITCH_SCALE: 0,
          VOLUME_SCALE: 1,
          INTONATION_SCALE: 1,
        },
      }),
      'hello',
    )

    const queryUrl = new URL(fetchMock.mock.calls[0][0])
    expect(queryUrl.pathname).toBe('/api/audio_query')
    expect(queryUrl.searchParams.get('text')).toBe('こんにちは & mood=happy#fragment')
    expect(queryUrl.searchParams.getAll('speaker')).toEqual(['7&admin=true#fragment'])
    expect(queryUrl.searchParams.has('admin')).toBe(false)

    const synthesisUrl = new URL(fetchMock.mock.calls[1][0])
    expect(synthesisUrl.pathname).toBe('/api/synthesis')
    expect(synthesisUrl.searchParams.getAll('speaker')).toEqual(['7&admin=true#fragment'])
    expect(synthesisUrl.searchParams.has('admin')).toBe(false)
  })

  it('repeated network TTS playbacks reuse one AudioContext and release ended sources', async () => {
    testState.requestTtsSynthesis
      .mockResolvedValueOnce(ttsAudio(new Uint8Array([1, 2, 3]), 'audio/mpeg'))
      .mockResolvedValueOnce(ttsAudio(new Uint8Array([4, 5, 6]), 'audio/mpeg'))
    const { sayTTS } = await importTTS()

    await sayTTS(makeCharacter(), 'hello')
    expect(StubAudioContext.instances).toHaveLength(1)
    const context = StubAudioContext.instances[0]
    const firstSource = context.sources[0]

    firstSource.onended?.()
    expect(firstSource.disconnect).toHaveBeenCalledTimes(1)

    await sayTTS(makeCharacter(), 'again')
    expect(StubAudioContext.instances).toHaveLength(1)
    expect(context.sources).toHaveLength(2)
    expect(context.sources[1].start).toHaveBeenCalledTimes(1)
  })

  it('stops active playback before starting a superseding TTS run', async () => {
    testState.requestTtsSynthesis
      .mockResolvedValueOnce(ttsAudio(new Uint8Array([1]), 'audio/mpeg'))
      .mockResolvedValueOnce(ttsAudio(new Uint8Array([2]), 'audio/mpeg'))
    const { sayTTS } = await importTTS()

    await sayTTS(makeCharacter(), 'first')
    const context = StubAudioContext.instances[0]
    const firstSource = context.sources[0]

    await sayTTS(makeCharacter(), 'second')

    expect(firstSource.stop).toHaveBeenCalledTimes(1)
    expect(firstSource.disconnect).toHaveBeenCalledTimes(1)
    expect(context.sources[1].start).toHaveBeenCalledTimes(1)
  })

  it('gptsovits gain path reuses one AudioContext and releases its gain graph', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    testState.globalFetch
      .mockResolvedValueOnce({
        ok: true,
        data: {
          buffer: new Uint8Array([3, 2, 1]).buffer,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          buffer: new Uint8Array([6, 5, 4]).buffer,
        },
      })
    const { sayTTS } = await importTTS()

    try {
      await sayTTS(makeGptSoVitsCharacter(0.25), 'hello')
      await sayTTS(makeGptSoVitsCharacter(0.25), 'again')
    } finally {
      logSpy.mockRestore()
    }

    expect(StubAudioContext.instances).toHaveLength(1)
    const context = StubAudioContext.instances[0]
    expect(context.sources).toHaveLength(2)
    expect(context.gains).toHaveLength(2)
    expect(context.gains[0].gain.value).toBe(0.25)
    expect(context.sources[0].connect).toHaveBeenCalledWith(context.gains[0])
    expect(context.gains[0].connect).toHaveBeenCalledWith(context.destination)

    context.sources[0].onended?.()
    expect(context.sources[0].disconnect).toHaveBeenCalledTimes(1)
    expect(context.gains[0].disconnect).toHaveBeenCalledTimes(1)
  })

  it('GPT-SoVITS and FishSpeech do not console-log request or response bodies', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    testState.db.fishSpeechKey = 'fish-key'
    testState.globalFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        buffer: new Uint8Array([3, 2, 1]).buffer,
      },
    })
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio(new Uint8Array([6, 5, 4]), 'audio/mpeg'))
    const { sayTTS } = await importTTS()

    try {
      await sayTTS(makeGptSoVitsCharacter(1), 'hello')
      await sayTTS(makeFishSpeechCharacter(), 'again')
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }

    expect(testState.globalFetch).toHaveBeenCalledTimes(1)
    expect(testState.requestTtsSynthesis).toHaveBeenCalledTimes(1)
    expect(StubAudioContext.instances).toHaveLength(1)
  })

  it('stopTTS stops the active source and clears stale playback refs', async () => {
    testState.requestTtsSynthesis.mockResolvedValue(ttsAudio(new Uint8Array([1, 2, 3])))
    const { sayTTS, stopTTS } = await importTTS()

    await sayTTS(makeCharacter(), 'hello')
    const source = StubAudioContext.instances[0].sources[0]

    stopTTS()
    stopTTS()

    expect(source.stop).toHaveBeenCalledTimes(1)
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    expect(speechSynthesis.cancel).toHaveBeenCalledTimes(2)
  })

  it('routes every reachable masked credential through a server-owned operation', async () => {
    testState.db = {
      elevenLabKey: '__RISU_SECRET_MASKED__',
      fishSpeechKey: '__RISU_SECRET_MASKED__',
      huggingfaceKey: '__RISU_SECRET_MASKED__',
      NAIApiKey: '__RISU_SECRET_MASKED__',
      openAIKey: '__RISU_SECRET_MASKED__',
    }
    testState.settingsResourceState.value = testState.db
    testState.requestTtsSynthesis.mockResolvedValue(ttsAudio())
    const { sayTTS } = await importTTS()

    await sayTTS(makeCharacter(), 'eleven')
    await sayTTS(makeFishSpeechCharacter(), 'fish')
    await sayTTS(
      makeCharacter({ ttsMode: 'huggingface', hfTTS: { model: 'owner/model', language: 'en' } }),
      'huggingface',
    )
    await sayTTS(
      makeCharacter({ ttsMode: 'novelai', naittsConfig: { customvoice: false, voice: 'Aini', version: 'v2' } }),
      'novelai',
    )
    await sayTTS(
      makeCharacter({
        ttsMode: 'openai',
        oaiTTSConfig: {
          enabled: true,
          baseURL: 'https://masked-client-value.example/v1',
          apiKey: '__RISU_SECRET_MASKED__',
          model: 'client-model',
          voice: 'client-voice',
          format: 'wav',
        },
      }),
      'openai',
    )

    expect(testState.requestTtsSynthesis.mock.calls.map(([request]) => request)).toEqual([
      {
        operation: 'elevenlabs.synthesize',
        credential: { source: 'stored' },
        input: { text: 'eleven', voiceId: 'voice-a' },
      },
      {
        operation: 'fish.synthesize',
        credential: { source: 'stored' },
        input: { text: 'fish', referenceId: 'fish-voice', chunkLength: 200, normalize: true },
      },
      {
        operation: 'huggingface.synthesize',
        credential: { source: 'stored' },
        input: { text: 'huggingface', model: 'owner/model' },
      },
      {
        operation: 'novelai.synthesize',
        credential: { source: 'stored' },
        input: { text: 'novelai', seed: 'Aini', version: 'v2' },
      },
      {
        operation: 'openai.synthesize',
        credential: { source: 'stored-character', characterId: 'char-tts' },
        input: { text: 'openai' },
      },
    ])
    expect(JSON.stringify(testState.requestTtsSynthesis.mock.calls)).not.toContain('__RISU_SECRET_MASKED__')
  })

  it('preserves a caller-owned OpenAI-compatible draft without exposing stored fallback keys', async () => {
    testState.db.openAIKey = '__RISU_SECRET_MASKED__'
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio(new Uint8Array([1]), 'audio/opus'))
    const { sayTTS } = await importTTS()

    await sayTTS(
      makeCharacter({
        ttsMode: 'openai',
        oaiTTSConfig: {
          enabled: true,
          baseURL: 'http://127.0.0.1:8080/v1',
          apiKey: 'draft-character-key',
          model: 'draft-model',
          voice: 'draft-voice',
          format: 'opus',
        },
      }),
      'hello',
    )

    expect(testState.requestTtsSynthesis.mock.calls[0][0]).toEqual({
      operation: 'openai.synthesize',
      credential: { source: 'provided', apiKey: 'draft-character-key' },
      input: {
        text: 'hello',
        config: {
          baseUrl: 'http://127.0.0.1:8080/v1',
          model: 'draft-model',
          voice: 'draft-voice',
          format: 'opus',
        },
      },
    })
  })

  it('wraps OpenAI raw PCM output in a browser-decodable WAV container', async () => {
    testState.db.openAIKey = 'draft-global-key'
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio(new Uint8Array([0, 0, 1, 0]), 'audio/pcm'))
    const { sayTTS } = await importTTS()

    await sayTTS(
      makeCharacter({
        ttsMode: 'openai',
        oaiTTSConfig: {
          enabled: true,
          baseURL: 'https://api.openai.com/v1',
          model: 'tts-1',
          voice: 'alloy',
          format: 'pcm',
        },
      }),
      'hello',
    )

    const decoded = new Uint8Array(StubAudioContext.instances[0].decoded[0])
    expect(new TextDecoder().decode(decoded.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(decoded.subarray(8, 12))).toBe('WAVE')
    expect(new DataView(decoded.buffer).getUint32(24, true)).toBe(24_000)
    expect(decoded.subarray(44)).toEqual(new Uint8Array([0, 0, 1, 0]))
  })

  it('aborts an in-flight server request when playback is stopped without surfacing an error', async () => {
    let requestSignal: AbortSignal | undefined
    testState.requestTtsSynthesis.mockImplementationOnce(
      async (_request: unknown, options: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          requestSignal = options.signal
          options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
    )
    const { sayTTS, stopTTS } = await importTTS()

    const pending = sayTTS(makeCharacter(), 'hello')
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    stopTTS()
    await pending

    expect(requestSignal?.aborted).toBe(true)
    expect(testState.alertError).not.toHaveBeenCalled()
    expect(StubAudioContext.instances).toHaveLength(0)
  })

  it('settles promptly when Stop aborts a never-resolving plugin preprocessor', async () => {
    const hook = vi.fn(
      () =>
        new Promise<void>(() => {
          /* intentionally never resolves */
        }),
    )
    const { registerTTSPreprocessor, unregisterTTSPreprocessor } = await import('./ttsHooks')
    registerTTSPreprocessor(hook)
    const { sayTTS, stopTTS } = await importTTS()

    try {
      const pending = sayTTS(makeCharacter(), 'hello')
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1))
      stopTTS()
      await pending
    } finally {
      unregisterTTSPreprocessor(hook)
    }

    expect(testState.requestTtsSynthesis).not.toHaveBeenCalled()
    expect(testState.alertError).not.toHaveBeenCalled()
  })

  it('settles promptly when Stop aborts a never-resolving plugin postprocessor', async () => {
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio())
    const hook = vi.fn(
      () =>
        new Promise<void>(() => {
          /* intentionally never resolves */
        }),
    )
    const { registerTTSPostprocessor, unregisterTTSPostprocessor } = await import('./ttsHooks')
    registerTTSPostprocessor(hook)
    const { sayTTS, stopTTS } = await importTTS()

    try {
      const pending = sayTTS(makeCharacter(), 'hello')
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1))
      stopTTS()
      await pending
    } finally {
      unregisterTTSPostprocessor(hook)
    }

    expect(StubAudioContext.instances).toHaveLength(0)
    expect(testState.alertError).not.toHaveBeenCalled()
  })

  it('times out a never-resolving plugin hook in production and continues synthesis', async () => {
    vi.useFakeTimers()
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio())
    const hook = vi.fn(
      () =>
        new Promise<void>(() => {
          /* intentionally never resolves */
        }),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { registerTTSPreprocessor, unregisterTTSPreprocessor } = await import('./ttsHooks')
    registerTTSPreprocessor(hook)
    const { sayTTS } = await importTTS()

    try {
      const pending = sayTTS(makeCharacter(), 'hello')
      await vi.advanceTimersByTimeAsync(10_000)
      await pending
    } finally {
      unregisterTTSPreprocessor(hook)
      errorSpy.mockRestore()
      vi.useRealTimers()
    }

    expect(testState.requestTtsSynthesis).toHaveBeenCalledTimes(1)
    expect(StubAudioContext.instances).toHaveLength(1)
  })

  it('settles when a custom transport ignores abort and fences its late response', async () => {
    testState.globalFetch.mockImplementationOnce(
      () =>
        new Promise(() => {
          /* intentionally ignores abort */
        }),
    )
    const { sayTTS, stopTTS } = await importTTS()

    const pending = sayTTS(makeGptSoVitsCharacter(1), 'hello')
    await vi.waitFor(() => expect(testState.globalFetch).toHaveBeenCalledTimes(1))
    stopTTS()
    await pending

    expect(testState.globalFetch.mock.calls[0][1].abortSignal.aborted).toBe(true)
    expect(StubAudioContext.instances).toHaveLength(0)
    expect(testState.alertError).not.toHaveBeenCalled()
  })

  it('does not play a superseded response even when its transport ignores cancellation', async () => {
    const firstResponse = deferred<ReturnType<typeof ttsAudio>>()
    testState.requestTtsSynthesis
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(ttsAudio(new Uint8Array([2]), 'audio/mpeg'))
    const { sayTTS } = await importTTS()

    const first = sayTTS(makeCharacter(), 'first')
    await vi.waitFor(() => expect(testState.requestTtsSynthesis).toHaveBeenCalledTimes(1))
    await sayTTS(makeCharacter(), 'second')
    firstResponse.resolve(ttsAudio(new Uint8Array([1]), 'audio/mpeg'))
    await first

    expect(StubAudioContext.instances).toHaveLength(1)
    expect(StubAudioContext.instances[0].sources).toHaveLength(1)
    expect(StubAudioContext.instances[0].decoded).toEqual([new Uint8Array([2]).buffer])
    expect(testState.alertError).not.toHaveBeenCalled()
  })
})

describe('sayTTS HuggingFace server operation', () => {
  it('reports a sanitized server operation failure once', async () => {
    const { TtsSynthesisRequestError } = await import('../server/tts')
    testState.requestTtsSynthesis.mockRejectedValueOnce(new TtsSynthesisRequestError(502, undefined))
    const { sayTTS } = await importTTS()

    await sayTTS(
      makeCharacter({
        ttsMode: 'huggingface',
        hfTTS: {
          model: 'hf/model',
          language: 'en',
        },
      }),
      'hello',
    )

    expect(testState.requestTtsSynthesis).toHaveBeenCalledTimes(1)
    expect(testState.alertError).toHaveBeenCalledWith('HTTP: 502')
    expect(StubAudioContext.instances).toHaveLength(0)
  })

  it('translates non-English input once before the fixed server operation', async () => {
    testState.requestTtsSynthesis.mockResolvedValueOnce(ttsAudio(new Uint8Array([7, 8, 9]), 'audio/wav'))
    const { sayTTS } = await importTTS()

    await sayTTS(
      makeCharacter({
        ttsMode: 'huggingface',
        hfTTS: {
          model: 'hf/model',
          language: 'ko',
        },
      }),
      'original text',
    )

    expect(testState.runTranslator).toHaveBeenCalledTimes(1)
    expect(testState.runTranslator).toHaveBeenCalledWith('original text', false, 'en', 'ko')
    expect(testState.requestTtsSynthesis).toHaveBeenCalledWith(
      {
        operation: 'huggingface.synthesize',
        credential: { source: 'provided', apiKey: 'hf-key' },
        input: { text: 'translated text', model: 'hf/model' },
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(StubAudioContext.instances).toHaveLength(1)
  })
})

describe('TTS managed-session admission', () => {
  it('does not synthesize or speak from a reader', async () => {
    const { setManagedReaderForTest } = await import('../__tests__/managedClientSession')
    setManagedReaderForTest()
    const { sayTTS } = await importTTS()
    await sayTTS(makeCharacter(), 'hello')
    await sayTTS(makeCharacter({ ttsMode: 'webspeech' }), 'hello')
    expect(testState.requestTtsSynthesis).not.toHaveBeenCalled()
    expect(speechSynthesis.speak).not.toHaveBeenCalled()
  })

  it('does not play an old synthesis result after demotion and repromotion', async () => {
    const { setManagedWriterForTest, demoteAndRepromoteForTest } = await import('../__tests__/managedClientSession')
    setManagedWriterForTest()
    const result = deferred<ReturnType<typeof ttsAudio>>()
    testState.requestTtsSynthesis.mockReturnValueOnce(result.promise)
    const { sayTTS } = await importTTS()
    const pending = sayTTS(makeCharacter(), 'hello')
    await vi.waitFor(() => expect(testState.requestTtsSynthesis).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    result.resolve(ttsAudio(new Uint8Array([1]), 'audio/mpeg'))
    await pending
    expect(StubAudioContext.instances).toHaveLength(0)
    expect(testState.alertError).not.toHaveBeenCalled()
  })
})
