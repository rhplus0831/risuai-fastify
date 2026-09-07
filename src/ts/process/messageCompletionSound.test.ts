import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resourceDatabase = vi.hoisted(() => ({
  playMessage: false,
  playMessageOnTranslateEnd: false,
}))

const settingsResourceState = vi.hoisted(() => ({
  value: resourceDatabase,
  groupStatuses: { display: 'ready' },
}))

vi.mock('../server/resourceState.svelte', () => ({
  settingsResourceState,
}))

vi.mock('../storage/database.svelte', () => ({
  getDatabase: () => resourceDatabase,
}))

vi.mock('../../etc/send.mp3', () => ({ default: 'send.mp3' }))

interface Deferred<T> {
  promise: Promise<T>
  reject: (reason?: unknown) => void
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

interface StubSource {
  buffer: AudioBuffer | null
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onended: (() => void) | null
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

const decodedBuffer = { kind: 'completion-ding' } as unknown as AudioBuffer
const webAudioControl: {
  decodeDeferred: Deferred<AudioBuffer> | null
  decodeError: unknown
  resumeError: unknown
  sourceStartError: unknown
  sourceStopError: unknown
  suspendError: unknown
} = {
  decodeDeferred: null,
  decodeError: null,
  resumeError: null,
  sourceStartError: null,
  sourceStopError: null,
  suspendError: null,
}

class StubAudioContext {
  static instances: StubAudioContext[] = []

  close = vi.fn(async () => {
    this.state = 'closed'
  })
  decoded: ArrayBuffer[] = []
  destination = { kind: 'destination' }
  resume = vi.fn(async () => {
    if (webAudioControl.resumeError) throw webAudioControl.resumeError
    this.state = 'running'
  })
  sources: StubSource[] = []
  state: AudioContextState = 'suspended'
  suspend = vi.fn(async () => {
    if (webAudioControl.suspendError) throw webAudioControl.suspendError
    this.state = 'suspended'
  })

  constructor() {
    StubAudioContext.instances.push(this)
  }

  async decodeAudioData(audio: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(audio)
    if (webAudioControl.decodeError) throw webAudioControl.decodeError
    if (webAudioControl.decodeDeferred) return await webAudioControl.decodeDeferred.promise
    return decodedBuffer
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      onended: null,
      start: vi.fn(() => {
        if (webAudioControl.sourceStartError) throw webAudioControl.sourceStartError
      }),
      stop: vi.fn(() => {
        if (webAudioControl.sourceStopError) throw webAudioControl.sourceStopError
      }),
    } satisfies StubSource
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }
}

interface DocumentHarness {
  addEventListener: ReturnType<typeof vi.fn>
  dispatch: (type: 'keydown' | 'pointerdown') => void
  listenerCount: (type: 'keydown' | 'pointerdown') => number
  removeEventListener: ReturnType<typeof vi.fn>
}

function createDocumentHarness(): DocumentHarness {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  const addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    const registered = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
    registered.add(listener)
    listeners.set(type, registered)
  })
  const removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.get(type)?.delete(listener)
  })

  return {
    addEventListener,
    dispatch: (type) => {
      const event = new Event(type)
      for (const listener of [...(listeners.get(type) ?? [])]) {
        if (typeof listener === 'function') {
          listener(event)
        } else {
          listener.handleEvent(event)
        }
      }
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    removeEventListener,
  }
}

interface FallbackAudioInstance {
  addEventListener: ReturnType<typeof vi.fn>
  currentTime: number
  dispatch: (type: 'ended' | 'error') => void
  load: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  preload: string
  removeAttribute: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
  src: string
}

interface FallbackAudioHarness {
  AudioMock: ReturnType<typeof vi.fn>
  instances: FallbackAudioInstance[]
}

function stubFallbackAudio(playImplementation: () => Promise<void> = () => Promise.resolve()): FallbackAudioHarness {
  const instances: FallbackAudioInstance[] = []
  const AudioMock = vi.fn(function (_src?: string) {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
    const instance: FallbackAudioInstance = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        const registered = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
        registered.add(listener)
        listeners.set(type, registered)
      }),
      currentTime: 7,
      dispatch: (type) => {
        const event = new Event(type)
        for (const listener of [...(listeners.get(type) ?? [])]) {
          if (typeof listener === 'function') {
            listener(event)
          } else {
            listener.handleEvent(event)
          }
        }
      },
      load: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(playImplementation),
      preload: '',
      removeAttribute: vi.fn((name: string) => {
        if (name === 'src') instance.src = ''
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener)
      }),
      src: _src ?? '',
    }
    instances.push(instance)
    return instance
  })
  vi.stubGlobal('Audio', AudioMock)
  return { AudioMock, instances }
}

function audioResponse(): Response {
  return {
    arrayBuffer: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
    ok: true,
    status: 200,
  } as unknown as Response
}

async function loadCompletionSoundModule() {
  vi.resetModules()
  return await import('./messageCompletionSound')
}

let documentHarness: DocumentHarness
let fallbackAudioHarness: FallbackAudioHarness
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resourceDatabase.playMessage = false
  resourceDatabase.playMessageOnTranslateEnd = false
  settingsResourceState.value = resourceDatabase
  settingsResourceState.groupStatuses.display = 'ready'
  webAudioControl.decodeDeferred = null
  webAudioControl.decodeError = null
  webAudioControl.resumeError = null
  webAudioControl.sourceStartError = null
  webAudioControl.sourceStopError = null
  webAudioControl.suspendError = null
  StubAudioContext.instances = []

  documentHarness = createDocumentHarness()
  vi.stubGlobal('document', documentHarness)
  vi.stubGlobal('AudioContext', StubAudioContext)
  fallbackAudioHarness = stubFallbackAudio()
  fetchMock = vi.fn(async () => audioResponse())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('completion sound Web Audio lifecycle', () => {
  it('installs unlock listeners once without creating an audio context, player, or source', async () => {
    const { installCompletionAudioUnlock, unlockCompletionAudioContext } = await loadCompletionSoundModule()

    installCompletionAudioUnlock()
    installCompletionAudioUnlock()

    expect(documentHarness.addEventListener).toHaveBeenCalledTimes(2)
    expect(documentHarness.addEventListener).toHaveBeenNthCalledWith(1, 'pointerdown', unlockCompletionAudioContext, {
      capture: true,
      passive: true,
    })
    expect(documentHarness.addEventListener).toHaveBeenNthCalledWith(2, 'keydown', unlockCompletionAudioContext, {
      capture: true,
      passive: true,
    })
    expect(StubAudioContext.instances).toHaveLength(0)
    expect(fallbackAudioHarness.AudioMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('leaves unlocking available when both completion sound settings are disabled', async () => {
    const { installCompletionAudioUnlock } = await loadCompletionSoundModule()
    installCompletionAudioUnlock()

    documentHarness.dispatch('pointerdown')
    documentHarness.dispatch('keydown')

    expect(StubAudioContext.instances).toHaveLength(0)
    expect(fallbackAudioHarness.AudioMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(documentHarness.listenerCount('pointerdown')).toBe(1)
    expect(documentHarness.listenerCount('keydown')).toBe(1)
    expect(documentHarness.removeEventListener).not.toHaveBeenCalled()
  })

  it('unlocks and decodes once without starting a source, then suspends and removes listeners', async () => {
    const { installCompletionAudioUnlock } = await loadCompletionSoundModule()
    resourceDatabase.playMessageOnTranslateEnd = true
    installCompletionAudioUnlock()

    documentHarness.dispatch('pointerdown')

    await vi.waitFor(() => expect(documentHarness.removeEventListener).toHaveBeenCalledTimes(2))
    const context = StubAudioContext.instances[0]
    expect(StubAudioContext.instances).toHaveLength(1)
    expect(context.resume).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(context.decoded).toHaveLength(1)
    expect(context.sources).toHaveLength(0)
    expect(context.suspend).toHaveBeenCalledOnce()
    expect(context.state).toBe('suspended')
    expect(documentHarness.listenerCount('pointerdown')).toBe(0)
    expect(documentHarness.listenerCount('keydown')).toBe(0)

    documentHarness.dispatch('pointerdown')
    expect(context.resume).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('plays through a disposable source and suspends again when it ends', async () => {
    const module = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    module.installCompletionAudioUnlock()
    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(documentHarness.removeEventListener).toHaveBeenCalledTimes(2))

    const context = StubAudioContext.instances[0]
    module.playCompletionDing()
    await vi.waitFor(() => expect(context.sources).toHaveLength(1))

    const source = context.sources[0]
    expect(context.resume).toHaveBeenCalledTimes(2)
    expect(source.buffer).toBe(decodedBuffer)
    expect(source.connect).toHaveBeenCalledWith(context.destination)
    expect(source.start).toHaveBeenCalledOnce()
    expect(context.suspend).toHaveBeenCalledOnce()

    source.onended?.()
    await vi.waitFor(() => expect(context.suspend).toHaveBeenCalledTimes(2))
    expect(source.disconnect).toHaveBeenCalledOnce()
    expect(source.onended).toBeNull()
    expect(context.state).toBe('suspended')
  })

  it('stops and replaces a prior ding without letting its stale ended callback suspend the replacement', async () => {
    const { playCompletionDing } = await loadCompletionSoundModule()

    playCompletionDing()
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.sources).toHaveLength(1))
    const context = StubAudioContext.instances[0]
    const firstSource = context.sources[0]
    const staleEnded = firstSource.onended

    webAudioControl.sourceStopError = new DOMException('already ended', 'InvalidStateError')
    playCompletionDing()
    await vi.waitFor(() => expect(context.sources).toHaveLength(2))
    const secondSource = context.sources[1]

    expect(firstSource.stop).toHaveBeenCalledOnce()
    expect(firstSource.disconnect).toHaveBeenCalledOnce()
    expect(secondSource.start).toHaveBeenCalledOnce()
    staleEnded?.()
    await Promise.resolve()
    expect(context.suspend).not.toHaveBeenCalled()

    secondSource.onended?.()
    await vi.waitFor(() => expect(context.suspend).toHaveBeenCalledOnce())
  })

  it('deduplicates decoding across concurrent playback requests and starts only the newest ding', async () => {
    const decodeDeferred = deferred<AudioBuffer>()
    webAudioControl.decodeDeferred = decodeDeferred
    const { playCompletionDing } = await loadCompletionSoundModule()

    playCompletionDing()
    playCompletionDing()
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.decoded).toHaveLength(1))
    decodeDeferred.resolve(decodedBuffer)

    const context = StubAudioContext.instances[0]
    await vi.waitFor(() => expect(context.sources).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(context.decoded).toHaveLength(1)
    expect(context.sources[0].start).toHaveBeenCalledOnce()
  })

  it('contains synchronous source-start failures, disconnects the node, and suspends the context', async () => {
    webAudioControl.sourceStartError = new DOMException('start failed', 'InvalidStateError')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { playCompletionDing } = await loadCompletionSoundModule()

    playCompletionDing()

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    const context = StubAudioContext.instances[0]
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].disconnect).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(context.suspend).toHaveBeenCalledOnce())
    expect(documentHarness.listenerCount('pointerdown')).toBe(1)
  })

  it('contains resume failures, bounds NotAllowedError warnings, and retries from later gestures', async () => {
    const notAllowedError = Object.assign(new Error('gesture required'), { name: 'NotAllowedError' })
    webAudioControl.resumeError = notAllowedError
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { installCompletionAudioUnlock } = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    installCompletionAudioUnlock()

    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(documentHarness.listenerCount('pointerdown')).toBe(1)
    expect(documentHarness.listenerCount('keydown')).toBe(1)

    webAudioControl.resumeError = null
    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(documentHarness.removeEventListener).toHaveBeenCalledTimes(2))
    expect(StubAudioContext.instances[0].suspend).toHaveBeenCalledOnce()

    webAudioControl.resumeError = notAllowedError
    const { playCompletionDing } = await import('./messageCompletionSound')
    playCompletionDing()
    await vi.waitFor(() => expect(documentHarness.listenerCount('pointerdown')).toBe(1))
    expect(warn).toHaveBeenCalledOnce()
  })

  it('clears a failed decode promise, suspends the context, and decodes again on retry', async () => {
    webAudioControl.decodeError = new TypeError('decode failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { installCompletionAudioUnlock } = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    installCompletionAudioUnlock()

    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    const context = StubAudioContext.instances[0]
    expect(context.suspend).toHaveBeenCalledOnce()
    expect(documentHarness.listenerCount('pointerdown')).toBe(1)

    webAudioControl.decodeError = null
    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(documentHarness.removeEventListener).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(context.decoded).toHaveLength(2)
  })

  it('closes a context that cannot suspend and re-arms unlocking for a fresh context', async () => {
    webAudioControl.suspendError = new Error('suspend failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { installCompletionAudioUnlock } = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    installCompletionAudioUnlock()

    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.close).toHaveBeenCalledOnce())
    expect(warn).toHaveBeenCalledOnce()
    expect(documentHarness.listenerCount('pointerdown')).toBe(1)

    webAudioControl.suspendError = null
    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(documentHarness.listenerCount('pointerdown')).toBe(0))
    expect(StubAudioContext.instances).toHaveLength(2)
    expect(StubAudioContext.instances[1].suspend).toHaveBeenCalledOnce()
  })

  it('re-arms gesture unlocking when an actual ding can no longer resume the context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const module = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    module.installCompletionAudioUnlock()
    documentHarness.dispatch('pointerdown')
    await vi.waitFor(() => expect(documentHarness.listenerCount('pointerdown')).toBe(0))

    webAudioControl.resumeError = Object.assign(new Error('permission lost'), { name: 'NotAllowedError' })
    module.playCompletionDing()

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(documentHarness.listenerCount('pointerdown')).toBe(1)
    expect(documentHarness.listenerCount('keydown')).toBe(1)
    expect(StubAudioContext.instances[0].sources).toHaveLength(0)
  })

  it('keeps the generation acceptance boolean independent from asynchronous playback success', async () => {
    const { playMessageCompletionSoundIfEnabled } = await loadCompletionSoundModule()

    expect(playMessageCompletionSoundIfEnabled()).toBe(false)
    expect(StubAudioContext.instances).toHaveLength(0)
    expect(fallbackAudioHarness.AudioMock).not.toHaveBeenCalled()

    resourceDatabase.playMessage = true
    expect(playMessageCompletionSoundIfEnabled()).toBe(true)
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.sources).toHaveLength(1))
  })

  it('waits for ready display settings and fails closed on owner error', async () => {
    const { playMessageCompletionSoundIfEnabled } = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    settingsResourceState.value = { playMessage: false, playMessageOnTranslateEnd: false }
    settingsResourceState.groupStatuses.display = 'loading'

    expect(playMessageCompletionSoundIfEnabled()).toBe(false)
    expect(StubAudioContext.instances).toHaveLength(0)

    settingsResourceState.groupStatuses.display = 'error'
    expect(playMessageCompletionSoundIfEnabled()).toBe(false)
    expect(StubAudioContext.instances).toHaveLength(0)
  })
})

describe('completion sound HTMLAudio fallback', () => {
  it('constructs fallback audio only for a real ding and unloads it after completion', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const module = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true
    module.installCompletionAudioUnlock()

    documentHarness.dispatch('pointerdown')
    expect(fallbackAudioHarness.AudioMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()

    expect(module.playMessageCompletionSoundIfEnabled()).toBe(true)
    expect(fallbackAudioHarness.AudioMock).toHaveBeenCalledOnce()
    const element = fallbackAudioHarness.instances[0]
    expect(element).toMatchObject({ currentTime: 0, preload: 'auto', src: 'send.mp3' })
    expect(element.play).toHaveBeenCalledOnce()

    element.dispatch('ended')
    expect(element.pause).toHaveBeenCalledOnce()
    expect(element.removeEventListener).toHaveBeenCalledTimes(2)
    expect(element.removeAttribute).toHaveBeenCalledWith('src')
    expect(element.load).toHaveBeenCalledOnce()

    module.playCompletionDing()
    expect(fallbackAudioHarness.AudioMock).toHaveBeenCalledTimes(2)
  })

  it('unloads rejected fallback players and warns only once for repeated NotAllowedError', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const notAllowedError = Object.assign(new Error('gesture required'), { name: 'NotAllowedError' })
    fallbackAudioHarness = stubFallbackAudio(() => Promise.reject(notAllowedError))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { playCompletionDing } = await loadCompletionSoundModule()

    playCompletionDing()
    await vi.waitFor(() => expect(fallbackAudioHarness.instances[0].load).toHaveBeenCalledOnce())
    playCompletionDing()
    await vi.waitFor(() => expect(fallbackAudioHarness.instances[1].load).toHaveBeenCalledOnce())

    expect(warn).toHaveBeenCalledOnce()
    expect(fallbackAudioHarness.instances[0].removeAttribute).toHaveBeenCalledWith('src')
    expect(fallbackAudioHarness.instances[1].removeAttribute).toHaveBeenCalledWith('src')
  })

  it('returns false when neither Web Audio nor HTML audio is available', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('Audio', undefined)
    const { playMessageCompletionSoundIfEnabled } = await loadCompletionSoundModule()
    resourceDatabase.playMessage = true

    expect(playMessageCompletionSoundIfEnabled()).toBe(false)
  })
})

describe('completion audio managed-session admission', () => {
  it('does not play Web Audio or HTML fallback in a reader while preserving gesture unlock', async () => {
    const module = await loadCompletionSoundModule()
    const { setManagedReaderForTest } = await import('../__tests__/managedClientSession')
    setManagedReaderForTest()
    resourceDatabase.playMessage = true
    expect(module.playMessageCompletionSoundIfEnabled()).toBe(false)
    module.playCompletionDing()
    expect(StubAudioContext.instances).toHaveLength(0)
    expect(fallbackAudioHarness.AudioMock).not.toHaveBeenCalled()
    module.unlockCompletionAudioContext()
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.decoded).toHaveLength(1))
    expect(StubAudioContext.instances[0].sources).toHaveLength(0)
  })

  it('does not start playback after decode crosses demotion and repromotion', async () => {
    const module = await loadCompletionSoundModule()
    const { setManagedWriterForTest, demoteAndRepromoteForTest } = await import('../__tests__/managedClientSession')
    setManagedWriterForTest()
    webAudioControl.decodeDeferred = deferred<AudioBuffer>()
    module.playCompletionDing()
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.decoded).toHaveLength(1))
    demoteAndRepromoteForTest()
    webAudioControl.decodeDeferred.resolve(decodedBuffer)
    await vi.waitFor(() => expect(StubAudioContext.instances[0]?.suspend).toHaveBeenCalledOnce())
    expect(StubAudioContext.instances[0].sources).toHaveLength(0)
    expect(fallbackAudioHarness.AudioMock).not.toHaveBeenCalled()
  })
})
