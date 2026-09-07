import { canUseClientWriteAccess, captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { get } from 'svelte/store'
import { language } from '../../lang'
import type { character, Database } from '../storage/database.svelte'
import { requestChatData } from './request/request'
import { alertError } from '../alert'
import { fetchNative, globalFetch, readImage } from '../globalApi.svelte'
import { CharEmotion } from '../stores.svelte'
import type { OpenAIChat } from './index.svelte'
import random from 'lodash/random'
import { imageGenerationCredential, requestImageGeneration } from '../server/imageGeneration'
import { settingsResourceState } from '../server/resourceState.svelte'
import type { ImageGenerationRequest } from '@risuai/protocol/image-generation-operation'

interface ImageGenerationOptions {
  signal?: AbortSignal
  /** Coherent settings owner snapshot captured by an owning caller. */
  database?: Database
}

const IMAGE_GENERATION_SETTINGS_GROUPS = ['account', 'media', 'providers'] as const

function imageGenerationSettingsOwner(explicit?: Database): Database | null {
  if (explicit) return explicit
  if (settingsResourceState.status === 'error') return null
  if (IMAGE_GENERATION_SETTINGS_GROUPS.some((group) => settingsResourceState.groupStatuses[group] === 'error')) {
    return null
  }
  if (IMAGE_GENERATION_SETTINGS_GROUPS.some((group) => settingsResourceState.groupStatuses[group] !== 'ready'))
    return null
  return settingsResourceState.value as unknown as Database
}

const REFERENCE_IMAGE_LOAD_TIMEOUT_MS = 10_000
const SERVER_IMAGE_PROVIDERS = new Set([
  'novelai',
  'dalle',
  'stability',
  'fal',
  'Imagen',
  'openai-compat',
  'wavespeed',
  'kei',
])

interface ActiveImageGeneration {
  generation: number
  key: string
  sequence: number
  controller: AbortController
  signal: AbortSignal
  cleanupCallerAbort: () => void
}

const activeImageGenerations = new Map<string, ActiveImageGeneration>()
let nextImageGenerationSequence = 0

function beginServerImageGeneration(
  currentChar: character,
  returnSdData: string,
  callerSignal?: AbortSignal,
): ActiveImageGeneration {
  const key = `${currentChar.chaId}:${returnSdData === 'inlay' ? 'inlay' : 'emotion'}`
  const previous = activeImageGenerations.get(key)
  previous?.controller.abort()
  previous?.cleanupCallerAbort()
  const controller = new AbortController()
  const forwardCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) {
    forwardCallerAbort()
  } else {
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true })
  }
  const operation: ActiveImageGeneration = {
    generation: captureClientSessionGeneration(),
    key,
    sequence: ++nextImageGenerationSequence,
    controller,
    signal: controller.signal,
    cleanupCallerAbort: () => callerSignal?.removeEventListener('abort', forwardCallerAbort),
  }
  activeImageGenerations.set(key, operation)
  return operation
}

function isFreshImageGeneration(operation: ActiveImageGeneration): boolean {
  return (
    isClientWriteOperationCurrent(operation.generation) &&
    activeImageGenerations.get(operation.key)?.sequence === operation.sequence
  )
}

function clearImageGeneration(operation: ActiveImageGeneration): void {
  operation.cleanupCallerAbort()
  if (activeImageGenerations.get(operation.key)?.sequence === operation.sequence)
    activeImageGenerations.delete(operation.key)
}

async function requestAndApplyServerImage(
  request: ImageGenerationRequest,
  currentChar: character,
  returnSdData: string,
  operation: ActiveImageGeneration,
): Promise<string | false> {
  try {
    if (!isFreshImageGeneration(operation)) return false
    const image = await requestImageGeneration(request, operation.signal)
    if (operation.signal.aborted || !isFreshImageGeneration(operation)) return false
    if (returnSdData === 'inlay') return image

    const charemotions = get(CharEmotion)
    charemotions[currentChar.chaId] = [[image, image, Date.now()]]
    CharEmotion.set(charemotions)
    return returnSdData
  } catch (error) {
    if (operation.signal.aborted || !isFreshImageGeneration(operation)) return false
    alertError(error)
    return false
  } finally {
    clearImageGeneration(operation)
  }
}

function isImageGenerationAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function isImageGenerationAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}

function mediaAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Image generation aborted', 'AbortError')
  }
  const error = new Error('Image generation aborted')
  error.name = 'AbortError'
  return error
}

async function resolveStoredImageBase64(
  assetReference: unknown,
  legacyBase64: unknown,
  fallbackAssetReference: unknown = '',
): Promise<string> {
  const reference = typeof assetReference === 'string' ? assetReference.trim() : ''
  const inline = typeof legacyBase64 === 'string' ? legacyBase64 : ''

  // Some imported databases only have the old inline field. Keep that shape
  // usable without attempting an asset request for a reference that is absent.
  if (!reference && inline) return inline

  const fallbackReference = typeof fallbackAssetReference === 'string' ? fallbackAssetReference.trim() : ''
  const referenceToRead = reference || fallbackReference
  if (!referenceToRead) return inline

  try {
    const image = await readImage(referenceToRead)
    if (image?.byteLength) {
      return Buffer.from(image).toString('base64')
    }
  } catch {
    // An imported asset reference may no longer be readable. Its legacy inline
    // copy remains a valid compatibility fallback when one was persisted.
  }

  return inline
}

async function waitForPollInterval(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (isImageGenerationAborted(signal)) return false
  return new Promise<boolean>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      resolve(false)
    }
    timeoutId = setTimeout(() => {
      cleanup()
      resolve(true)
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function loadStableDiffReferenceImageForTests(
  imageObj: HTMLImageElement,
  src: string,
  options: ImageGenerationOptions & { timeoutMs?: number } = {},
): Promise<void> {
  if (isImageGenerationAborted(options.signal)) {
    throw mediaAbortError()
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      settle(() => reject(new Error('Reference image load timed out')))
    }, options.timeoutMs ?? REFERENCE_IMAGE_LOAD_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeoutId)
      imageObj.onload = null
      imageObj.onerror = null
      options.signal?.removeEventListener('abort', onAbort)
    }
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      finish()
    }
    const onAbort = () => settle(() => reject(mediaAbortError()))

    imageObj.onload = () => settle(resolve)
    imageObj.onerror = () => settle(() => reject(new Error(language.errors.referenceImageLoadFailed)))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    imageObj.src = src
  })
}

export async function stableDiff(currentChar: character, prompt: string, options: ImageGenerationOptions = {}) {
  if (!canUseClientWriteAccess()) return false
  const operation = captureClientSessionGeneration()
  const db = imageGenerationSettingsOwner(options.database)

  if (!db || db.sdProvider === '') {
    alertError(language.errors.stableDiffusionNotConfigured)
    return false
  }

  const promptItem = `Chat:\n${prompt}`

  const promptbody: OpenAIChat[] = [
    {
      role: 'system',
      content: currentChar.newGenData.instructions,
    },
    {
      role: 'user',
      content: promptItem,
    },
  ]

  const rq = await requestChatData(
    {
      formated: promptbody,
      currentChar: currentChar,
      temperature: 0.2,
      maxTokens: 300,
      bias: {},
      useStreaming: false,
      noMultiGen: true,
      database: db,
    },
    'otherAx',
    options.signal,
  )

  if (!isClientWriteOperationCurrent(operation) || isImageGenerationAborted(options.signal)) {
    return false
  }

  if (rq.type === 'fail') {
    alertError(rq.result)
    return false
  }
  if (rq.type === 'streaming' || rq.type === 'multiline') {
    alertError(language.errors.unexpectedResponseType)
    return false
  }

  const r = rq.result.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, '').trim()

  const genPrompt = currentChar.newGenData.prompt.replaceAll('{{slot}}', r)
  const neg = currentChar.newGenData.negative

  return await generateAIImage(genPrompt, currentChar, neg, '', { ...options, database: db })
}

export async function generateAIImage(
  genPrompt: string,
  currentChar: character,
  neg: string,
  returnSdData: string,
  options: ImageGenerationOptions = {},
): Promise<string | false> {
  if (!canUseClientWriteAccess()) return false
  const generation = captureClientSessionGeneration()
  const isCurrent = () => isClientWriteOperationCurrent(generation)
  const db = imageGenerationSettingsOwner(options.database)
  if (!db) return false
  if (!isCurrent() || isImageGenerationAborted(options.signal)) {
    return false
  }
  const serverOperation = SERVER_IMAGE_PROVIDERS.has(db.sdProvider)
    ? beginServerImageGeneration(currentChar, returnSdData, options.signal)
    : null
  const imageGenerationSignal = serverOperation?.signal ?? options.signal

  if (db.sdProvider === 'webui') {
    const uri = new URL(db.webUiUrl)
    uri.pathname = '/sdapi/v1/txt2img'
    try {
      const da = await globalFetch(uri.toString(), {
        body: {
          width: db.sdConfig.width,
          height: db.sdConfig.height,
          seed: -1,
          steps: db.sdSteps,
          cfg_scale: db.sdCFG,
          prompt: genPrompt,
          negative_prompt: neg,
          sampler_name: db.sdConfig.sampler_name,
          enable_hr: db.sdConfig.enable_hr,
          denoising_strength: db.sdConfig.denoising_strength,
          hr_scale: db.sdConfig.hr_scale,
          hr_upscaler: db.sdConfig.hr_upscaler,
        },
        headers: {
          'Content-Type': 'application/json',
        },
        abortSignal: options.signal,
      })

      if (!isCurrent() || isImageGenerationAborted(options.signal)) {
        return false
      }

      if (returnSdData === 'inlay') {
        if (da.ok) {
          return `data:image/png;base64,${da.data.images[0]}`
        } else {
          alertError(JSON.stringify(da.data))
          return ''
        }
      } else if (da.ok) {
        let charemotions = get(CharEmotion)
        const img = `data:image/png;base64,${da.data.images[0]}`
        const emos: [string, string, number][] = [[img, img, Date.now()]]
        charemotions[currentChar.chaId] = emos
        CharEmotion.set(charemotions)
      } else {
        alertError(JSON.stringify(da.data))
        return false
      }

      return returnSdData
    } catch (error) {
      if (!isCurrent() || isImageGenerationAborted(options.signal) || isImageGenerationAbortError(error)) {
        return false
      }
      alertError(error)
      return false
    }
  }
  if (db.sdProvider === 'novelai') {
    genPrompt = genPrompt
      .replaceAll('\\(', '♧')
      .replaceAll('\\)', '♤')
      .replaceAll('(', '{')
      .replaceAll(')', '}')
      .replaceAll('♧', '(')
      .replaceAll('♤', ')')

    let reqlist: any = {}

    const commonReq = {
      body: {
        input: genPrompt,
        model: db.NAIImgModel,
        parameters: {
          params_version: 3,
          add_original_image: true,
          cfg_rescale: db.NAIImgConfig.cfg_rescale,
          controlnet_strength: 1,
          dynamic_thresholding:
            db.NAIImgModel.includes('nai-diffusion-3') ||
            db.NAIImgModel.includes('nai-diffusion-furry-3') ||
            db.NAIImgModel.includes('nai-diffusion-2')
              ? db.NAIImgConfig.decrisp
              : false,
          n_samples: 1,
          width: db.NAIImgConfig.width,
          height: db.NAIImgConfig.height,
          sampler: db.NAIImgConfig.sampler,
          steps: db.NAIImgConfig.steps,
          scale: db.NAIImgConfig.scale,
          negative_prompt: neg,
          sm:
            db.NAIImgModel.includes('nai-diffusion-3') ||
            db.NAIImgModel.includes('nai-diffusion-furry-3') ||
            db.NAIImgModel.includes('nai-diffusion-2')
              ? db.NAIImgConfig.sm
              : undefined,
          sm_dyn:
            db.NAIImgModel.includes('nai-diffusion-3') || db.NAIImgModel.includes('nai-diffusion-furry-3')
              ? db.NAIImgConfig.sm_dyn
              : undefined,
          noise_schedule: db.NAIImgConfig.noise_schedule,
          normalize_reference_strength_multiple: true,
          ucPreset: 3,
          uncond_scale: 1,
          qualityToggle: false,
          legacy_v3_extend: false,
          legacy: false,
          //add v4
          autoSmea: false,
          use_coords: false,
          legacy_uc: db.NAIImgConfig.legacy_uc,
          v4_prompt: {
            caption: {
              base_caption: genPrompt,
              char_captions: [],
            },
            use_coords: false,
            use_order: true,
          },
          v4_negative_prompt: {
            caption: {
              base_caption: neg,
              char_captions: [],
            },
            legacy_uc: db.NAIImgConfig.legacy_uc,
          },
          reference_image_multiple: [],
          reference_strength_multiple: [],
          //add reference image
          image: undefined,
          strength: undefined,
          noise: undefined,
          seed: random(0, 2 ** 32 - 1),
          extra_noise_seed: random(0, 2 ** 32 - 1),
          prefer_brownian: true,
          deliberate_euler_ancestral_bug: false,
          skip_cfg_above_sigma: null,
          director_reference_images: [],
          director_reference_descriptions: [],
          director_reference_information_extracted: [],
          director_reference_strength_values: [],
        },
      },
    }

    // Add Variety+ option
    if (db.NAIImgConfig.variety_plus) {
      if (
        db.NAIImgModel.includes('nai-diffusion-4-full') ||
        db.NAIImgModel.includes('nai-diffusion-4-curated') ||
        db.NAIImgModel.includes('nai-diffusion-3') ||
        db.NAIImgModel.includes('nai-diffusion-furry-3')
      ) {
        commonReq.body.parameters.skip_cfg_above_sigma =
          Math.sqrt(db.NAIImgConfig.width * db.NAIImgConfig.height) * 0.01889
      }
      if (db.NAIImgModel.includes('nai-diffusion-4-5-full') || db.NAIImgModel.includes('nai-diffusion-4-5-curated')) {
        commonReq.body.parameters.skip_cfg_above_sigma =
          Math.sqrt(db.NAIImgConfig.width * db.NAIImgConfig.height) * 0.05766
      }
    }

    // Add vibe reference_image_multiple if exists
    if (db.NAIImgConfig.reference_mode === 'vibe' && db.NAIImgConfig.vibe_data) {
      const vibeData = db.NAIImgConfig.vibe_data
      // Determine which model to use based on vibe_model_selection or fallback to current model
      const modelKey =
        db.NAIImgConfig.vibe_model_selection ||
        (db.NAIImgModel.includes('nai-diffusion-4-full')
          ? 'v4full'
          : db.NAIImgModel.includes('nai-diffusion-4-curated')
            ? 'v4curated'
            : db.NAIImgModel.includes('nai-diffusion-4-5-full')
              ? 'v4-5full'
              : db.NAIImgModel.includes('nai-diffusion-4-5-curated')
                ? 'v4-5curated'
                : null)

      if (modelKey && vibeData.encodings && vibeData.encodings[modelKey]) {
        // Initialize arrays if they don't exist
        if (!commonReq.body.parameters.reference_image_multiple) {
          commonReq.body.parameters.reference_image_multiple = []
        }
        if (!commonReq.body.parameters.reference_strength_multiple) {
          commonReq.body.parameters.reference_strength_multiple = []
        }

        // Use selected encoding or first available
        let encodingKey = db.NAIImgConfig.vibe_model_selection
          ? Object.keys(vibeData.encodings[modelKey]).find(
              (key) =>
                vibeData.encodings[modelKey][key].params.information_extracted === (db.NAIImgConfig.InfoExtracted || 1),
            )
          : Object.keys(vibeData.encodings[modelKey])[0]

        if (encodingKey) {
          const encoding = vibeData.encodings[modelKey][encodingKey].encoding
          // Add encoding to the array
          commonReq.body.parameters.reference_image_multiple.push(encoding)

          // Add reference_strength_multiple if it exists
          const strength =
            db.NAIImgConfig.reference_strength_multiple && db.NAIImgConfig.reference_strength_multiple.length > 0
              ? db.NAIImgConfig.reference_strength_multiple[0]
              : 0.5
          commonReq.body.parameters.reference_strength_multiple.push(strength)
        }
      }
    }

    if (
      db.NAIImgConfig.reference_mode === 'character' &&
      (db.NAIImgModel.includes('nai-diffusion-4-5-full') || db.NAIImgModel.includes('nai-diffusion-4-5-curated'))
    ) {
      let base64img = await resolveStoredImageBase64(
        db.NAIImgConfig.character_image,
        db.NAIImgConfig.character_base64image,
        currentChar.image,
      )

      try {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        const imageObj = new Image()

        await loadStableDiffReferenceImageForTests(imageObj, `data:image/png;base64,${base64img}`, {
          signal: imageGenerationSignal,
        })
        if (isImageGenerationAborted(imageGenerationSignal)) {
          return false
        }

        canvas.width = 1472
        canvas.height = 1472

        const scale = Math.min(1472 / imageObj.width, 1472 / imageObj.height)
        const scaledWidth = Math.floor(imageObj.width * scale)
        const scaledHeight = Math.floor(imageObj.height * scale)

        const x = (1472 - scaledWidth) / 2
        const y = (1472 - scaledHeight) / 2

        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, 1472, 1472)

        ctx.drawImage(imageObj, x, y, scaledWidth, scaledHeight)

        const blob = await new Promise<Blob>((resolve) => {
          canvas.toBlob(resolve, 'image/png')
        })

        if (blob) {
          const arrayBuffer = await blob.arrayBuffer()
          base64img = Buffer.from(arrayBuffer).toString('base64')
        }
      } catch (error) {
        if (imageGenerationSignal?.aborted || !isFreshImageGeneration(serverOperation!)) {
          clearImageGeneration(serverOperation!)
          return false
        }
        alertError(language.errors.referenceImageLoadFailedWithCause(String(error)))
        clearImageGeneration(serverOperation!)
        return false
      }

      if (base64img) {
        commonReq.body.parameters.director_reference_descriptions = [
          {
            caption: {
              base_caption: 'character' + (db.NAIImgConfig.style_aware ? '&style' : ''),
              char_captions: [],
            },
            legacy_uc: db.NAIImgConfig.legacy_uc,
          },
        ]
        commonReq.body.parameters.director_reference_images = [base64img]
        commonReq.body.parameters.director_reference_information_extracted = [1]
        commonReq.body.parameters.director_reference_strength_values = [1]
      }
    }

    if (db.NAII2I) {
      const base64img = await resolveStoredImageBase64(
        db.NAIImgConfig.image,
        db.NAIImgConfig.base64image,
        currentChar.image,
      )

      if (base64img) {
        reqlist = commonReq
        reqlist.body.action = 'img2img'
        reqlist.body.parameters.image = base64img
        reqlist.body.parameters.strength = db.NAIImgConfig.strength || 0.7
        reqlist.body.parameters.noise = db.NAIImgConfig.noise || 0
      } else {
        if (imageGenerationSignal?.aborted || !isFreshImageGeneration(serverOperation!)) {
          clearImageGeneration(serverOperation!)
          return false
        }
        alertError(language.errors.referenceImageLoadFailed)
        clearImageGeneration(serverOperation!)
        return false
      }
    } else {
      reqlist = commonReq
      reqlist.body.action = 'generate'
    }
    return requestAndApplyServerImage(
      {
        provider: 'novelai',
        credential: imageGenerationCredential(db.NAIApiKey),
        payload: reqlist.body,
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  if (db.sdProvider === 'dalle') {
    return requestAndApplyServerImage(
      {
        provider: 'dalle',
        credential: imageGenerationCredential(db.openAIKey),
        prompt: genPrompt,
        quality: db.dallEQuality || 'standard',
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  if (db.sdProvider === 'stability') {
    return requestAndApplyServerImage(
      {
        provider: 'stability',
        credential: imageGenerationCredential(db.stabilityKey),
        prompt: genPrompt,
        negativePrompt: neg,
        model: db.stabilityModel,
        style: db.stabllityStyle || '',
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }

  if (db.sdProvider === 'comfy' || db.sdProvider === 'comfyui') {
    const legacy = db.sdProvider === 'comfy' // Legacy Comfy mode
    const { workflow, posNodeID, posInputName, negNodeID, negInputName } = db.comfyConfig
    const baseUrl = new URL(db.comfyUiUrl)

    const createUrl = (pathname: string, params: Record<string, string> = {}) => {
      const url = db.comfyUiUrl.endsWith('/api') ? new URL(`${db.comfyUiUrl}${pathname}`) : new URL(pathname, baseUrl)
      url.search = new URLSearchParams(params).toString()
      return url.toString()
    }

    const fetchWrapper = async (url: string, options = {}) => {
      if (!isCurrent()) throw mediaAbortError()
      const response = await globalFetch(url, options)
      if (!response.ok) {
        throw new Error(JSON.stringify(response.data))
      }
      return response.data
    }

    try {
      const prompt = JSON.parse(workflow)
      if (legacy) {
        prompt[posNodeID].inputs[posInputName] = genPrompt
        prompt[negNodeID].inputs[negInputName] = neg
      } else {
        //search all nodes for the prompt and negative prompt
        const keys = Object.keys(prompt)
        for (let i = 0; i < keys.length; i++) {
          const node = prompt[keys[i]]
          const inputKeys = Object.keys(node.inputs)
          for (let j = 0; j < inputKeys.length; j++) {
            let input = node.inputs[inputKeys[j]]
            if (typeof input === 'string') {
              input = input.replaceAll('{{risu_prompt}}', genPrompt)
              input = input.replaceAll('{{risu_neg}}', neg)
            }

            if (inputKeys[j] === 'seed' && typeof input === 'number') {
              input = Math.floor(Math.random() * 1000000000)
            }

            node.inputs[inputKeys[j]] = input
          }
        }
      }

      const { prompt_id: id } = await fetchWrapper(createUrl('/prompt'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { prompt: prompt },
        abortSignal: options.signal,
      })

      let item

      const startTime = Date.now()
      const timeout = db.comfyConfig.timeout * 1000
      while (
        isCurrent() &&
        !isImageGenerationAborted(options.signal) &&
        !(item = (
          await (
            await fetchNative(createUrl('/history'), {
              headers: { 'Content-Type': 'application/json' },
              method: 'GET',
              signal: options.signal,
            })
          ).json()
        )[id])
      ) {
        if (Date.now() - startTime >= timeout) {
          alertError(language.errors.imageGenerationTimedOut)
          return false
        }
        if (!(await waitForPollInterval(1000, options.signal))) {
          return false
        }
      } // Check history until the generation is complete.
      if (!isCurrent() || isImageGenerationAborted(options.signal)) {
        return false
      }
      const genImgInfo = Object.values(item.outputs).flatMap((output: any) => output.images)[0]

      const imgResponse = await fetchNative(
        createUrl('/view', {
          filename: genImgInfo.filename,
          subfolder: genImgInfo.subfolder,
          type: genImgInfo.type,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          method: 'GET',
          signal: options.signal,
        },
      )
      if (!isCurrent() || isImageGenerationAborted(options.signal)) {
        return false
      }
      const img64 = Buffer.from(await imgResponse.arrayBuffer()).toString('base64')
      if (!isCurrent()) return false

      if (returnSdData === 'inlay') {
        return `data:image/png;base64,${img64}`
      } else {
        let charemotions = get(CharEmotion)
        const img = `data:image/png;base64,${img64}`
        const emos: [string, string, number][] = [[img, img, Date.now()]]
        charemotions[currentChar.chaId] = emos
        CharEmotion.set(charemotions)
      }

      return returnSdData
    } catch (error) {
      if (!isCurrent() || isImageGenerationAborted(options.signal) || isImageGenerationAbortError(error)) {
        return false
      }
      alertError(error)
      return false
    }
  }
  if (db.sdProvider === 'kei') {
    return requestAndApplyServerImage(
      {
        provider: 'kei',
        credential: imageGenerationCredential(db.account?.token),
        prompt: genPrompt,
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  if (db.sdProvider === 'fal') {
    return requestAndApplyServerImage(
      {
        provider: 'fal',
        credential: imageGenerationCredential(db.falToken),
        prompt: genPrompt,
        model: db.falModel,
        width: db.sdConfig.width,
        height: db.sdConfig.height,
        ...(db.falModel === 'fal-ai/flux-lora' && db.falLora?.trim()
          ? {
              lora: {
                path: db.falLora,
                scale: db.falLoraScale,
              },
            }
          : {}),
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  if (db.sdProvider === 'Imagen') {
    return requestAndApplyServerImage(
      {
        provider: 'imagen',
        credential: imageGenerationCredential(db.google.accessToken),
        prompt: genPrompt,
        model: db.ImagenModel,
        imageSize: db.ImagenImageSize,
        aspectRatio: db.ImagenAspectRatio,
        personGeneration: db.ImagenPersonGeneration,
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  if (db.sdProvider === 'openai-compat') {
    const config = db.openaiCompatImage
    if (!config.url) {
      alertError(language.errors.openAICompatibleImageUrlMissing)
      clearImageGeneration(serverOperation!)
      return false
    }

    return requestAndApplyServerImage(
      {
        provider: 'openai-compat',
        credential: imageGenerationCredential(config.key),
        prompt: genPrompt,
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  if (db.sdProvider === 'wavespeed') {
    const config = db.wavespeedImage
    if (!config.key) {
      alertError(language.errors.waveSpeedApiKeyMissing)
      clearImageGeneration(serverOperation!)
      return false
    }
    let base64img = ''
    if (config.reference_mode === 'image') {
      base64img = await resolveStoredImageBase64(config.reference_image, config.reference_base64image)
    } else if (config.reference_mode === 'character') {
      base64img = await resolveStoredImageBase64(currentChar.image, '')
    }
    const loras = Array.isArray(config.loras)
      ? config.loras
          .filter((lora) => lora?.path?.trim())
          .map((lora) => ({ path: lora.path, scale: typeof lora.scale === 'number' ? lora.scale : 1 }))
      : undefined

    return requestAndApplyServerImage(
      {
        provider: 'wavespeed',
        credential: imageGenerationCredential(config.key),
        prompt: genPrompt,
        model: config.model,
        ...(base64img ? { images: [base64img] } : {}),
        ...(loras?.length ? { loras } : {}),
      },
      currentChar,
      returnSdData,
      serverOperation!,
    )
  }
  return ''
}
