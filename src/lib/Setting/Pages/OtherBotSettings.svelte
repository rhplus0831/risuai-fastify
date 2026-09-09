<script lang="ts">
  import Check from 'src/lib/UI/GUI/CheckInput.svelte'
  import { language } from 'src/lang'
  import Help from 'src/lib/Others/Help.svelte'
  import { selectSingleFile } from 'src/ts/filePicker'
  import { selectedCharID } from 'src/ts/stores.svelte'
  import {
    charactersResourceState,
    collectionsResourceState,
    getCharacterResourceOwner,
    settingsResourceState,
  } from 'src/ts/server/resourceState.svelte'
  import type { Database, character } from 'src/ts/storage/database.svelte'
  import { saveAsset, downloadFile } from 'src/ts/globalApi.svelte'
  import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
  import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
  import SecretInput from 'src/lib/UI/GUI/SecretInput.svelte'
  import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
  import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
  import SliderInput from 'src/lib/UI/GUI/SliderInput.svelte'
  import { getCharImage } from 'src/ts/characters'
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
  import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
  import { untrack } from 'svelte'
  import { tokenizePreset } from 'src/ts/process/prompt'
  import { getCharToken } from 'src/ts/tokenizer'
  import { resolveEffectivePromptTemplate } from '@risuai/shared-core/effective-prompt-template'
  import { PlusIcon, PencilIcon, TrashIcon, DownloadIcon, HardDriveUploadIcon } from '@lucide/svelte'
  import { hypaV3PresetIndexFromStableId } from '@risuai/shared-core/hypa-v3-preset-selection-identity'
  import { alertError, alertInput, alertConfirm, alertNormal } from 'src/ts/alert'
  import { createHypaV3Preset, type HypaV3Preset } from 'src/ts/process/memory/hypav3'
  import { onDestroy } from 'svelte'
  // Retained WS3 seams: per-key drafts keep the existing rebase/rollback and
  // reload contract, while the exact-patch helper owns atomic Hypa imports.
  // Both are narrow settings-owner command/draft helpers; neither is used for
  // aggregate reads in this page.
  import {
    applyServerBackedSettingsPatch,
    createServerBackedSettingDraft,
    persistServerBackedSettingsPatch,
  } from 'src/ts/server/settingsOwner.svelte'
  import { ensurePromptTemplateHydrated } from 'src/ts/server/promptTemplateHydration'
  import { providerOperationCredential, requestProviderOperation } from 'src/ts/server/providerOperations'
  import { createLatestOperationGuard, type LatestOperationToken } from 'src/ts/server/staleStateGuards'
  import {
    applyFreshSettingsMediaAssetUpload,
    beginSettingsMediaAssetUpload,
    captureSettingsMediaAssetUploadTarget,
    clearSettingsMediaAssetUpload,
    isFreshSettingsMediaAssetUpload,
    type SettingsMediaAssetUploadFieldKeys,
    type SettingsMediaAssetUploadFreshness,
    type SettingsMediaAssetUploadOperation,
    type SettingsMediaAssetUploadTarget,
  } from 'src/ts/server/settingsMediaAssetUpload'
  import {
    beginNaiVibeImport,
    captureNaiVibeImportTarget,
    clearNaiVibeImport,
    isFreshNaiVibeImport,
    parseNaiVibeImport,
    resolveFreshNaiVibeImportPatch,
    type NaiVibeImportFreshness,
    type NaiVibeImportOperation,
  } from 'src/ts/server/naiVibeImport'
  import { reconcileLegacyGuiSubmenu } from 'src/ts/setting/legacyGuiLayout'
  import { confirmSettingsItemRemoval } from 'src/ts/setting/confirmSettingsItemRemoval'
  import { resolveModelProfile } from 'src/ts/model/modelProfileResolver'
  import SettingRenderer from '../SettingRenderer.svelte'
  import {
    memoryEmotionSettingsItems,
    memoryImageSettingsItems,
    memoryLongTermSettingsItems,
  } from 'src/ts/setting/memorySettingsData'

  let componentAlive = true
  onDestroy(() => {
    componentAlive = false
  })

  const sdProviderDraft = createServerBackedSettingDraft<string>('sdProvider', '')
  const webUiUrlDraft = createServerBackedSettingDraft<string>('webUiUrl', '')
  const sdStepsDraft = createServerBackedSettingDraft<number>('sdSteps', 20)
  const sdCFGDraft = createServerBackedSettingDraft<number>('sdCFG', 7)
  const sdConfigDraft = createServerBackedSettingDraft<Record<string, any>>('sdConfig', {})
  const NAIImgUrlDraft = createServerBackedSettingDraft<string>('NAIImgUrl', '')
  const NAIApiKeyDraft = createServerBackedSettingDraft<string>('NAIApiKey', '')
  const NAIImgModelDraft = createServerBackedSettingDraft<string>('NAIImgModel', '')
  const NAII2IDraft = createServerBackedSettingDraft<boolean>('NAII2I', false)
  const NAIImgConfigDraft = createServerBackedSettingDraft<Record<string, any>>('NAIImgConfig', {})
  const openAIKeyDraft = createServerBackedSettingDraft<string>('openAIKey', '')
  const dallEQualityDraft = createServerBackedSettingDraft<string>('dallEQuality', 'standard')
  const stabilityKeyDraft = createServerBackedSettingDraft<string>('stabilityKey', '')
  const stabilityModelDraft = createServerBackedSettingDraft<string>('stabilityModel', '')
  const stabllityStyleDraft = createServerBackedSettingDraft<string>('stabllityStyle', '')
  const comfyConfigDraft = createServerBackedSettingDraft<Record<string, any>>('comfyConfig', {})
  const comfyUiUrlDraft = createServerBackedSettingDraft<string>('comfyUiUrl', '')
  const falTokenDraft = createServerBackedSettingDraft<string>('falToken', '')
  const falModelDraft = createServerBackedSettingDraft<string>('falModel', '')
  const falLoraDraft = createServerBackedSettingDraft<string>('falLora', '')
  const falLoraScaleDraft = createServerBackedSettingDraft<number>('falLoraScale', 1)
  const googleDraft = createServerBackedSettingDraft<Record<string, any>>('google', {})
  const ImagenModelDraft = createServerBackedSettingDraft<string>('ImagenModel', '')
  const ImagenImageSizeDraft = createServerBackedSettingDraft<string>('ImagenImageSize', '1K')
  const ImagenAspectRatioDraft = createServerBackedSettingDraft<string>('ImagenAspectRatio', '1:1')
  const ImagenPersonGenerationDraft = createServerBackedSettingDraft<string>('ImagenPersonGeneration', 'allow_all')
  const openaiCompatImageDraft = createServerBackedSettingDraft<Record<string, any>>('openaiCompatImage', {})
  const wavespeedImageDraft = createServerBackedSettingDraft<Record<string, any>>('wavespeedImage', {})
  const ttsAutoSpeechDraft = createServerBackedSettingDraft<boolean>('ttsAutoSpeech', false)
  const elevenLabKeyDraft = createServerBackedSettingDraft<string>('elevenLabKey', '')
  const voicevoxUrlDraft = createServerBackedSettingDraft<string>('voicevoxUrl', '')
  const huggingfaceKeyDraft = createServerBackedSettingDraft<string>('huggingfaceKey', '')
  const fishSpeechKeyDraft = createServerBackedSettingDraft<string>('fishSpeechKey', '')
  const emotionProcesserDraft = createServerBackedSettingDraft<string>('emotionProcesser', 'submodel')
  const hypaV3Draft = createServerBackedSettingDraft<boolean>('hypaV3', false)
  const hypaV3PresetsDraft = createServerBackedSettingDraft<HypaV3Preset[]>('hypaV3Presets', [])
  const selectedHypaV3PresetIdDraft = createServerBackedSettingDraft<string | null>('selectedHypaV3PresetId', null)
  const hypaModelDraft = createServerBackedSettingDraft<string>('hypaModel', 'MiniLM')
  const hypaV3KeyDraft = createServerBackedSettingDraft<string>('hypaV3Key', '')
  const hypaCustomSettingsDraft = createServerBackedSettingDraft<Record<string, any>>('hypaCustomSettings', {
    url: '',
    key: '',
    model: '',
  })
  const voyageApiKeyDraft = createServerBackedSettingDraft<string>('voyageApiKey', '')
  let hypaPresetImportPending = $state(false)

  interface HypaV3PresetTarget {
    collection: HypaV3Preset[]
    preset: HypaV3Preset
    presetId: string
    selection: number
  }

  function selectedHypaV3PresetIndex(): number {
    return hypaV3PresetIndexFromStableId({
      hypaV3Presets: hypaV3PresetsDraft.value,
      selectedHypaV3PresetId: selectedHypaV3PresetIdDraft.value,
    })
  }

  function applyHypaV3PresetOwnerPatch(hypaV3Presets: HypaV3Preset[], selectedHypaV3PresetId: string | null): boolean {
    const hypaV3PresetId = hypaV3PresetIndexFromStableId({ hypaV3Presets, selectedHypaV3PresetId })
    if (hypaV3Presets.length === 0 ? selectedHypaV3PresetId !== null : hypaV3PresetId === -1) return false
    applyServerBackedSettingsPatch({
      hypaV3Presets,
      selectedHypaV3PresetId,
      hypaV3PresetId,
    })
    return true
  }

  function captureHypaV3PresetTarget(): HypaV3PresetTarget | null {
    const collection = hypaV3PresetsDraft.value
    const presetId = selectedHypaV3PresetIdDraft.value
    const selection = selectedHypaV3PresetIndex()
    const preset = collection?.[selection]

    if (!preset || !presetId) return null

    return { collection, preset, presetId, selection }
  }

  function stillOwnsHypaV3PresetTarget(target: HypaV3PresetTarget): boolean {
    const currentCollection = hypaV3PresetsDraft.value

    return (
      currentCollection === target.collection &&
      selectedHypaV3PresetIdDraft.value === target.presetId &&
      selectedHypaV3PresetIndex() === target.selection &&
      currentCollection[target.selection] === target.preset
    )
  }

  async function importHypaV3Preset(): Promise<void> {
    if (hypaPresetImportPending) return
    hypaPresetImportPending = true
    try {
      const selectedFile = await selectSingleFile(['json'])
      if (!componentAlive || !selectedFile?.data) return

      const objImport = JSON.parse(Buffer.from(selectedFile.data).toString('utf-8'))
      if (objImport.type !== 'risu' || !objImport.data) return

      const newPreset = createHypaV3Preset(objImport.data.name || 'Imported Preset', objImport.data.settings || {})
      const presets = [...hypaV3PresetsDraft.value, newPreset]
      const persistence = await persistServerBackedSettingsPatch({
        hypaV3Presets: presets,
        selectedHypaV3PresetId: newPreset.id,
        hypaV3PresetId: presets.length - 1,
      })
      if (!componentAlive) return
      if (persistence === 'accepted') alertNormal(language.successImport)
      if (persistence === 'queued') alertNormal(language.settingsSaveQueued)
    } catch (error) {
      if (componentAlive) alertError(`${error}`)
    } finally {
      if (componentAlive) hypaPresetImportPending = false
    }
  }

  const NAI_CHARACTER_REFERENCE_UPLOAD_FIELDS = {
    image: 'character_image',
    base64image: 'character_base64image',
  } satisfies SettingsMediaAssetUploadFieldKeys
  const NAI_I2I_BASE_UPLOAD_FIELDS = {
    image: 'image',
    base64image: 'base64image',
  } satisfies SettingsMediaAssetUploadFieldKeys
  const WAVESPEED_REFERENCE_UPLOAD_FIELDS = {
    image: 'reference_image',
    base64image: 'reference_base64image',
  } satisfies SettingsMediaAssetUploadFieldKeys

  let submenu = $state(0)

  $effect(() => {
    if (settingsResourceState.groupStatuses.display !== 'ready') {
      submenu = -1
      return
    }
    submenu = reconcileLegacyGuiSubmenu(Boolean(settingsResourceState.value.useLegacyGUI), submenu)
  })

  // HypaV3
  $effect(() => {
    const settings = hypaV3PresetsDraft.value?.[selectedHypaV3PresetIndex()]?.settings
    const currentValue = settings?.similarMemoryRatio

    if (!currentValue) return

    untrack(() => {
      const newValue = Math.min(currentValue, 1)

      settings.similarMemoryRatio = newValue

      if (newValue + settings.recentMemoryRatio > 1) {
        settings.recentMemoryRatio = 1 - newValue
      }
    })
  })

  $effect(() => {
    const settings = hypaV3PresetsDraft.value?.[selectedHypaV3PresetIndex()]?.settings
    const currentValue = settings?.recentMemoryRatio

    if (!currentValue) return

    untrack(() => {
      const newValue = Math.min(currentValue, 1)

      settings.recentMemoryRatio = newValue

      if (newValue + settings.similarMemoryRatio > 1) {
        settings.similarMemoryRatio = 1 - newValue
      }
    })
  })

  interface MemoryBudgetOwnerSnapshot {
    database: Database
    char: character
  }

  function memoryBudgetOwnerSnapshot(): MemoryBudgetOwnerSnapshot | null {
    const requiredSettingsStatuses = [
      settingsResourceState.groupStatuses.providers,
      settingsResourceState.groupStatuses.models,
      settingsResourceState.groupStatuses.runtime,
      settingsResourceState.groupStatuses.advanced,
      settingsResourceState.standaloneStatuses.promptPresetsId,
    ]
    const requiredCollectionStatuses = [
      collectionsResourceState.statuses.promptPresets,
      collectionsResourceState.statuses.promptTemplate,
    ]
    const selectedCharacter = charactersResourceState.characters[$selectedCharID]
    const characterOwner = selectedCharacter?.chaId ? getCharacterResourceOwner(selectedCharacter.chaId) : undefined

    if (
      requiredSettingsStatuses.some((status) => status !== 'ready') ||
      requiredCollectionStatuses.some((status) => status !== 'ready') ||
      charactersResourceState.status !== 'ready' ||
      !characterOwner?.chaId ||
      charactersResourceState.rowStatuses[characterOwner.chaId] !== 'ready'
    ) {
      return null
    }

    const settings = settingsResourceState.value
    const database = {
      modelProfiles: settings.modelProfiles,
      modelRoleProfiles: settings.modelRoleProfiles,
      modelRuntimeDefaults: settings.modelRuntimeDefaults,
      providerCredentials: settings.providerCredentials,
      maxResponse: settings.maxResponse,
      maxContext: settings.maxContext,
      loreBookToken: settings.loreBookToken,
      promptPresetsId: settings.promptPresetsId,
      promptPresets: collectionsResourceState.values.promptPresets,
      promptTemplate: collectionsResourceState.values.promptTemplate,
    } as Database

    return { database, char: characterOwner }
  }

  function maxMemoryRatioDependencyKey(): string {
    const owner = memoryBudgetOwnerSnapshot()
    if (!owner) {
      return JSON.stringify([
        'owner-unavailable',
        $selectedCharID,
        settingsResourceState.groupStatuses.providers,
        settingsResourceState.groupStatuses.models,
        settingsResourceState.groupStatuses.runtime,
        settingsResourceState.groupStatuses.advanced,
        settingsResourceState.standaloneStatuses.promptPresetsId,
        collectionsResourceState.statuses.promptPresets,
        collectionsResourceState.statuses.promptTemplate,
        charactersResourceState.status,
      ])
    }

    const { database, char } = owner
    const mainProfile = resolveModelProfile({ database, role: 'chatMain' })
    const promptTemplate = resolveEffectivePromptTemplate(database)

    // The await block can only subscribe to values read before the async
    // boundary. Capture every input used by token counting here so a later
    // character, prompt, or context change starts a fresh calculation.
    return JSON.stringify([
      $selectedCharID,
      promptTemplate.source,
      promptTemplate.promptPresetId ?? '',
      promptTemplate.promptTemplate,
      char,
      database.loreBookToken,
      mainProfile.runtimeOptions.maxResponse,
      mainProfile.runtimeOptions.maxContext,
    ])
  }

  async function getMaxMemoryRatio(_dependencyKey: string): Promise<number> {
    await ensurePromptTemplateHydrated()
    const owner = memoryBudgetOwnerSnapshot()
    if (!owner) throw new Error('Memory budget owner unavailable')

    const { database, char } = owner
    const mainProfile = resolveModelProfile({ database, role: 'chatMain' })
    const promptTemplateToken = await tokenizePreset(resolveEffectivePromptTemplate(database).promptTemplate)
    const charToken = await getCharToken(char)
    const maxLoreToken = char.loreSettings?.tokenBudget ?? database.loreBookToken
    const maxResponse = mainProfile.runtimeOptions.maxResponse ?? database.maxResponse
    const requiredToken =
      promptTemplateToken + charToken.persistant + Math.min(charToken.dynamic, maxLoreToken) + maxResponse * 3
    const maxContext = mainProfile.runtimeOptions.maxContext ?? database.maxContext

    if (maxContext === 0) {
      return 0
    }

    const maxMemoryRatio = Math.max((maxContext - requiredToken) / maxContext, 0)

    return parseFloat(maxMemoryRatio.toFixed(2))
  }
  // End HypaV3

  // wavespeed
  interface WavespeedModel {
    model_id: string
    name: string
    base_price: number
    supportsImageInput: boolean
    supportsLoras: boolean
  }
  interface LoraItem {
    path: string
    scale: number
  }

  function createWavespeedLoraRows(loras: LoraItem[] | undefined): LoraItem[] {
    const rows = (loras ?? []).map((lora) => ({ ...lora }))
    while (rows.length < 3) {
      rows.push({ path: '', scale: 1.0 })
    }
    return rows
  }

  function normalizeWavespeedLoras(loras: LoraItem[] | undefined): LoraItem[] {
    return (loras ?? [])
      .filter((item) => item.path && item.path.trim() !== '')
      .map((item) => ({ path: item.path, scale: item.scale }))
  }

  function wavespeedLoraSnapshot(loras: LoraItem[] | undefined): string {
    return JSON.stringify(normalizeWavespeedLoras(loras))
  }

  let wavespeedModels = $state<WavespeedModel[]>([])
  let isWavespeedLoading = $state(false)
  let wavespeedSearchQuery = $state('')
  let wavespeedLoras = $state<LoraItem[]>(createWavespeedLoraRows(wavespeedImageDraft.value.loras))
  const wavespeedModelFetchGuard = createLatestOperationGuard<'wavespeed-models'>()
  let activeWavespeedModelFetch: LatestOperationToken<'wavespeed-models'> | null = null

  onDestroy(() => {
    if (!activeWavespeedModelFetch) return
    wavespeedModelFetchGuard.clear(activeWavespeedModelFetch)
    activeWavespeedModelFetch = null
  })

  /**
   * Fetch models from WaveSpeed API dynamically
   * https://wavespeed.ai/docs/docs-common-api/models
   */
  async function fetchWavespeedModels() {
    const apiKey = wavespeedImageDraft.value.key
    if (!apiKey || apiKey.trim() === '') {
      alertError(language.errors.waveSpeedCatalogApiKeyMissing)
      return []
    }

    const token = wavespeedModelFetchGuard.issue('wavespeed-models')
    activeWavespeedModelFetch = token
    const isFresh = () => wavespeedModelFetchGuard.isLatest(token) && wavespeedImageDraft.value.key === apiKey
    isWavespeedLoading = true
    try {
      const result = await requestProviderOperation<unknown>('wavespeed.models', {
        credential: providerOperationCredential(apiKey),
      })
      if (!isFresh()) return

      let responseData: any
      try {
        responseData = typeof result === 'string' ? JSON.parse(result) : result
      } catch (e) {
        alertError(language.errors.waveSpeedCatalogParseFailed)
        return
      }

      if (responseData.code !== 200 || !Array.isArray(responseData.data)) {
        alertError(language.errors.waveSpeedCatalogResponseInvalid)
        return
      }

      // Filter, transform, and keep a deterministic selector order.
      const filteredModels: WavespeedModel[] = responseData.data
        .filter((model: any) => model.type === 'text-to-image' || model.type === 'image-to-image')
        .map((model: any) => {
          // Check if model supports LoRAs
          const supportsLoras =
            model.api_schema?.api_schemas?.some(
              (schema: any) => schema.request_schema?.properties?.loras !== undefined,
            ) ?? false

          return {
            model_id: model.model_id,
            name: model.name,
            base_price: model.base_price,
            type: model.type,
            supportsImageInput: model.type === 'image-to-image',
            supportsLoras: supportsLoras,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name) || a.model_id.localeCompare(b.model_id))

      wavespeedModels = filteredModels
      alertNormal(language.waveSpeedCatalogModelsLoaded(filteredModels.length))
    } catch (error) {
      if (isFresh()) alertError(language.errors.waveSpeedCatalogFetchFailed(String(error)))
    } finally {
      if (wavespeedModelFetchGuard.isLatest(token)) {
        isWavespeedLoading = false
        activeWavespeedModelFetch = null
      }
      wavespeedModelFetchGuard.clear(token)
    }
  }

  function getSelectedWavespeedModel(): WavespeedModel | undefined {
    return wavespeedModels.find((m) => m.model_id === wavespeedImageDraft.value.model)
  }

  function handleModelChange() {
    const selectedModel = getSelectedWavespeedModel()

    // Reset reference_mode for text-to-image models
    if (!selectedModel?.supportsImageInput) {
      wavespeedImageDraft.value.reference_mode = ''
      wavespeedImageDraft.value.reference_image = undefined
      wavespeedImageDraft.value.reference_base64image = undefined
    }

    // Reset loras if model doesn't support them
    if (!selectedModel?.supportsLoras) {
      wavespeedImageDraft.value.loras = undefined
    }
  }

  /**
   * Get display name for a WaveSpeed model
   * @param model - The model to get display name for
   */
  function getModelDisplayName(model: WavespeedModel): string {
    const imageInputIcon = model.supportsImageInput ? '✓' : '✗'
    const loraIcon = model.supportsLoras ? '✓' : '✗'
    return `${model.name} (price: ${model.base_price}) [${imageInputIcon} Image] [${loraIcon} LoRA]`
  }

  /** Filter models based on the search query. */
  function getFilteredModels(): WavespeedModel[] {
    if (wavespeedSearchQuery === '') return wavespeedModels

    const searchTerms = wavespeedSearchQuery.toLowerCase().trim().split(/\s+/)
    return wavespeedModels.filter((model) => {
      const modelText = (model.name + ' ' + model.model_id).toLowerCase()
      return searchTerms.every((term) => modelText.includes(term))
    })
  }

  function getVibeEncodingEntries(): Array<[string, { params: { information_extracted: number } }]> {
    const config = NAIImgConfigDraft.value
    const selection = config.vibe_model_selection
    const encodings = selection ? config.vibe_data?.encodings?.[selection] : undefined
    return Object.entries(encodings ?? {}) as Array<[string, { params: { information_extracted: number } }]>
  }

  function naiCharacterReferenceUploadContext() {
    return {
      provider: sdProviderDraft.value,
      model: NAIImgModelDraft.value,
      reference_mode: NAIImgConfigDraft.value.reference_mode,
    }
  }

  function naiI2IBaseUploadContext() {
    return {
      provider: sdProviderDraft.value,
      model: NAIImgModelDraft.value,
      i2i: NAII2IDraft.value,
    }
  }

  function wavespeedReferenceUploadContext() {
    return {
      provider: sdProviderDraft.value,
      model: wavespeedImageDraft.value.model,
      reference_mode: wavespeedImageDraft.value.reference_mode,
      supportsImageInput: getSelectedWavespeedModel()?.supportsImageInput ?? false,
    }
  }

  function currentNaiCharacterReferenceUploadTarget(): SettingsMediaAssetUploadTarget {
    return captureSettingsMediaAssetUploadTarget({
      targetId: 'nai-character-reference',
      fieldKeys: NAI_CHARACTER_REFERENCE_UPLOAD_FIELDS,
      config: NAIImgConfigDraft.value,
      context: naiCharacterReferenceUploadContext(),
    })
  }

  function currentNaiI2IBaseUploadTarget(): SettingsMediaAssetUploadTarget {
    return captureSettingsMediaAssetUploadTarget({
      targetId: 'nai-i2i-base',
      fieldKeys: NAI_I2I_BASE_UPLOAD_FIELDS,
      config: NAIImgConfigDraft.value,
      context: naiI2IBaseUploadContext(),
    })
  }

  function currentWavespeedReferenceUploadTarget(): SettingsMediaAssetUploadTarget {
    return captureSettingsMediaAssetUploadTarget({
      targetId: 'wavespeed-reference',
      fieldKeys: WAVESPEED_REFERENCE_UPLOAD_FIELDS,
      config: wavespeedImageDraft.value,
      context: wavespeedReferenceUploadContext(),
    })
  }

  function settingsMediaAssetUploadFreshness(
    operation: SettingsMediaAssetUploadOperation,
  ): SettingsMediaAssetUploadFreshness {
    switch (operation.targetId) {
      case 'nai-character-reference':
        return {
          config: NAIImgConfigDraft.value,
          context: naiCharacterReferenceUploadContext(),
        }
      case 'nai-i2i-base':
        return {
          config: NAIImgConfigDraft.value,
          context: naiI2IBaseUploadContext(),
        }
      case 'wavespeed-reference':
        return {
          config: wavespeedImageDraft.value,
          context: wavespeedReferenceUploadContext(),
        }
    }
  }

  function isCurrentSettingsMediaAssetUpload(operation: SettingsMediaAssetUploadOperation): boolean {
    return isFreshSettingsMediaAssetUpload(operation, settingsMediaAssetUploadFreshness(operation))
  }

  function writeSettingsMediaAssetUploadConfig(
    operation: SettingsMediaAssetUploadOperation,
    config: Record<string, unknown>,
  ): void {
    switch (operation.targetId) {
      case 'nai-character-reference':
        NAIImgConfigDraft.value = config
        console.log('Character image set:', NAIImgConfigDraft.value.character_image)
        return
      case 'nai-i2i-base':
        NAIImgConfigDraft.value = config
        return
      case 'wavespeed-reference':
        wavespeedImageDraft.value = config
        console.log('WaveSpeed reference image set:', wavespeedImageDraft.value.reference_image)
    }
  }

  async function uploadSettingsMediaAsset(target: SettingsMediaAssetUploadTarget): Promise<void> {
    let operation: SettingsMediaAssetUploadOperation | null = null
    try {
      const img = await selectSingleFile(['jpg', 'jpeg', 'png', 'webp'], {
        onFileSelected: () => {
          operation = beginSettingsMediaAssetUpload(target)
        },
      })
      if (!img || !operation) return

      const activeOperation = operation
      if (!isCurrentSettingsMediaAssetUpload(activeOperation)) return

      const imageData = img.data
      const saveId = await saveAsset(imageData, '', img.name)
      if (!isCurrentSettingsMediaAssetUpload(activeOperation)) return

      const nextConfig = applyFreshSettingsMediaAssetUpload({
        operation: activeOperation,
        freshness: settingsMediaAssetUploadFreshness(activeOperation),
        image: saveId,
      })
      if (!nextConfig) return

      writeSettingsMediaAssetUploadConfig(activeOperation, nextConfig)
    } finally {
      if (operation) {
        clearSettingsMediaAssetUpload(operation)
      }
    }
  }

  async function uploadNaiCharacterReferenceImage(): Promise<void> {
    const target = currentNaiCharacterReferenceUploadTarget()
    await uploadSettingsMediaAsset(target)
  }

  async function uploadNaiI2IBaseImage(): Promise<void> {
    const target = currentNaiI2IBaseUploadTarget()
    await uploadSettingsMediaAsset(target)
  }

  async function uploadWavespeedReferenceImage(): Promise<void> {
    const target = currentWavespeedReferenceUploadTarget()
    await uploadSettingsMediaAsset(target)
  }

  function currentNaiVibeImportFreshness(): NaiVibeImportFreshness {
    return {
      provider: sdProviderDraft.value,
      model: NAIImgModelDraft.value,
      reference_mode: NAIImgConfigDraft.value.reference_mode,
      config: NAIImgConfigDraft.value,
    }
  }

  async function importNaiVibeFile(): Promise<void> {
    const target = captureNaiVibeImportTarget(currentNaiVibeImportFreshness())
    let operation: NaiVibeImportOperation | null = null
    const beginImport = () => {
      operation ??= beginNaiVibeImport(target)
    }

    try {
      const selected = await selectSingleFile(['naiv4vibe'], { onFileSelected: beginImport })
      if (!selected) return

      beginImport()
      if (!operation) return

      const vibeData = parseNaiVibeImport(new TextDecoder().decode(selected.data))
      if (vibeData === null) {
        if (isFreshNaiVibeImport(operation, currentNaiVibeImportFreshness())) {
          alertError('Invalid vibe file. Version must be 1.')
        }
        return
      }

      const patch = resolveFreshNaiVibeImportPatch({
        operation,
        freshness: currentNaiVibeImportFreshness(),
        vibeData,
      })
      if (!patch) return

      NAIImgConfigDraft.value = { ...NAIImgConfigDraft.value, ...patch }
    } catch (error) {
      if (operation && isFreshNaiVibeImport(operation, currentNaiVibeImportFreshness())) {
        alertError('Error parsing vibe file: ' + error)
      }
    } finally {
      if (operation) {
        clearNaiVibeImport(operation)
      }
    }
  }

  $effect(() => {
    const projectedLoras = normalizeWavespeedLoras(wavespeedImageDraft.value.loras)
    const projectedSnapshot = JSON.stringify(projectedLoras)

    untrack(() => {
      if (wavespeedLoraSnapshot(wavespeedLoras) === projectedSnapshot) return
      wavespeedLoras = createWavespeedLoraRows(projectedLoras)
    })
  })

  $effect(() => {
    // Keep empty UI rows out of persisted settings, while still accepting
    // authoritative draft changes such as command rollbacks and refreshes.
    const normalizedLoras = normalizeWavespeedLoras(wavespeedLoras)
    const rowsSnapshot = JSON.stringify(normalizedLoras)

    untrack(() => {
      if (wavespeedLoraSnapshot(wavespeedImageDraft.value.loras) === rowsSnapshot) return
      wavespeedImageDraft.value.loras = normalizedLoras
    })
  })
  // End wavespeed
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.settingsNavMemory}</h2>

{#if submenu !== -1}
  <div
    data-risu-media-settings-tabs
    class="flex w-full max-w-full rounded-md border border-darkborderc mb-4 overflow-x-auto">
    <button
      aria-pressed={submenu === 0}
      onclick={() => {
        submenu = 0
      }}
      class="p-2 flex-1 border-r border-darkborderc"
      class:bg-darkbutton={submenu === 0}>
      <span>{language.longTermMemory}</span>
    </button>
    <button
      aria-pressed={submenu === 1}
      onclick={() => {
        submenu = 1
      }}
      class="p-2 flex-1 border-r border-darkborderc"
      class:bg-darkbutton={submenu === 1}>
      <span>TTS</span>
    </button>
    <button
      aria-pressed={submenu === 2}
      onclick={() => {
        submenu = 2
      }}
      class="p-2 flex-1 border-r border-darkborderc"
      class:bg-darkbutton={submenu === 2}>
      <span>{language.emotionImage}</span>
    </button>
    <button
      aria-pressed={submenu === 3}
      onclick={() => {
        submenu = 3
      }}
      class="p-2 flex-1"
      class:bg-darkbutton={submenu === 3}>
      <span>{language.imageGeneration}</span>
    </button>
  </div>
{/if}

{#if submenu === 3 || submenu === -1}
  <Accordion name={language.imageGeneration} styled disabled={submenu !== -1}>
    <SettingRenderer items={memoryImageSettingsItems} />
    <span class="text-textcolor mt-2">{language.imageGeneration} {language.provider} <Help key="sdProvider" /></span>
    <SelectInput className="mt-2 mb-4" bind:value={sdProviderDraft.value}>
      <OptionInput value="">None</OptionInput>
      <OptionInput value="webui">Stable Diffusion WebUI</OptionInput>
      <OptionInput value="novelai">Novel AI</OptionInput>
      <OptionInput value="dalle">Dall-E</OptionInput>
      <OptionInput value="stability">Stability API</OptionInput>
      <OptionInput value="fal">Fal.ai</OptionInput>
      <OptionInput value="comfyui">ComfyUI</OptionInput>
      <OptionInput value="Imagen">Imagen</OptionInput>
      <OptionInput value="openai-compat">OpenAI Compatible</OptionInput>
      <OptionInput value="wavespeed">WaveSpeedAI</OptionInput>

      <!-- Legacy -->
      {#if sdProviderDraft.value === 'comfy'}
        <OptionInput value="comfy">ComfyUI (Legacy)</OptionInput>
      {/if}
    </SelectInput>

    {#if sdProviderDraft.value === 'webui'}
      <span class="text-draculared text-xs mb-2">You must use WebUI with --api flag</span>
      <span class="text-draculared text-xs mb-2"
        >You must use WebUI without agpl license or use unmodified version with agpl license to observe the contents of
        the agpl license.</span>
      <span class="text-draculared text-xs mb-2"
        >To reach a local WebUI from the browser, use ngrok or other tunnels.</span>
      <span class="text-textcolor mt-2">WebUI {language.providerURL}</span>
      <TextInput size="sm" marginBottom placeholder="https://..." bind:value={webUiUrlDraft.value} />
      <span class="text-textcolor">Steps</span>
      <NumberInput size="sm" marginBottom min={0} max={100} bind:value={sdStepsDraft.value} />

      <span class="text-textcolor">CFG Scale</span>
      <NumberInput size="sm" marginBottom min={0} max={20} bind:value={sdCFGDraft.value} />

      <span class="text-textcolor">Width</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={sdConfigDraft.value.width} />
      <span class="text-textcolor">Height</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={sdConfigDraft.value.height} />
      <span class="text-textcolor">Sampler</span>
      <TextInput size="sm" marginBottom bind:value={sdConfigDraft.value.sampler_name} />

      <div class="flex items-center mt-2">
        <Check bind:check={sdConfigDraft.value.enable_hr} name="Enable Hires" />
      </div>
      {#if sdConfigDraft.value.enable_hr === true}
        <span class="text-textcolor">denoising_strength</span>
        <NumberInput size="sm" marginBottom min={0} max={10} bind:value={sdConfigDraft.value.denoising_strength} />
        <span class="text-textcolor">hr_scale</span>
        <NumberInput size="sm" marginBottom min={0} max={10} bind:value={sdConfigDraft.value.hr_scale} />
        <span class="text-textcolor">Upscaler</span>
        <TextInput size="sm" marginBottom bind:value={sdConfigDraft.value.hr_upscaler} />
      {/if}
    {/if}

    {#if sdProviderDraft.value === 'novelai'}
      <span class="text-textcolor mt-2">Novel AI {language.providerURL}</span>
      <TextInput size="sm" marginBottom placeholder="https://image.novelai.net" bind:value={NAIImgUrlDraft.value} />
      <span class="text-textcolor">API Key</span>
      <SecretInput
        size="sm"
        marginBottom
        placeholder="pst-..."
        ownerKey="NAIApiKey"
        bind:value={NAIApiKeyDraft.value} />

      <span class="text-textcolor">Model</span>
      <SelectInput className="mb-4" bind:value={NAIImgModelDraft.value}>
        <OptionInput value="nai-diffusion-4-5-full">nai-diffusion-4-5-full</OptionInput>
        <OptionInput value="nai-diffusion-4-5-curated">nai-diffusion-4-5-curated</OptionInput>
        <OptionInput value="nai-diffusion-4-full">nai-diffusion-4-full</OptionInput>
        <OptionInput value="nai-diffusion-4-curated-preview">nai-diffusion-4-curated-preview</OptionInput>
        <OptionInput value="nai-diffusion-3">nai-diffusion-3</OptionInput>
        <OptionInput value="nai-diffusion-furry-3">nai-diffusion-furry-3</OptionInput>
        <OptionInput value="nai-diffusion-2">nai-diffusion-2</OptionInput>
      </SelectInput>

      <span class="text-textcolor">Width</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={NAIImgConfigDraft.value.width} />
      <span class="text-textcolor">Height</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={NAIImgConfigDraft.value.height} />
      <span class="text-textcolor">Sampler</span>

      {#if NAIImgModelDraft.value === 'nai-diffusion-4-full' || NAIImgModelDraft.value === 'nai-diffusion-4-curated-preview' || NAIImgModelDraft.value === 'nai-diffusion-4-5-full' || NAIImgModelDraft.value === 'nai-diffusion-4-5-curated'}
        <SelectInput className="mb-4" bind:value={NAIImgConfigDraft.value.sampler}>
          <OptionInput value="k_euler_ancestral">Euler Ancestral</OptionInput>
          <OptionInput value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</OptionInput>
          <OptionInput value="k_dpmpp_2m_sde">DPM++ 2M SDE</OptionInput>
          <OptionInput value="k_euler">Euler</OptionInput>
          <OptionInput value="k_dpmpp_2m">DPM++ 2M</OptionInput>
          <OptionInput value="k_dpmpp_sde">DPM++ SDE</OptionInput>
        </SelectInput>
      {:else}
        <SelectInput className="mb-4" bind:value={NAIImgConfigDraft.value.sampler}>
          <OptionInput value="k_euler_ancestral">Euler Ancestral</OptionInput>
          <OptionInput value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</OptionInput>
          <OptionInput value="k_dpmpp_sde">DPM++ SDE</OptionInput>
          <OptionInput value="k_euler">Euler</OptionInput>
          <OptionInput value="k_dpmpp_2m">DPM++ 2M</OptionInput>
          <OptionInput value="k_dpmpp_2s">DPM++ 2S</OptionInput>
          <OptionInput value="ddim_v3">DDIM</OptionInput>
        </SelectInput>
      {/if}

      <span class="text-textcolor">Noise Schedule</span>
      <SelectInput className="mb-4" bind:value={NAIImgConfigDraft.value.noise_schedule}>
        <OptionInput value="native">native</OptionInput>
        <OptionInput value="karras">karras</OptionInput>
        <OptionInput value="exponential">exponential</OptionInput>
        <OptionInput value="polyexponential">polyexponential</OptionInput>
      </SelectInput>

      <span class="text-textcolor">steps</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={NAIImgConfigDraft.value.steps} />
      <span class="text-textcolor">CFG scale</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={NAIImgConfigDraft.value.scale} />
      <span class="text-textcolor">CFG rescale</span>
      <NumberInput size="sm" marginBottom min={0} max={1} bind:value={NAIImgConfigDraft.value.cfg_rescale} />

      <span class="text-textcolor">Image Reference</span>
      <SelectInput className="mb-4" bind:value={NAIImgConfigDraft.value.reference_mode}>
        <OptionInput value="">None</OptionInput>
        <OptionInput value="vibe">Vibe Trasfer</OptionInput>
        {#if NAIImgModelDraft.value === 'nai-diffusion-4-5-full' || NAIImgModelDraft.value === 'nai-diffusion-4-5-curated'}
          <OptionInput value="character">Character Reference</OptionInput>
        {/if}
      </SelectInput>

      {#if NAIImgConfigDraft.value.reference_mode === 'vibe'}
        <div class="relative">
          <button class="mb-4" onclick={importNaiVibeFile}>
            {#if !NAIImgConfigDraft.value.vibe_data || !NAIImgConfigDraft.value.vibe_data.thumbnail}
              <div
                class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                <span class="text-sm">Upload<br />Vibe</span>
              </div>
            {:else}
              <img
                src={NAIImgConfigDraft.value.vibe_data.thumbnail}
                alt="Vibe Preview"
                class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500" />
            {/if}
          </button>

          {#if NAIImgConfigDraft.value.vibe_data}
            <button
              onclick={() => {
                if (!confirmSettingsItemRemoval()) return
                NAIImgConfigDraft.value.vibe_data = undefined
                NAIImgConfigDraft.value.vibe_model_selection = undefined
              }}
              class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm">
              Delete
            </button>
          {/if}
        </div>

        {#if NAIImgConfigDraft.value.vibe_data}
          <span class="text-textcolor">Vibe Model</span>
          <SelectInput
            className="mb-2"
            bind:value={NAIImgConfigDraft.value.vibe_model_selection}
            onchange={(e) => {
              // When vibe model changes, set InfoExtracted to the first value
              if (
                NAIImgConfigDraft.value.vibe_data?.encodings &&
                NAIImgConfigDraft.value.vibe_model_selection &&
                NAIImgConfigDraft.value.vibe_data.encodings[NAIImgConfigDraft.value.vibe_model_selection]
              ) {
                const encodings =
                  NAIImgConfigDraft.value.vibe_data.encodings[NAIImgConfigDraft.value.vibe_model_selection]
                const firstKey = Object.keys(encodings)[0]
                if (firstKey) {
                  NAIImgConfigDraft.value.InfoExtracted = Number(encodings[firstKey].params.information_extracted)
                }
              }
            }}>
            {#if NAIImgConfigDraft.value.vibe_data.encodings?.v4full}
              <OptionInput value="v4full">nai-diffusion-4-full</OptionInput>
            {/if}
            {#if NAIImgConfigDraft.value.vibe_data.encodings?.v4curated}
              <OptionInput value="v4curated">nai-diffusion-4-curated</OptionInput>
            {/if}
            {#if NAIImgConfigDraft.value.vibe_data.encodings?.['v4-5full']}
              <OptionInput value="v4-5full">nai-diffusion-4-5-full</OptionInput>
            {/if}
            {#if NAIImgConfigDraft.value.vibe_data.encodings?.['v4-5curated']}
              <OptionInput value="v4-5curated">nai-diffusion-4-5-curated</OptionInput>
            {/if}
          </SelectInput>

          <span class="text-textcolor">Information Extracted</span>
          <SelectInput className="mb-2" bind:value={NAIImgConfigDraft.value.InfoExtracted}>
            {#if getVibeEncodingEntries().length > 0}
              {#each getVibeEncodingEntries() as [key, value]}
                <OptionInput value={value.params.information_extracted}
                  >{value.params.information_extracted}</OptionInput>
              {/each}
            {/if}
          </SelectInput>

          <span class="text-textcolor">Reference Strength Multiple</span>
          <SliderInput
            marginBottom
            min={0}
            max={1}
            step={0.1}
            fixed={2}
            bind:value={NAIImgConfigDraft.value.reference_strength_multiple[0]}
            ariaLabel="Reference Strength Multiple" />
        {/if}
      {/if}

      {#if NAIImgConfigDraft.value.reference_mode === 'character' && (NAIImgModelDraft.value === 'nai-diffusion-4-5-full' || NAIImgModelDraft.value === 'nai-diffusion-4-5-curated')}
        <div class="relative">
          <button class="mb-2" onclick={uploadNaiCharacterReferenceImage}>
            {#if !NAIImgConfigDraft.value.character_image || NAIImgConfigDraft.value.character_image === ''}
              <div
                class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                <span class="text-sm">Upload<br />Image</span>
              </div>
            {:else}
              {#await getCharImage(NAIImgConfigDraft.value.character_image, 'plain')}
                <div
                  class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                  <span class="text-sm">Uploading<br />Image..</span>
                </div>
              {:then im}
                <img
                  src={im}
                  class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                  alt="Base Preview" />
              {/await}
            {/if}
          </button>

          {#if NAIImgConfigDraft.value.character_image && NAIImgConfigDraft.value.character_image !== ''}
            <button
              onclick={() => {
                if (!confirmSettingsItemRemoval()) return
                NAIImgConfigDraft.value.character_image = undefined
                NAIImgConfigDraft.value.character_base64image = undefined
              }}
              class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm">
              Delete
            </button>
          {/if}
        </div>

        <span class="text-textcolor2 text-xs mb-2 block">Leave blank to use the character's default image.</span>

        <Check className="mb-4" bind:check={NAIImgConfigDraft.value.style_aware} name="Style Aware" />
      {/if}

      {#if (NAIImgModelDraft.value === 'nai-diffusion-3' || NAIImgModelDraft.value === 'nai-diffusion-furry-3' || NAIImgModelDraft.value === 'nai-diffusion-2') && NAIImgConfigDraft.value.sampler !== 'ddim_v3'}
        <Check bind:check={NAIImgConfigDraft.value.sm} name="Use SMEA" />
      {/if}

      {#if NAIImgModelDraft.value === 'nai-diffusion-3' && NAIImgConfigDraft.value.sampler !== 'ddim_v3'}
        <Check bind:check={NAIImgConfigDraft.value.sm_dyn} name="Use DYN" />
      {/if}

      {#if NAIImgModelDraft.value === 'nai-diffusion-4-5-full' || NAIImgModelDraft.value === 'nai-diffusion-4-5-curated' || NAIImgModelDraft.value === 'nai-diffusion-4-full' || NAIImgModelDraft.value === 'nai-diffusion-4-curated-preview' || NAIImgModelDraft.value === 'nai-diffusion-3' || NAIImgModelDraft.value === 'nai-diffusion-furry-3'}
        <Check bind:check={NAIImgConfigDraft.value.variety_plus} name="Variety+" />
      {/if}

      {#if NAIImgModelDraft.value === 'nai-diffusion-3' || NAIImgModelDraft.value === 'nai-diffusion-furry-3' || NAIImgModelDraft.value === 'nai-diffusion-2'}
        <Check bind:check={NAIImgConfigDraft.value.decrisp} name="Decrisp" />
      {/if}

      {#if NAIImgModelDraft.value === 'nai-diffusion-4-full' || NAIImgModelDraft.value === 'nai-diffusion-4-curated-preview'}
        <Check bind:check={NAIImgConfigDraft.value.legacy_uc} name="Use legacy uc" />
      {/if}

      <Check className="mt-4 mb-4" bind:check={NAII2IDraft.value} name="Enable I2I" />

      {#if NAII2IDraft.value}
        <div class="relative">
          <button class="mb-2" onclick={uploadNaiI2IBaseImage}>
            {#if !NAIImgConfigDraft.value.image || NAIImgConfigDraft.value.image === ''}
              <div
                class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                <span class="text-sm">Upload<br />Image</span>
              </div>
            {:else}
              {#await getCharImage(NAIImgConfigDraft.value.image, 'plain')}
                <div
                  class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                  <span class="text-sm">Uploading<br />Image..</span>
                </div>
              {:then im}
                <img
                  src={im}
                  class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                  alt="Base Preview" />
              {/await}
            {/if}
          </button>

          {#if NAIImgConfigDraft.value.image && NAIImgConfigDraft.value.image !== ''}
            <button
              onclick={() => {
                if (!confirmSettingsItemRemoval()) return
                NAIImgConfigDraft.value.image = undefined
                NAIImgConfigDraft.value.base64image = undefined
              }}
              class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm">
              Delete
            </button>
          {/if}
        </div>
        <span class="text-textcolor2 text-xs block">Leave blank to use the character's default image.</span>

        <span class="text-textcolor mt-2">Strength</span>
        <SliderInput
          min={0}
          max={0.99}
          step={0.01}
          fixed={2}
          bind:value={NAIImgConfigDraft.value.strength}
          ariaLabel="Strength" />
        <span class="text-textcolor mt-2">Noise</span>
        <SliderInput
          min={0}
          max={0.99}
          step={0.01}
          fixed={2}
          bind:value={NAIImgConfigDraft.value.noise}
          ariaLabel="Noise" />
      {/if}
    {/if}

    {#if sdProviderDraft.value === 'dalle'}
      <span class="text-textcolor">OpenAI API Key</span>
      <SecretInput size="sm" marginBottom placeholder="sk-..." ownerKey="openAIKey" bind:value={openAIKeyDraft.value} />

      <span class="text-textcolor mt-4">Dall-E Quality</span>
      <SelectInput className="mt-2 mb-4" bind:value={dallEQualityDraft.value}>
        <OptionInput value="standard">Standard</OptionInput>
        <OptionInput value="hd">HD</OptionInput>
      </SelectInput>
    {/if}

    {#if sdProviderDraft.value === 'stability'}
      <span class="text-textcolor">Stability API Key</span>
      <SecretInput
        size="sm"
        marginBottom
        placeholder="..."
        ownerKey="stabilityKey"
        bind:value={stabilityKeyDraft.value} />

      <span class="text-textcolor">Stability Model</span>
      <SelectInput className="mt-2 mb-4" bind:value={stabilityModelDraft.value}>
        <OptionInput value="ultra">SD Ultra</OptionInput>
        <OptionInput value="core">SD Core</OptionInput>
        <OptionInput value="sd3-large">SD3 Large</OptionInput>
        <OptionInput value="sd3-medium">SD3 Medium</OptionInput>
      </SelectInput>

      {#if stabilityModelDraft.value === 'core'}
        <span class="text-textcolor">SD Core Style</span>
        <SelectInput className="mt-2 mb-4" bind:value={stabllityStyleDraft.value}>
          <OptionInput value="">Unspecified</OptionInput>
          <OptionInput value="3d-model">3D Model</OptionInput>
          <OptionInput value="analog-film">Analog Film</OptionInput>
          <OptionInput value="anime">Anime</OptionInput>
          <OptionInput value="cinematic">Cinematic</OptionInput>
          <OptionInput value="comic-book">Comic Book</OptionInput>
          <OptionInput value="digital-art">Digital Art</OptionInput>
          <OptionInput value="enhance">Enhance</OptionInput>
          <OptionInput value="fantasy-art">Fantasy Art</OptionInput>
          <OptionInput value="isometric">Isometric</OptionInput>
          <OptionInput value="line-art">Line Art</OptionInput>
          <OptionInput value="low-poly">Low Poly</OptionInput>
          <OptionInput value="modeling-compound">Modeling Compound</OptionInput>
          <OptionInput value="neon-punk">Neon Punk</OptionInput>
          <OptionInput value="origami">Origami</OptionInput>
          <OptionInput value="photographic">Photographic</OptionInput>
          <OptionInput value="pixel-art">Pixel Art</OptionInput>
          <OptionInput value="tile-texture">Tile Texture</OptionInput>
        </SelectInput>
      {/if}
    {/if}

    {#if sdProviderDraft.value === 'comfyui'}
      <span class="text-textcolor mt-2">ComfyUI {language.providerURL}</span>
      <TextInput size="sm" marginBottom placeholder="http://127.0.0.1:8188" bind:value={comfyUiUrlDraft.value} />

      <span class="text-textcolor">Workflow <Help key="comfyWorkflow" /></span>
      <TextInput size="sm" marginBottom bind:value={comfyConfigDraft.value.workflow} />

      <span class="text-textcolor">Timeout (sec)</span>
      <NumberInput size="sm" marginBottom bind:value={comfyConfigDraft.value.timeout} min={1} max={120} />
    {/if}

    {#if sdProviderDraft.value === 'comfy'}
      <span class="text-draculared text-xs mb-2">The first image generated by the prompt will be selected. </span>
      <span class="text-draculared text-xs mb-2">"Please run comfyUI with --enable-cors-header."</span>
      <span class="text-textcolor mt-2">ComfyUI {language.providerURL}</span>
      <TextInput size="sm" marginBottom placeholder="http://127.0.0.1:8188" bind:value={comfyUiUrlDraft.value} />
      <span class="text-textcolor">Workflow</span>
      <TextInput
        size="sm"
        marginBottom
        placeholder="valid ComfyUI API json (Enable Dev mode Options in ComfyUI)"
        bind:value={comfyConfigDraft.value.workflow} />

      <span class="text-textcolor">Positive Text Node: ID</span>
      <TextInput size="sm" marginBottom placeholder="eg. 1, 3, etc" bind:value={comfyConfigDraft.value.posNodeID} />
      <span class="text-textcolor">Positive Text Node: Input Field Name</span>
      <TextInput size="sm" marginBottom placeholder="eg. text" bind:value={comfyConfigDraft.value.posInputName} />
      <span class="text-textcolor">Negative Text Node: ID</span>
      <TextInput size="sm" marginBottom placeholder="eg. 1, 3, etc" bind:value={comfyConfigDraft.value.negNodeID} />
      <span class="text-textcolor">Positive Text Node: Input Field Name</span>
      <TextInput size="sm" marginBottom placeholder="eg. text" bind:value={comfyConfigDraft.value.negInputName} />
      <span class="text-textcolor">Timeout (sec)</span>
      <NumberInput size="sm" marginBottom bind:value={comfyConfigDraft.value.timeout} min={1} max={120} />
    {/if}

    {#if sdProviderDraft.value === 'fal'}
      <span class="text-textcolor">Fal.ai API Key</span>
      <SecretInput size="sm" marginBottom placeholder="..." ownerKey="falToken" bind:value={falTokenDraft.value} />

      <span class="text-textcolor mt-4">Width</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={sdConfigDraft.value.width} />
      <span class="text-textcolor mt-4">Height</span>
      <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={sdConfigDraft.value.height} />

      <span class="text-textcolor mt-4">Model</span>
      <SelectInput className="mt-2" bind:value={falModelDraft.value}>
        <OptionInput value="fal-ai/flux/dev">Flux[Dev]</OptionInput>
        <OptionInput value="fal-ai/flux-lora">Flux[Dev] with Lora</OptionInput>
        <OptionInput value="fal-ai/flux-pro">Flux[Pro]</OptionInput>
        <OptionInput value="fal-ai/flux/schnell">Flux[Schnell]</OptionInput>
      </SelectInput>

      {#if falModelDraft.value === 'fal-ai/flux-lora'}
        <span class="text-textcolor mt-4">Lora Model URL <Help key="urllora" /></span>
        <TextInput size="sm" marginBottom bind:value={falLoraDraft.value} />

        <span class="text-textcolor mt-4">Lora Weight</span>
        <SliderInput
          fixed={2}
          min={0}
          max={2}
          step={0.01}
          bind:value={falLoraScaleDraft.value}
          ariaLabel="Lora Weight" />
      {/if}
    {/if}

    {#if sdProviderDraft.value === 'Imagen'}
      <span class="text-textcolor mt-2">GoogleAI API Key</span>
      <SecretInput
        marginBottom={true}
        size={'sm'}
        placeholder="..."
        ownerKey="google.accessToken"
        bind:value={googleDraft.value.accessToken} />

      <span class="text-textcolor">Model</span>
      <SelectInput className="mb-4" bind:value={ImagenModelDraft.value}>
        <OptionInput value="imagen-4.0-generate-001">Imagen 4</OptionInput>
        <OptionInput value="imagen-4.0-ultra-generate-001">Imagen 4 Ultra</OptionInput>
        <OptionInput value="imagen-4.0-fast-generate-001">Imagen 4 Fast</OptionInput>
        <OptionInput value="imagen-3.0-generate-002">Imagen 3.0</OptionInput>
      </SelectInput>

      {#if ImagenModelDraft.value === 'imagen-4.0-generate-001' || ImagenModelDraft.value === 'imagen-4.0-ultra-generate-001'}
        <span class="text-textcolor">Image size</span>
        <SelectInput className="mb-4" bind:value={ImagenImageSizeDraft.value}>
          <OptionInput value="1K">1K</OptionInput>
          <OptionInput value="2K">2K</OptionInput>
        </SelectInput>
      {/if}

      <span class="text-textcolor">Aspect ratio</span>
      <SelectInput className="mb-4" bind:value={ImagenAspectRatioDraft.value}>
        <OptionInput value="1:1">1:1</OptionInput>
        <OptionInput value="3:4">3:4</OptionInput>
        <OptionInput value="4:3">4:3</OptionInput>
        <OptionInput value="9:16">9:16</OptionInput>
        <OptionInput value="16:9">16:9</OptionInput>
      </SelectInput>

      <span class="text-textcolor">Person generation</span>
      <SelectInput className="mb-4" bind:value={ImagenPersonGenerationDraft.value}>
        <OptionInput value="allow_all">Allow all</OptionInput>
        <OptionInput value="allow_adult">Allow adult</OptionInput>
        <OptionInput value="dont_allow">Don't allow</OptionInput>
      </SelectInput>
    {/if}

    {#if sdProviderDraft.value === 'openai-compat'}
      <span class="text-textcolor mt-2">API URL</span>
      <TextInput
        size="sm"
        marginBottom
        placeholder="https://api.example.com/v1/images/generations"
        bind:value={openaiCompatImageDraft.value.url} />

      <span class="text-textcolor">API Key</span>
      <SecretInput
        size="sm"
        marginBottom
        placeholder="sk-..."
        ownerKey="openaiCompatImage.key"
        bind:value={openaiCompatImageDraft.value.key} />

      <span class="text-textcolor">Model</span>
      <TextInput size="sm" marginBottom placeholder="dall-e-3" bind:value={openaiCompatImageDraft.value.model} />

      <span class="text-textcolor">Image Size</span>
      <SelectInput className="mb-4" bind:value={openaiCompatImageDraft.value.size}>
        <OptionInput value="1024x1024">1024x1024</OptionInput>
        <OptionInput value="1536x1024">1536x1024</OptionInput>
        <OptionInput value="1024x1536">1024x1536</OptionInput>
        <OptionInput value="512x512">512x512</OptionInput>
        <OptionInput value="256x256">256x256</OptionInput>
      </SelectInput>

      <span class="text-textcolor">Quality</span>
      <SelectInput className="mb-4" bind:value={openaiCompatImageDraft.value.quality}>
        <OptionInput value="auto">Auto</OptionInput>
        <OptionInput value="low">Low</OptionInput>
        <OptionInput value="medium">Medium</OptionInput>
        <OptionInput value="high">High</OptionInput>
      </SelectInput>
    {/if}

    {#if sdProviderDraft.value === 'wavespeed'}
      <span class="text-textcolor">API Key</span>
      <SecretInput
        size="sm"
        marginBottom
        placeholder="sk-..."
        ownerKey="wavespeedImage.key"
        bind:value={wavespeedImageDraft.value.key} />

      <span class="text-textcolor">Model</span>
      <button
        class="px-3 py-2 bg-darkbutton rounded-md hover:bg-textcolor2 transition-colors disabled:opacity-50"
        disabled={isWavespeedLoading}
        onclick={fetchWavespeedModels}>
        {isWavespeedLoading ? 'Loading...' : 'Refresh Models'}
      </button>
      <TextInput bind:value={wavespeedSearchQuery} placeholder="Search models..." size="sm" marginBottom />
      <SelectInput className="mb-4" bind:value={wavespeedImageDraft.value.model} onchange={handleModelChange}>
        <OptionInput value="">Select a model...</OptionInput>
        {#if wavespeedModels.length > 0}
          {#each getFilteredModels() as model}
            <OptionInput value={model.model_id}>
              {getModelDisplayName(model)}
            </OptionInput>
          {/each}
        {:else if wavespeedImageDraft.value.model}
          <OptionInput value={wavespeedImageDraft.value.model}>
            {wavespeedImageDraft.value.model}
          </OptionInput>
        {/if}
      </SelectInput>

      <span class="text-textcolor mt-4">LoRAs</span>
      {#if wavespeedModels.find((m) => m.model_id === wavespeedImageDraft.value.model)?.supportsLoras}
        {#each wavespeedLoras as lora, index}
          {@const loraScaleLabel = language.loraScaleLabel(index + 1)}
          <TextInput
            size="sm"
            marginBottom
            marginTop
            placeholder={`LoRA ${index + 1} URL (optional)`}
            bind:value={lora.path} />
          <span class="text-textcolor">{loraScaleLabel}</span>
          <SliderInput
            marginBottom
            min={0}
            max={4}
            step={0.1}
            fixed={1}
            bind:value={lora.scale}
            ariaLabel={loraScaleLabel} />
        {/each}
        <span class="text-textcolor2 text-xs mb-2 block">
          Only .safetensors files are supported. Use owner/model-name (Hugging Face) or direct URL (Civitai).
        </span>
      {:else}
        <span class="text-textcolor2 text-xs mb-2 block">
          Model does not support LoRA. Or refresh model list to update model status.
        </span>
      {/if}

      <span class="text-textcolor">Image Reference</span>
      {#if wavespeedModels.find((m) => m.model_id === wavespeedImageDraft.value.model)?.supportsImageInput}
        <SelectInput className="mb-4" bind:value={wavespeedImageDraft.value.reference_mode}>
          <OptionInput value="">None</OptionInput>
          <OptionInput value="image">Upload Image</OptionInput>
          <OptionInput value="character">Use Character Image</OptionInput>
        </SelectInput>

        {#if wavespeedImageDraft.value.reference_mode === 'image'}
          <div class="relative">
            <button class="mb-2" onclick={uploadWavespeedReferenceImage}>
              {#if !wavespeedImageDraft.value.reference_image || wavespeedImageDraft.value.reference_image === ''}
                <div
                  class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                  <span class="text-sm">Upload<br />Image</span>
                </div>
              {:else}
                {#await getCharImage(wavespeedImageDraft.value.reference_image, 'plain')}
                  <div
                    class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center">
                    <span class="text-sm">Uploading<br />Image..</span>
                  </div>
                {:then im}
                  <img
                    src={im}
                    class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                    alt="Base Preview" />
                {/await}
              {/if}
            </button>

            {#if wavespeedImageDraft.value.reference_image && wavespeedImageDraft.value.reference_image !== ''}
              <button
                onclick={() => {
                  if (!confirmSettingsItemRemoval()) return
                  wavespeedImageDraft.value.reference_image = undefined
                  wavespeedImageDraft.value.reference_base64image = undefined
                }}
                class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm">
                Delete
              </button>
            {/if}
          </div>
        {/if}
        {#if wavespeedImageDraft.value.reference_mode === 'character'}
          <span class="text-textcolor2 text-xs mb-2 block">Use the character's default image.</span>
        {/if}
      {:else}
        <span class="text-textcolor2 text-xs mb-2 block">
          Model does not support image input. Or refresh model list to update model status.
        </span>
      {/if}
    {/if}
  </Accordion>
{/if}

{#if submenu === 1 || submenu === -1}
  <Accordion name="TTS" styled disabled={submenu !== -1}>
    <span class="text-textcolor mt-2">Auto Speech</span>
    <CheckInput bind:check={ttsAutoSpeechDraft.value} />

    <span class="text-textcolor mt-2">ElevenLabs API key</span>
    <SecretInput ownerKey="elevenLabKey" size="sm" marginBottom bind:value={elevenLabKeyDraft.value} />

    <span class="text-textcolor mt-2">VOICEVOX URL</span>
    <TextInput size="sm" marginBottom bind:value={voicevoxUrlDraft.value} />

    <span class="text-textcolor">OpenAI Key</span>
    <SecretInput ownerKey="openAIKey" size="sm" marginBottom bind:value={openAIKeyDraft.value} />

    <span class="text-textcolor mt-2">NovelAI API key</span>
    <SecretInput ownerKey="NAIApiKey" size="sm" marginBottom placeholder="pst-..." bind:value={NAIApiKeyDraft.value} />

    <span class="text-textcolor">Huggingface Key</span>
    <SecretInput
      ownerKey="huggingfaceKey"
      size="sm"
      marginBottom
      bind:value={huggingfaceKeyDraft.value}
      placeholder="hf_..." />

    <span class="text-textcolor">fish-speech API Key</span>
    <SecretInput ownerKey="fishSpeechKey" size="sm" marginBottom bind:value={fishSpeechKeyDraft.value} />
  </Accordion>
{/if}

{#if submenu === 2 || submenu === -1}
  <Accordion name={language.emotionImage} styled disabled={submenu !== -1}>
    <SettingRenderer items={memoryEmotionSettingsItems} />
    <span class="text-textcolor mt-2">{language.emotionMethod}</span>

    <SelectInput className="mt-2 mb-4" bind:value={emotionProcesserDraft.value}>
      <OptionInput value="submodel">Ax. Model</OptionInput>
      <OptionInput value="embedding">MiniLM-L6-v2</OptionInput>
    </SelectInput>
  </Accordion>
{/if}

{#if submenu === 0 || submenu === -1}
  <Accordion name={language.longTermMemory} styled disabled={submenu !== -1}>
    <SettingRenderer items={memoryLongTermSettingsItems} />
    <div class="flex mb-4">
      <Check bind:check={hypaV3Draft.value} name="{language.HypaMemory} V3" />
    </div>

    {#if hypaV3Draft.value}
      <span class="max-w-full mb-6 text-sm text-wrap wrap-break-word text-textcolor2"
        >{language.hypaV3Settings.descriptionLabel}</span>
      <span class="text-textcolor">Preset</span>
      <select
        aria-label={`${language.HypaMemory} V3 ${language.presets}`}
        class={'border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200 text-md px-4 py-2 mb-1'}
        bind:value={selectedHypaV3PresetIdDraft.value}>
        {#each hypaV3PresetsDraft.value as preset}
          <option class="bg-darkbg appearance-none" value={preset.id}>{preset.name}</option>
        {/each}
      </select>

      <div class="flex items-center mb-8">
        <button
          type="button"
          aria-label={`${language.add}: ${language.presets}`}
          class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
          onclick={() => {
            const newPreset = createHypaV3Preset()
            const presets = [...hypaV3PresetsDraft.value]

            presets.push(newPreset)
            if (!applyHypaV3PresetOwnerPatch(presets, newPreset.id)) {
              alertError('Unable to update the Hypa V3 preset owner.')
            }
          }}>
          <PlusIcon size={24} />
        </button>

        <button
          type="button"
          aria-label={`${language.edit}: ${hypaV3PresetsDraft.value[selectedHypaV3PresetIndex()]?.name ?? language.presets}`}
          class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
          onclick={async () => {
            const target = captureHypaV3PresetTarget()

            if (!target) {
              alertError('There must be least one preset.')
              return
            }

            const newName = await alertInput(`Enter new name for ${target.preset.name}`, [], target.preset.name)

            if (!newName || newName.trim().length === 0) return
            if (!stillOwnsHypaV3PresetTarget(target)) return

            const presets = [...hypaV3PresetsDraft.value]
            presets[target.selection] = { ...target.preset, name: newName }
            if (!applyHypaV3PresetOwnerPatch(presets, target.presetId)) {
              alertError('Unable to update the Hypa V3 preset owner.')
            }
          }}>
          <PencilIcon size={24} />
        </button>

        <button
          type="button"
          aria-label={`${language.remove}: ${hypaV3PresetsDraft.value[selectedHypaV3PresetIndex()]?.name ?? language.presets}`}
          class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
          onclick={async () => {
            const target = captureHypaV3PresetTarget()

            if (hypaV3PresetsDraft.value.length <= 1 || !target) {
              alertError('There must be least one preset.')
              return
            }

            const confirmed = await alertConfirm(`${language.removeConfirm}${target.preset.name}`)

            if (!confirmed) return
            if (!stillOwnsHypaV3PresetTarget(target)) return

            const presets = [...hypaV3PresetsDraft.value]
            presets.splice(target.selection, 1)
            if (!applyHypaV3PresetOwnerPatch(presets, presets[0]?.id ?? null)) {
              alertError('Unable to update the Hypa V3 preset owner.')
            }
          }}>
          <TrashIcon size={24} />
        </button>

        <div class="ml-2 mr-4 w-px h-full bg-darkborderc"></div>

        <button
          type="button"
          aria-label={`${language.export}: ${hypaV3PresetsDraft.value[selectedHypaV3PresetIndex()]?.name ?? language.presets}`}
          class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
          onclick={async () => {
            try {
              const presets = hypaV3PresetsDraft.value

              if (presets.length === 0) {
                alertError('There must be least one preset.')
                return
              }

              const preset = presets[selectedHypaV3PresetIndex()]
              if (!preset) {
                alertError('There must be least one preset.')
                return
              }
              const bytesExport = Buffer.from(
                JSON.stringify({
                  type: 'risu',
                  ver: 1,
                  data: preset,
                }),
                'utf-8',
              )

              await downloadFile(`hypaV3_export_${preset.name}.json`, bytesExport)
              alertNormal(language.successExport)
            } catch (error) {
              alertError(`${error}`)
            }
          }}>
          <DownloadIcon size={24} />
        </button>

        <button
          type="button"
          aria-label={`${language.import}: ${language.presets}`}
          disabled={hypaPresetImportPending}
          class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
          onclick={importHypaV3Preset}>
          <HardDriveUploadIcon size={24} />
        </button>
      </div>

      {#if hypaV3PresetsDraft.value?.[selectedHypaV3PresetIndex()]?.settings}
        {@const settings = hypaV3PresetsDraft.value[selectedHypaV3PresetIndex()].settings}

        <span class="text-textcolor">{language.SuperMemory} {language.model}</span>
        <SelectInput
          className="mb-4"
          ariaLabel={`${language.SuperMemory} ${language.model}`}
          bind:value={settings.summarizationModel}>
          <OptionInput value="subModel">{language.submodel}</OptionInput>
          <OptionInput value="memory">{language.modelRoles.roles.memory}</OptionInput>
        </SelectInput>
        <span class="text-textcolor">{language.summarizationPrompt} <Help key="summarizationPrompt" /></span>
        <div class="mb-4">
          <TextAreaInput
            size="sm"
            placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}
            bind:value={settings.summarizationPrompt} />
        </div>
        <span class="text-textcolor">{language.reSummarizationPrompt} <Help key="reSummarizationPrompt" /></span>
        <div class="mb-4">
          <TextAreaInput
            size="sm"
            placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}
            bind:value={settings.reSummarizationPrompt} />
        </div>
        {#await getMaxMemoryRatio(maxMemoryRatioDependencyKey()) then maxMemoryRatio}
          <span class="text-textcolor">{language.hypaV3Settings.maxMemoryTokensRatioLabel}</span>
          <NumberInput
            marginBottom
            disabled
            size="sm"
            value={maxMemoryRatio}
            ariaLabel={language.hypaV3Settings.maxMemoryTokensRatioLabel} />
        {:catch error}
          <span class="mb-4 text-red-400">{language.hypaV3Settings.maxMemoryTokensRatioError}</span>
        {/await}
        <span class="text-textcolor"
          >{language.hypaV3Settings.memoryTokensRatioLabel}
          <Help key="hypaV3MemoryTokensRatio" /></span>
        <SliderInput
          marginBottom
          min={0}
          max={1}
          step={0.01}
          fixed={2}
          bind:value={settings.memoryTokensRatio}
          ariaLabel={language.hypaV3Settings.memoryTokensRatioLabel} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.extraSummarizationRatioLabel}
          <Help key="hypaV3ExtraSummarizationRatio" /></span>
        <SliderInput
          marginBottom
          min={0}
          max={1 - settings.memoryTokensRatio}
          step={0.01}
          fixed={2}
          bind:value={settings.extraSummarizationRatio}
          ariaLabel={language.hypaV3Settings.extraSummarizationRatioLabel} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.maxChatsPerSummaryLabel}
          <Help key="hypaV3MaxChatsPerSummary" /></span>
        <NumberInput marginBottom size="sm" min={1} bind:value={settings.maxChatsPerSummary} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.queryChatCountLabel} <Help key="hypaV3QueryChatCount" /></span>
        <NumberInput marginBottom size="sm" min={1} max={20} bind:value={settings.queryChatCount} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.summaryChunkSeparatorLabel}
          <Help key="hypaV3SummaryChunkSeparator" /></span>
        <TextInput marginBottom size="sm" bind:value={settings.summaryChunkSeparator} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.recentMemoryRatioLabel}
          <Help key="hypaV3RecentMemoryRatio" /></span>
        <SliderInput
          marginBottom
          min={0}
          max={1}
          step={0.01}
          fixed={2}
          bind:value={settings.recentMemoryRatio}
          ariaLabel={language.hypaV3Settings.recentMemoryRatioLabel} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.similarMemoryRatioLabel}
          <Help key="hypaV3SimilarMemoryRatio" /></span>
        <SliderInput
          marginBottom
          min={0}
          max={1}
          step={0.01}
          fixed={2}
          bind:value={settings.similarMemoryRatio}
          ariaLabel={language.hypaV3Settings.similarMemoryRatioLabel} />
        <span class="text-textcolor"
          >{language.hypaV3Settings.randomMemoryRatioLabel}
          <Help key="hypaV3RandomMemoryRatio" /></span>
        <NumberInput
          marginBottom
          disabled
          size="sm"
          value={parseFloat((1 - settings.recentMemoryRatio - settings.similarMemoryRatio).toFixed(2))} />
        <div class="mb-2 flex items-center">
          <Check
            name={language.hypaV3Settings.preserveOrphanedMemoryLabel}
            bind:check={settings.preserveOrphanedMemory} />
          <Help key="hypaV3PreserveOrphanedMemory" />
        </div>
        <div class="mb-2 flex items-center">
          <Check
            name={language.hypaV3Settings.applyRegexScriptWhenRerollingLabel}
            bind:check={settings.processRegexScript} />
          <Help key="hypaV3ProcessRegexScript" />
        </div>
        <div class="mb-2 flex items-center">
          <Check
            name={language.hypaV3Settings.doNotSummarizeUserMessageLabel}
            bind:check={settings.doNotSummarizeUserMessage} />
          <Help key="hypaV3DoNotSummarizeUserMessage" />
        </div>
        <Accordion name="Advanced Settings" styled>
          <div class="mb-2 flex items-center">
            <Check name="Use Experimental Implementation" bind:check={settings.useExperimentalImpl} />
            <Help key="hypaV3UseExperimentalImpl" />
          </div>
          <div class="mb-2 flex items-center">
            <Check name="Always Toggle On" bind:check={settings.alwaysToggleOn} />
            <Help key="hypaV3AlwaysToggleOn" />
          </div>
          {#if settings.useExperimentalImpl}
            <span class="text-textcolor"
              >Summarization Requests Per Minute <Help key="hypaV3SummarizationRequestsPerMinute" /></span>
            <NumberInput marginBottom size="sm" min={1} bind:value={settings.summarizationRequestsPerMinute} />
            <span class="text-textcolor"
              >Summarization Max Concurrent <Help key="hypaV3SummarizationMaxConcurrent" /></span>
            <NumberInput marginBottom size="sm" min={1} max={10} bind:value={settings.summarizationMaxConcurrent} />
            <span class="text-textcolor"
              >Embedding Requests Per Minute <Help key="hypaV3EmbeddingRequestsPerMinute" /></span>
            <NumberInput marginBottom size="sm" min={1} bind:value={settings.embeddingRequestsPerMinute} />
            <span class="text-textcolor">Embedding Max Concurrent <Help key="hypaV3EmbeddingMaxConcurrent" /></span>
            <NumberInput marginBottom size="sm" min={1} max={10} bind:value={settings.embeddingMaxConcurrent} />
          {:else}
            <div class="mb-2 flex items-center">
              <Check
                name={language.hypaV3Settings.enableSimilarityCorrectionLabel}
                bind:check={settings.enableSimilarityCorrection} />
              <Help key="hypaV3EnableSimilarityCorrection" />
            </div>
          {/if}
        </Accordion>
      {/if}

      <div class="mb-8"></div>
    {/if}

    <span class="text-textcolor">{language.embedding} <Help key="embedding" /></span>
    <SelectInput className="mb-4" bind:value={hypaModelDraft.value}>
      {#if 'gpu' in navigator}
        <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
        <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
        <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
        <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
        <OptionInput value="multiMiniLMGPU">Multilingual MiniLM L12 v2 (GPU)</OptionInput>
        <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
      {/if}
      <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
      <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
      <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
      <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
      <OptionInput value="multiMiniLM">Multilingual MiniLM L12 v2 (CPU)</OptionInput>
      <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
      <OptionInput value="openai3small">OpenAI text-embedding-3-small</OptionInput>
      <OptionInput value="openai3large">OpenAI text-embedding-3-large</OptionInput>
      <OptionInput value="ada">OpenAI Ada</OptionInput>
      <OptionInput value="voyageContext4">{language.voyageContext4}</OptionInput>
      <OptionInput value="voyageContext3">Voyage Context 3</OptionInput>
      <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
    </SelectInput>

    {#if hypaModelDraft.value === 'openai3small' || hypaModelDraft.value === 'openai3large' || hypaModelDraft.value === 'ada'}
      <span class="text-textcolor">OpenAI API Key</span>
      <SecretInput ownerKey="hypaV3Key" size="sm" marginBottom bind:value={hypaV3KeyDraft.value} />
    {/if}

    {#if hypaModelDraft.value === 'custom'}
      <span class="text-textcolor">URL</span>
      <TextInput size="sm" marginBottom bind:value={hypaCustomSettingsDraft.value.url} />
      <span class="text-textcolor">Key/Password</span>
      <SecretInput
        ownerKey="hypaCustomSettings.key"
        size="sm"
        marginBottom
        bind:value={hypaCustomSettingsDraft.value.key} />
      <span class="text-textcolor">Request Model</span>
      <TextInput size="sm" marginBottom bind:value={hypaCustomSettingsDraft.value.model} />
    {/if}

    {#if hypaModelDraft.value === 'voyageContext3' || hypaModelDraft.value === 'voyageContext4'}
      <span class="text-textcolor">Voyage API Key</span>
      <SecretInput ownerKey="voyageApiKey" size="sm" marginBottom bind:value={voyageApiKeyDraft.value} />
    {/if}
  </Accordion>
{/if}
