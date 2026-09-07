import {
  canUseClientWriteAccess,
  captureClientSessionGeneration,
  registerClientWriterLossHandler,
} from '../clientSession'
import {
  captureClientWriteOperation,
  assertClientWriteOperation,
  isClientWriteOperationCurrent,
} from '../clientWriteOperation'
import { alertError } from '../alert'
import type { character, Database } from '../storage/database.svelte'
import { getSelectedCharacterOwner } from '../characterState'
import { charactersResourceState, settingsResourceState } from '../server/resourceState.svelte'
import { runTranslator, translateVox } from '../translator/translator'
import { globalFetch, loadAsset } from '../globalApi.svelte'
import { createKeyedRequestCache } from '../model/keyedRequestCache'
import { language } from 'src/lang'
import { runVITS } from './transformers'
import { MASKED_PROVIDER_SECRET } from '../providerSecretMask'
import { providerOperationCredential, requestProviderOperation } from '../server/providerOperations'
import { requestTtsSynthesis, ttsGlobalCredential, TtsSynthesisRequestError } from '../server/tts'
import type { OpenAiTtsFormat, TtsSynthesisRequest } from '@risuai/protocol/tts-synthesis'
import {
  getTTSPreprocessors,
  getTTSPostprocessors,
  runHookPipeline,
  type BeforeTTSContext,
  type BeforeTTSResult,
  type AfterTTSContext,
  type AfterTTSResult,
} from './ttsHooks'

const TTS_CATALOG_CACHE_TTL_MS = 30_000
const TTS_PLUGIN_HOOK_TIMEOUT_MS = 10_000

type TtsSettingsGroup = 'media' | 'providers'

function ttsSettingsOwner(group: TtsSettingsGroup): Partial<Database> | undefined {
  const status = settingsResourceState.groupStatuses[group] ?? 'idle'
  if (status === 'ready') return settingsResourceState.value as Partial<Database>
  return undefined
}

function selectedTtsCharacterOwner(): character | undefined {
  const status = charactersResourceState.status
  if (status === 'ready') return getSelectedCharacterOwner()
  return undefined
}

export type ElevenTTSVoice = {
  voice_id: string
  name: string
}

export type VoicevoxSpeaker = {
  name: string
  list: string | null
}

export type FishSpeechModel = {
  _id: string
  title: string
  description: string
}

const elevenVoiceCatalogRequests = createKeyedRequestCache<ElevenTTSVoice[]>({
  ttlMs: TTS_CATALOG_CACHE_TTL_MS,
})
const voicevoxSpeakerCatalogRequests = createKeyedRequestCache<VoicevoxSpeaker[]>({
  ttlMs: TTS_CATALOG_CACHE_TTL_MS,
})
const fishSpeechModelCatalogRequests = createKeyedRequestCache<FishSpeechModel[]>({
  ttlMs: TTS_CATALOG_CACHE_TTL_MS,
})

let audioContext: AudioContext | null = null
let sourceNode: AudioBufferSourceNode | null = null
let sourceNodeCleanup: (() => void) | null = null
let activeTtsRequest: AbortController | null = null
let activeTtsRun = 0

let releaseWriterLossHandler: (() => void) | null = null

interface TtsRun {
  generation: number
  id: number
  controller: AbortController
}

type DisconnectableAudioNode = Pick<AudioNode, 'disconnect'>

async function getNetworkAudioContext(): Promise<AudioContext> {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext()
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  return audioContext
}

function bindSourceLifecycle(source: AudioBufferSourceNode, nodes: DisconnectableAudioNode[]): () => void {
  let released = false
  const cleanup = () => {
    if (released) return
    released = true
    source.onended = null
    for (const node of nodes) {
      try {
        node.disconnect()
      } catch {
        // Some browsers throw when disconnecting an already-disconnected node.
      }
    }
    if (sourceNode === source) {
      sourceNode = null
      sourceNodeCleanup = null
    }
  }

  source.onended = cleanup
  sourceNode = source
  sourceNodeCleanup = cleanup
  return cleanup
}

function startSource(source: AudioBufferSourceNode, nodes: DisconnectableAudioNode[]): void {
  const cleanup = bindSourceLifecycle(source, nodes)
  try {
    source.start()
  } catch (error) {
    cleanup()
    throw error
  }
}

function stopActiveSource(): void {
  const activeSource = sourceNode
  const cleanup = sourceNodeCleanup
  if (!activeSource) return
  try {
    activeSource.stop()
  } finally {
    cleanup?.()
    if (sourceNode === activeSource) {
      sourceNode = null
      sourceNodeCleanup = null
    }
  }
}

function beginTtsRun(): TtsRun {
  releaseWriterLossHandler?.()
  releaseWriterLossHandler = registerClientWriterLossHandler(stopTTS)
  const previousRun = activeTtsRequest
  previousRun?.abort()
  if (previousRun) {
    stopActiveSource()
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
  }
  const controller = new AbortController()
  activeTtsRequest = controller
  return {
    generation: captureClientSessionGeneration(),
    id: ++activeTtsRun,
    controller,
  }
}

function isCurrentTtsRun(run: TtsRun): boolean {
  return (
    isClientWriteOperationCurrent(run.generation) &&
    run.id === activeTtsRun &&
    activeTtsRequest === run.controller &&
    !run.controller.signal.aborted
  )
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}

function ttsAbortError(): DOMException {
  return new DOMException('TTS request aborted', 'AbortError')
}

async function awaitTtsRun<T>(promise: PromiseLike<T> | T, run: TtsRun): Promise<T> {
  if (!isCurrentTtsRun(run)) throw ttsAbortError()

  return await new Promise<T>((resolve, reject) => {
    const signal = run.controller.signal
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => settle(() => reject(ttsAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => settle(() => (isCurrentTtsRun(run) ? resolve(value) : reject(ttsAbortError()))),
      (error) => settle(() => reject(error)),
    )
    if (signal.aborted) onAbort()
  })
}

function pcm16LeToWav(pcm: ArrayBuffer, sampleRate = 24_000): ArrayBuffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error(language.errors.httpError)
  }
  const wav = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(wav)
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  new Uint8Array(wav, 44).set(new Uint8Array(pcm))
  return wav
}

async function requestCredentialedTtsAudio(
  request: TtsSynthesisRequest,
  run: TtsRun,
): Promise<{ audio: ArrayBuffer; contentType: string }> {
  if (!isCurrentTtsRun(run)) throw new DOMException('Superseded TTS request', 'AbortError')
  return await awaitTtsRun(requestTtsSynthesis(request, { signal: run.controller.signal }), run)
}

/**
 * Run every registered TTS postprocessor hook against the audio bytes, honoring
 * replacement audio / mimeType / skip semantics. Before each hook invocation a
 * fresh slice of the current base audio is handed to the hook as its disposable
 * copy — the plugin sandbox postMessage layer transfers that buffer into the
 * iframe and neuters it on the host side, so reusing a single slice across
 * multiple hooks would leave all hooks after the first with a detached buffer.
 *
 * Returns the final audio bytes (possibly replaced by a hook), the final
 * mimeType, and whether a hook requested a skip.
 */
async function runPostprocessorPipeline(
  audio: ArrayBuffer,
  mimeType: string,
  ctx: { ttsMode: string; characterId: string },
  run: TtsRun,
): Promise<{ audio: ArrayBuffer; mimeType: string; skip: boolean }> {
  const hooks = getTTSPostprocessors()
  if (hooks.length === 0) return { audio, mimeType, skip: false }

  let currentAudio = audio
  let currentMime = mimeType

  for (const hook of hooks) {
    if (!isCurrentTtsRun(run)) return { audio: currentAudio, mimeType: currentMime, skip: true }
    const disposable = currentAudio.slice(0) // fresh clone per hook
    const result = await runHookPipeline<AfterTTSContext, AfterTTSResult>(
      [hook],
      {
        audio: disposable,
        mimeType: currentMime,
        ttsMode: ctx.ttsMode,
        characterId: ctx.characterId,
      },
      { timeoutMs: TTS_PLUGIN_HOOK_TIMEOUT_MS, signal: run.controller.signal },
    )

    if (result.aborted || result.skip) return { audio: currentAudio, mimeType: currentMime, skip: true }
    if (result.ctx.audio && result.ctx.audio.byteLength > 0) currentAudio = result.ctx.audio
    if (typeof result.ctx.mimeType === 'string' && result.ctx.mimeType) currentMime = result.ctx.mimeType
  }

  return { audio: currentAudio, mimeType: currentMime, skip: false }
}

async function playAudio(
  audio: ArrayBuffer,
  mimeType: string,
  ctx: { ttsMode: string; characterId: string },
  run: TtsRun,
): Promise<void> {
  const processed = await runPostprocessorPipeline(audio, mimeType, ctx, run)
  if (processed.skip || !isCurrentTtsRun(run)) return

  const audioContext = await awaitTtsRun(getNetworkAudioContext(), run)
  const decoded = await awaitTtsRun(audioContext.decodeAudioData(processed.audio), run)
  if (!isCurrentTtsRun(run)) return
  const source = audioContext.createBufferSource()
  source.buffer = decoded
  source.connect(audioContext.destination)
  startSource(source, [source])
}

function voicevoxRequestUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path}`)
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value)
  }
  return url.toString()
}

export async function sayTTS(character: character, text: string) {
  if (!canUseClientWriteAccess()) return
  const ttsRun = beginTtsRun()
  try {
    if (!character) {
      const v = selectedTtsCharacterOwner()
      if (!v) {
        return
      }
      character = v
    }

    if (!text) {
      return
    }

    text = text.replace(/\*/g, '')

    if (character.ttsReadOnlyQuoted) {
      const matches = text.match(/["「](.*?)["」]/g)
      if (matches && matches.length > 0) {
        text = matches.map((match) => match.slice(1, -1)).join('')
      } else {
        text = ''
      }
    }

    const beforeResult = await runHookPipeline<BeforeTTSContext, BeforeTTSResult>(
      getTTSPreprocessors(),
      {
        text,
        ttsMode: character.ttsMode ?? '',
        characterId: character.chaId,
      },
      { timeoutMs: TTS_PLUGIN_HOOK_TIMEOUT_MS, signal: ttsRun.controller.signal },
    )
    if (beforeResult.skip || beforeResult.aborted) {
      return
    }
    text = beforeResult.ctx.text
    if (!text || !isCurrentTtsRun(ttsRun)) return

    switch (character.ttsMode) {
      case 'webspeech': {
        if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
          const utterThis = new SpeechSynthesisUtterance(text)
          const voices = speechSynthesis.getVoices()
          let voiceIndex = 0
          for (let i = 0; i < voices.length; i++) {
            if (voices[i].name === character.ttsSpeech) {
              voiceIndex = i
            }
          }
          utterThis.voice = voices[voiceIndex]
          speechSynthesis.speak(utterThis)
        }
        break
      }
      case 'elevenlab': {
        const settings = ttsSettingsOwner('media')
        if (!settings) return
        const response = await requestCredentialedTtsAudio(
          {
            operation: 'elevenlabs.synthesize',
            credential: ttsGlobalCredential(settings.elevenLabKey),
            input: {
              text,
              voiceId: character.ttsSpeech,
            },
          },
          ttsRun,
        )
        await playAudio(
          response.audio,
          response.contentType,
          {
            ttsMode: character.ttsMode ?? '',
            characterId: character.chaId,
          },
          ttsRun,
        )
        break
      }
      case 'VOICEVOX': {
        const settings = ttsSettingsOwner('media')
        const voicevoxUrl = typeof settings?.voicevoxUrl === 'string' ? settings.voicevoxUrl.trim() : ''
        if (!voicevoxUrl) return
        const jpText = await awaitTtsRun(translateVox(text), ttsRun)
        const query = await awaitTtsRun(
          fetch(voicevoxRequestUrl(voicevoxUrl, 'audio_query', { text: jpText, speaker: character.ttsSpeech }), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ttsRun.controller.signal,
          }),
          ttsRun,
        )
        if (query.status == 200) {
          const queryJson = await awaitTtsRun(query.json(), ttsRun)
          const bodyData = {
            accent_phrases: queryJson.accent_phrases,
            speedScale: character.voicevoxConfig.SPEED_SCALE,
            pitchScale: character.voicevoxConfig.PITCH_SCALE,
            volumeScale: character.voicevoxConfig.VOLUME_SCALE,
            intonationScale: character.voicevoxConfig.INTONATION_SCALE,
            prePhonemeLength: queryJson.prePhonemeLength,
            postPhonemeLength: queryJson.postPhonemeLength,
            outputSamplingRate: queryJson.outputSamplingRate,
            outputStereo: queryJson.outputStereo,
            kana: queryJson.kana,
          }
          const getVoice = await awaitTtsRun(
            fetch(voicevoxRequestUrl(voicevoxUrl, 'synthesis', { speaker: character.ttsSpeech }), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(bodyData),
              signal: ttsRun.controller.signal,
            }),
            ttsRun,
          )
          if (getVoice.status == 200 && getVoice.headers.get('content-type') === 'audio/wav') {
            await playAudio(
              await awaitTtsRun(getVoice.arrayBuffer(), ttsRun),
              'audio/wav',
              {
                ttsMode: character.ttsMode ?? '',
                characterId: character.chaId,
              },
              ttsRun,
            )
          }
        }
        break
      }
      case 'openai': {
        const settings = ttsSettingsOwner('providers')
        if (!settings) return
        const cfg = character.oaiTTSConfig?.enabled ? character.oaiTTSConfig : null
        const characterKey = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : ''
        const globalKey = typeof settings.openAIKey === 'string' ? settings.openAIKey.trim() : ''
        const usesStoredCredential =
          characterKey === MASKED_PROVIDER_SECRET || (!characterKey && globalKey === MASKED_PROVIDER_SECRET)
        const providedKey =
          characterKey && characterKey !== MASKED_PROVIDER_SECRET
            ? characterKey
            : globalKey !== MASKED_PROVIDER_SECRET
              ? globalKey
              : ''
        const config = {
          baseUrl: cfg?.baseURL?.trim() || 'https://api.openai.com/v1',
          model: cfg?.model?.trim() || 'tts-1',
          voice: cfg?.voice?.trim() || character.oaiVoice?.trim() || 'alloy',
          format: (cfg?.format || 'mp3') as OpenAiTtsFormat,
        }
        const response = await requestCredentialedTtsAudio(
          {
            operation: 'openai.synthesize',
            credential: usesStoredCredential
              ? { source: 'stored-character', characterId: character.chaId }
              : providedKey
                ? { source: 'provided', apiKey: providedKey }
                : { source: 'none' },
            input: {
              text,
              ...(usesStoredCredential ? {} : { config }),
            },
          },
          ttsRun,
        )
        const isRawPcm =
          config.format === 'pcm' &&
          (response.contentType === 'audio/pcm' || response.contentType === 'application/octet-stream')
        const playableAudio = isRawPcm ? pcm16LeToWav(response.audio) : response.audio
        await playAudio(
          playableAudio,
          isRawPcm ? 'audio/wav' : response.contentType,
          {
            ttsMode: character.ttsMode ?? '',
            characterId: character.chaId,
          },
          ttsRun,
        )
        break
      }
      case 'novelai': {
        const settings = ttsSettingsOwner('media')
        if (!settings) return
        const response = await requestCredentialedTtsAudio(
          {
            operation: 'novelai.synthesize',
            credential: ttsGlobalCredential(settings.NAIApiKey),
            input: {
              text,
              seed: character.naittsConfig.voice,
              version: character.naittsConfig.version === 'v1' ? 'v1' : 'v2',
            },
          },
          ttsRun,
        )
        await playAudio(
          response.audio,
          response.contentType,
          {
            ttsMode: character.ttsMode ?? '',
            characterId: character.chaId,
          },
          ttsRun,
        )
        break
      }
      case 'huggingface': {
        const settings = ttsSettingsOwner('providers')
        if (!settings) return
        const inputText =
          character.hfTTS.language === 'en'
            ? text
            : await awaitTtsRun(runTranslator(text, false, 'en', character.hfTTS.language), ttsRun)
        if (!isCurrentTtsRun(ttsRun)) return
        const response = await requestCredentialedTtsAudio(
          {
            operation: 'huggingface.synthesize',
            credential: ttsGlobalCredential(settings.huggingfaceKey),
            input: {
              text: inputText,
              model: character.hfTTS.model,
            },
          },
          ttsRun,
        )
        await playAudio(
          response.audio,
          response.contentType,
          {
            ttsMode: character.ttsMode ?? '',
            characterId: character.chaId,
          },
          ttsRun,
        )
        break
      }
      case 'vits': {
        await awaitTtsRun(runVITS(text, character.vits, { signal: ttsRun.controller.signal }), ttsRun)
        break
      }
      case 'gptsovits': {
        const audio: Uint8Array = await awaitTtsRun(loadAsset(character.gptSoVitsConfig.ref_audio_data.assetId), ttsRun)
        const base64Audio = btoa(new Uint8Array(audio).reduce((data, byte) => data + String.fromCharCode(byte), ''))

        const body = {
          text: text,
          text_lang: character.gptSoVitsConfig.text_lang,
          ref_audio_path: undefined,
          ref_audio_name: character.gptSoVitsConfig.ref_audio_data.fileName,
          ref_audio_data: base64Audio,
          prompt_text: undefined,
          prompt_lang: character.gptSoVitsConfig.prompt_lang,
          top_p: character.gptSoVitsConfig.top_p,
          temperature: character.gptSoVitsConfig.temperature,
          speed_factor: character.gptSoVitsConfig.speed,
          top_k: character.gptSoVitsConfig.top_k,
          text_split_method: character.gptSoVitsConfig.text_split_method,
          parallel_infer: true,
          // media_type: character.gptSoVitsConfig.ref_audio_data.fileName.split('.')[1],
          ref_free: character.gptSoVitsConfig.use_long_audio || !character.gptSoVitsConfig.use_prompt,
        }

        if (character.gptSoVitsConfig.use_prompt) {
          body.prompt_text = character.gptSoVitsConfig.prompt
        }

        if (character.gptSoVitsConfig.use_auto_path) {
          const path = await awaitTtsRun(
            globalFetch(`${character.gptSoVitsConfig.url}/get_path`, {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
              },
              rawResponse: false,
              plainFetchDeforce: true,
              abortSignal: ttsRun.controller.signal,
            }),
            ttsRun,
          )
          if (path.ok) {
            body.ref_audio_path =
              path.data.message + '/public/audio/' + character.gptSoVitsConfig.ref_audio_data.fileName
          } else {
            throw new Error(language.errors.gptSoVitsPathLookupFailed)
          }
        } else {
          body.ref_audio_path =
            character.gptSoVitsConfig.ref_audio_path +
            '/public/audio/' +
            character.gptSoVitsConfig.ref_audio_data.fileName
        }

        const response = await awaitTtsRun(
          globalFetch(`${character.gptSoVitsConfig.url}/tts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: body,
            rawResponse: true,
            abortSignal: ttsRun.controller.signal,
          }),
          ttsRun,
        )

        if (response.ok) {
          const mimeType = 'audio/wav'
          const hookCtx = { ttsMode: character.ttsMode ?? '', characterId: character.chaId }
          const volume = character.gptSoVitsConfig.volume
          if (volume !== undefined && volume !== 1.0) {
            // Volume != 1.0 requires a GainNode in the graph, so we can't
            // route through playAudio directly. Run the postprocessor
            // pipeline first to honor plugin hooks consistently, then
            // build the gain-enabled graph with the final bytes.
            const processed = await runPostprocessorPipeline(response.data.buffer, mimeType, hookCtx, ttsRun)
            if (!processed.skip && isCurrentTtsRun(ttsRun)) {
              const audioContext = await awaitTtsRun(getNetworkAudioContext(), ttsRun)
              const decoded = await awaitTtsRun(audioContext.decodeAudioData(processed.audio), ttsRun)
              if (!isCurrentTtsRun(ttsRun)) return
              const source = audioContext.createBufferSource()
              source.buffer = decoded
              const gainNode = audioContext.createGain()
              gainNode.gain.value = volume
              source.connect(gainNode)
              gainNode.connect(audioContext.destination)
              startSource(source, [source, gainNode])
            }
          } else {
            await playAudio(response.data.buffer, mimeType, hookCtx, ttsRun)
          }
        } else {
          const textBuffer: Uint8Array = response.data.buffer
          const text = Buffer.from(textBuffer).toString('utf-8')
          throw new Error(text)
        }
        break
      }
      case 'fishspeech': {
        const settings = ttsSettingsOwner('media')
        if (!settings) return
        if (character.fishSpeechConfig.model._id === '') {
          throw new Error(language.errors.fishSpeechModelMissing)
        }

        const response = await requestCredentialedTtsAudio(
          {
            operation: 'fish.synthesize',
            credential: ttsGlobalCredential(settings.fishSpeechKey),
            input: {
              text,
              referenceId: character.fishSpeechConfig.model._id,
              chunkLength: Number.isInteger(character.fishSpeechConfig.chunk_length)
                ? character.fishSpeechConfig.chunk_length
                : 200,
              normalize: character.fishSpeechConfig.normalize === true,
            },
          },
          ttsRun,
        )
        await playAudio(
          response.audio,
          response.contentType,
          {
            ttsMode: character.ttsMode ?? '',
            characterId: character.chaId,
          },
          ttsRun,
        )
        break
      }
    }
  } catch (error) {
    if (!isCurrentTtsRun(ttsRun) || isAbortError(error)) return
    if (error instanceof TtsSynthesisRequestError) {
      alertError(`${language.errors.httpError}${error.status}`)
      return
    }
    alertError(language.errors.ttsFailed(String(error)))
  }
}

export const oaiVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']

export function stopTTS() {
  releaseWriterLossHandler?.()
  releaseWriterLossHandler = null
  activeTtsRun += 1
  activeTtsRequest?.abort()
  activeTtsRequest = null
  stopActiveSource()
  if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
    speechSynthesis.cancel()
  }
}

export function getWebSpeechTTSVoices(synthesis?: Pick<SpeechSynthesis, 'getVoices'>) {
  const availableSynthesis = synthesis ?? (typeof speechSynthesis === 'undefined' ? null : speechSynthesis)
  if (!availableSynthesis) return []

  return availableSynthesis.getVoices().map((v) => {
    return v.name
  })
}

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireCatalogResponse(response: Response, provider: string): void {
  if (!response.ok) {
    throw new Error(`${provider} catalog request failed (${response.status})`)
  }
}

export async function getElevenTTSVoices(): Promise<ElevenTTSVoice[]> {
  if (!canUseClientWriteAccess()) return []
  const settings = ttsSettingsOwner('media')
  if (!settings) return []
  const apiKey = typeof settings.elevenLabKey === 'string' ? settings.elevenLabKey : ''
  const credential = providerOperationCredential(apiKey)

  return elevenVoiceCatalogRequests.request(
    JSON.stringify(credential),
    async () => {
      const body = await requestProviderOperation<unknown>('elevenlabs.voices', { credential })
      if (!isCatalogRecord(body) || !Array.isArray(body.voices)) {
        throw new Error('ElevenLabs voice catalog response was malformed')
      }

      return body.voices.map((voice): ElevenTTSVoice => {
        if (!isCatalogRecord(voice) || typeof voice.voice_id !== 'string' || typeof voice.name !== 'string') {
          throw new Error('ElevenLabs voice catalog response was malformed')
        }
        return { voice_id: voice.voice_id, name: voice.name }
      })
    },
    { refresh: apiKey === MASKED_PROVIDER_SECRET },
  )
}

export async function getVOICEVOXVoices(): Promise<VoicevoxSpeaker[]> {
  if (!canUseClientWriteAccess()) return []
  const settings = ttsSettingsOwner('media')
  if (!settings) return []
  const configuredUrl = typeof settings.voicevoxUrl === 'string' ? settings.voicevoxUrl.trim() : ''
  if (!configuredUrl) return []
  const baseUrl = configuredUrl.replace(/\/+$/, '')

  return voicevoxSpeakerCatalogRequests.request(baseUrl, async () => {
    const operation = captureClientWriteOperation()
    const response = await fetch(`${baseUrl}/speakers`)
    requireCatalogResponse(response, 'VOICEVOX')
    const body: unknown = await response.json()
    assertClientWriteOperation(operation)
    if (!Array.isArray(body)) {
      throw new Error('VOICEVOX speaker catalog response was malformed')
    }

    const speakers = body.map((speaker): VoicevoxSpeaker => {
      if (!isCatalogRecord(speaker) || typeof speaker.name !== 'string' || !Array.isArray(speaker.styles)) {
        throw new Error('VOICEVOX speaker catalog response was malformed')
      }
      const styles = speaker.styles.map((style) => {
        if (
          !isCatalogRecord(style) ||
          typeof style.name !== 'string' ||
          (typeof style.id !== 'string' && typeof style.id !== 'number')
        ) {
          throw new Error('VOICEVOX speaker catalog response was malformed')
        }
        return { name: style.name, id: `${style.id}` }
      })
      return { name: speaker.name, list: JSON.stringify(styles) }
    })
    speakers.unshift({ name: 'None', list: null })
    return speakers
  })
}

export async function getFishSpeechModels(): Promise<FishSpeechModel[]> {
  if (!canUseClientWriteAccess()) return []
  const settings = ttsSettingsOwner('media')
  if (!settings) return []
  const apiKey = typeof settings.fishSpeechKey === 'string' ? settings.fishSpeechKey : ''
  const credential = providerOperationCredential(apiKey)

  return fishSpeechModelCatalogRequests.request(
    JSON.stringify(credential),
    async () => {
      const body = await requestProviderOperation<unknown>('fish.models', { credential })
      if (!isCatalogRecord(body) || !Array.isArray(body.items)) {
        throw new Error('Fish Speech model catalog response was malformed')
      }

      return body.items.map((item): FishSpeechModel => {
        if (!isCatalogRecord(item)) {
          throw new Error('Fish Speech model catalog response was malformed')
        }
        const id = item._id
        const title = item.title
        const description = item.description
        if (
          typeof id !== 'string' ||
          id.length === 0 ||
          (title !== undefined && typeof title !== 'string') ||
          (description !== undefined && typeof description !== 'string')
        ) {
          throw new Error('Fish Speech model catalog response was malformed')
        }
        return {
          _id: id,
          title: typeof title === 'string' ? title : '',
          description: typeof description === 'string' ? description : '',
        }
      })
    },
    { refresh: apiKey === MASKED_PROVIDER_SECRET },
  )
}

export function getNovelAIVoices() {
  return [
    {
      gender: 'UNISEX',
      voices: ['Anananan'],
    },
    {
      gender: 'FEMALE',
      voices: ['Aini', 'Orea', 'Claea', 'Lim', 'Aurae', 'Naia'],
    },
    {
      gender: 'MALE',
      voices: ['Aulon', 'Elei', 'Ogma', 'Raid', 'Pega', 'Lam'],
    },
  ]
}

export function FixNAITTS(data: character) {
  if (data.naittsConfig === undefined) {
    // Mirror the defaults used by CharConfig.svelte's $effect.pre
    // initializer so that the NovelAI request URL — which templates
    // in `version` and branches on `customvoice` — gets valid values
    // instead of the literal string "undefined".
    data.naittsConfig = {
      customvoice: false,
      voice: 'Anananan',
      version: 'v2',
    }
  }

  return data
}
