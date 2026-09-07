<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { writerDraftValueFields } from 'src/ts/server/writerDraftFields'
  import { language } from '../../lang'
  import { tokenizeAccurate } from '../../ts/tokenizer'
  import {
    saveImage as saveAsset,
    isServerCharacterShell,
    type character,
    type customscript,
    type Database,
    type triggerscript,
  } from '../../ts/storage/database.svelte'
  import { onDestroy, onMount, untrack } from 'svelte'
  import { CharConfigSubMenu, MobileGUI, selectedCharID, hypaV3ModalOpen, SizeStore } from '../../ts/stores.svelte'
  import {
    PlusIcon,
    SmileIcon,
    TrashIcon,
    UserIcon,
    ActivityIcon,
    BookIcon,
    User,
    Braces,
    Volume2Icon,
    DownloadIcon,
    HardDriveUploadIcon,
    Share2Icon,
    ImageIcon,
    ImageOffIcon,
    ArrowUp,
    ArrowDown,
  } from '@lucide/svelte'
  import Check from '../UI/GUI/CheckInput.svelte'
  import { addingEmotion, getCharImage, removeChar, selectCharacterAvatarImage } from '../../ts/characters'
  import LoreBook from './LoreBook/LoreBookSetting.svelte'
  import BarIcon from './BarIcon.svelte'
  import { selectMultipleFile, selectSingleFile } from '../../ts/filePicker'
  import Help from '../Others/Help.svelte'
  import { exportChar } from 'src/ts/characterCards'
  import {
    getElevenTTSVoices,
    getFishSpeechModels as loadFishSpeechModels,
    getWebSpeechTTSVoices,
    getVOICEVOXVoices,
    oaiVoices,
    getNovelAIVoices,
  } from 'src/ts/process/tts'
  import { getFileSrc } from 'src/ts/globalApi.svelte'
  import TextInput from '../UI/GUI/TextInput.svelte'
  import SecretInput from '../UI/GUI/SecretInput.svelte'
  import NumberInput from '../UI/GUI/NumberInput.svelte'
  import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'
  import Button from '../UI/GUI/Button.svelte'
  import SelectInput from '../UI/GUI/SelectInput.svelte'
  import OptionInput from '../UI/GUI/OptionInput.svelte'
  import RegexList from './Scripts/RegexList.svelte'
  import TriggerList from './Scripts/TriggerList.svelte'
  import CheckInput from '../UI/GUI/CheckInput.svelte'
  import { updateInlayScreen } from 'src/ts/process/inlayScreen'
  import { registerOnnxModelFromFile } from 'src/ts/process/transformers'
  import MultiLangInput from '../UI/GUI/MultiLangInput.svelte'
  import { applyModule } from 'src/ts/process/modules'
  import { exportRegex, importRegexRows } from 'src/ts/process/scripts'
  import SliderInput from '../UI/GUI/SliderInput.svelte'
  import { createCharacterOwnerDraft, flushPendingCharacterDraftPatches } from 'src/ts/server/characterDraft.svelte'
  import {
    appendFreshCharacterAdditionalAssets,
    beginCharacterAdditionalAssetUpload,
    captureCharacterAdditionalAssetUploadTarget,
    clearCharacterAdditionalAssetUpload,
    isFreshCharacterAdditionalAssetUpload,
    type CharacterAdditionalAssetEntry,
    type CharacterAdditionalAssetUploadOperation,
  } from 'src/ts/server/characterAdditionalAssetUpload'
  import {
    appendFreshCharacterEmotionImages,
    beginCharacterEmotionUpload,
    captureCharacterEmotionUploadTarget,
    clearCharacterEmotionUpload,
    isFreshCharacterEmotionUpload,
    type CharacterEmotionImageEntry,
    type CharacterEmotionUploadOperation,
  } from 'src/ts/server/characterEmotionUpload'
  import {
    applyFreshCharacterGptSoVitsReferenceAudioUpload,
    applyFreshCharacterVitsModelRegistration,
    beginCharacterTtsAssetUpload,
    captureCharacterTtsAssetUploadTarget,
    clearCharacterTtsAssetUpload,
    isFreshCharacterTtsAssetUpload,
    type CharacterTtsAssetUploadKind,
    type CharacterTtsAssetUploadOperation,
  } from 'src/ts/server/characterTtsAssetUpload'
  import {
    applyFreshCharacterNotificationImageUpload,
    beginCharacterNotificationImageUpload,
    captureCharacterNotificationImageUploadTarget,
    clearCharacterNotificationImageUpload,
    invalidateCharacterNotificationImageUpload,
    isFreshCharacterNotificationImageUpload,
    type CharacterNotificationImageUploadOperation,
  } from 'src/ts/server/characterNotificationImageUpload'
  import {
    clearDirtyScriptDefinitionFieldsMatchingAttempt,
    flushPendingCharacterScriptDefinitionDraft,
    markDirtyScriptDefinitionRowFields,
    mergeScriptDefinitionProjectionRows,
    scheduleCharacterScriptDefinitionDraft,
    waitForPendingCharacterScriptDefinitionSave,
  } from 'src/ts/server/scriptDefinitionOwner.svelte'
  import { canUseServerCommands, subscribeServerCommandLocalEffectApplied } from 'src/ts/server/commands'
  import { getCharacterDisplayName } from 'src/ts/characterDisplayName'
  import { applyCharacterRowMutationScoped } from 'src/ts/characterCommands'
  import {
    applyChatMetadataOwnerPatch,
    captureCharacterRowProjectionEpoch,
    charactersResourceState,
    getCharacterResourceOwner,
    getChatMetadataOwnerSnapshot,
    hasCharacterRowProjectionEpochChanged,
    markCharacterResourceOwnerChanged,
    restoreChatMetadataOwnerSnapshot,
    settingsResourceState,
    type ChatMetadataOwnerFields,
  } from 'src/ts/server/resourceState.svelte'
  import type { SettingsGroup } from 'src/ts/server/settingsGroups'
  import { assetListRenderKey } from 'src/ts/media/assetList'
  import { mutateAlternateGreetings, type AlternateGreetingMutation } from 'src/ts/alternateGreetingMutation'
  import { dispatchDurableAlternateGreetingMutation } from 'src/ts/alternateGreetingCommands'
  import { alertError, alertNormal } from 'src/ts/alert'
  import ScriptModelOverrideSelectors from 'src/lib/UI/ScriptModelOverrideSelectors.svelte'

  let iconRemoveMode = $state(false)
  let viewSubMenu = $state(0)
  let webSpeechSupported = $state(false)
  let webSpeechVoices = $state<string[]>([])
  let alternateGreetingMutationPending = $state(false)
  let alternateGreetingMutationStatus = $state<'idle' | 'queued' | 'failed'>('idle')
  let alternateGreetingMutationAttempt = 0
  let characterRemovalPending = $state(false)
  let characterRemovalStatus = $state<'idle' | 'queued' | 'failed'>('idle')
  let characterRemovalName = $state('')
  let iconButtonSize = $derived($SizeStore.w > 360 ? (24 as const) : (20 as const))
  const CHARACTER_ADDITIONAL_ASSET_EXTENSIONS = [
    'png',
    'webp',
    'mp4',
    'mp3',
    'gif',
    'jpeg',
    'jpg',
    'ttf',
    'otf',
    'css',
    'webm',
    'woff',
    'woff2',
    'svg',
    'avif',
  ]
  const NOTIFICATION_IMAGE_EXTENSIONS = ['png', 'webp', 'gif', 'jpg', 'jpeg']
  type SelectedSingleFile = NonNullable<Awaited<ReturnType<typeof selectSingleFile>>>
  type SelectedAdditionalAssetFile = NonNullable<Awaited<ReturnType<typeof selectMultipleFile>>>[number]

  function readEditorSettingsGroup(group: SettingsGroup): Partial<Database> {
    const status = settingsResourceState.groupStatuses[group] ?? 'idle'
    if (status === 'ready') return settingsResourceState.value as Partial<Database>
    return {}
  }

  let displaySettings = $derived(readEditorSettingsGroup('display'))
  let mediaSettings = $derived(readEditorSettingsGroup('media'))
  let advancedSettings = $derived(readEditorSettingsGroup('advanced'))
  let memorySettings = $derived(readEditorSettingsGroup('memory'))
  let useAdditionalAssetsPreview = $derived(displaySettings.useAdditionalAssetsPreview === true)
  let newImageHandlingBeta = $derived(mediaSettings.newImageHandlingBeta === true)
  let showUnrecommended = $derived(advancedSettings.showUnrecommended === true)
  let hypaV3Enabled = $derived(memorySettings.hypaV3 === true)

  let tokens = $state({
    desc: 0,
    firstMsg: 0,
  })
  const characterDraft = createCharacterOwnerDraft([
    'name',
    'displayName',
    'desc',
    'firstMessage',
    'customNotificationMessage',
    'notificationImage',
    'image',
    'ccAssets',
    'extentions',
    'largePortrait',
    'viewScreen',
    'emotionImages',
    'inlayViewScreen',
    'newGenData',
    'additionalAssets',
    'prebuiltAssetCommand',
    'prebuiltAssetStyle',
    'prebuiltAssetExclude',
    'lowLevelAccess',
    'scriptModelOverrides',
    'hideChatIcon',
    'utilityBot',
    'escapeOutput',
    'backgroundHTML',
    'virtualscript',
    'ttsMode',
    'ttsSpeech',
    'voicevoxConfig',
    'naittsConfig',
    'oaiVoice',
    'oaiTTSConfig',
    'hfTTS',
    'vits',
    'gptSoVitsConfig',
    'fishSpeechConfig',
    'ttsReadOnlyQuoted',
    'bias',
    'exampleMessage',
    'creatorNotes',
    'systemPrompt',
    'replaceGlobalNote',
    'additionalText',
    'personality',
    'scenario',
    'defaultVariables',
    'translatorNote',
    'additionalData',
    'nickname',
    'depth_prompt',
    'alternateGreetings',
    'removedQuotes',
  ])

  async function removeCurrentCharacter(): Promise<void> {
    if (characterRemovalPending) return
    const characterIndex = $selectedCharID
    const character = characterOwnerAt(characterIndex)
    if (!character) return
    const characterName = getCharacterDisplayName(character)
    characterRemovalName = characterName
    characterRemovalPending = true
    characterRemovalStatus = 'idle'
    try {
      const outcome = await removeChar(characterIndex, characterName)
      if (!outcome || outcome.status === 'accepted') return
      characterRemovalStatus = outcome.status
      if (outcome.status === 'queued') alertNormal(language.characterRemovalQueued(characterName))
      else alertError(language.characterRemovalFailed(characterName))
    } catch {
      characterRemovalStatus = 'failed'
      alertError(language.characterRemovalFailed(characterName))
    } finally {
      characterRemovalPending = false
    }
  }
  const unregisterCharacterRecovery = registerWriterDraftCapture(() => {
    const recovery = characterDraft.captureRecoveryDraft()
    if (!recovery) return null
    return {
      key: `character:${recovery.characterId}`,
      label: selectedCharacterOwner() ? getCharacterDisplayName(selectedCharacterOwner()!) : recovery.characterId,
      fields: writerDraftValueFields(recovery.value, recovery.baseline, {
        name: language.name,
        displayName: language.displayName,
        desc: language.description,
        firstMessage: language.firstMessage,
        systemPrompt: language.systemPrompt,
        creatorNotes: language.creatorNotes,
        personality: language.personality,
        scenario: language.scenario,
      }),
      data: recovery.value,
      baseline: recovery.baseline,
    }
  })
  onDestroy(unregisterCharacterRecovery)

  let characterScriptsDraft = $state<customscript[]>([])
  let characterTriggersDraft = $state<triggerscript[]>([])
  let scriptDraftCharacterId = $state<string | null>(null)
  let scriptDraftSnapshot = ''
  let scriptRecoveryBaseline: { scripts: customscript[]; triggers: triggerscript[] } = { scripts: [], triggers: [] }
  let previousScriptDraftOwnerId: string | null = null
  let previousScriptDraftOwnerProjectionEpoch: number | null = null
  let suppressScriptDraftDispatch = false
  let scriptDraftCompositionActive = $state(false)
  let previousCharacterConfigSubMenu = $CharConfigSubMenu
  const scriptDirtyFieldsById = new Map<string, Set<string>>()
  const triggerDirtyFieldsById = new Map<string, Set<string>>()

  async function prepareCharacterRegexDisplayActivation(ownerKey: string): Promise<boolean> {
    const outcome = await waitForPendingCharacterScriptDefinitionSave(ownerKey, { finalSettlement: true })
    return outcome === 'idle' || outcome === 'saved'
  }

  function flushCurrentCharacterScriptDefinitionDraft(): void {
    if (scriptDraftCharacterId) flushPendingCharacterScriptDefinitionDraft(scriptDraftCharacterId)
  }

  const unregisterScriptRecovery = registerWriterDraftCapture(() => {
    if (!scriptDraftCharacterId) return null
    const data = $state.snapshot({ scripts: characterScriptsDraft, triggers: characterTriggersDraft })
    const fields = writerDraftValueFields(data, scriptRecoveryBaseline, {
      scripts: language.regexScript,
      triggers: language.trigger,
    })
    if (fields.length === 0) return null
    return {
      key: `character-scripts:${scriptDraftCharacterId}`,
      label: `${selectedCharacterOwner() ? getCharacterDisplayName(selectedCharacterOwner()!) : scriptDraftCharacterId}: ${language.scripts}`,
      fields,
      data,
      baseline: scriptRecoveryBaseline,
    }
  })
  onDestroy(unregisterScriptRecovery)
  onDestroy(flushCurrentCharacterScriptDefinitionDraft)

  function voicevoxStyles(value: unknown): Array<{ id: string | number; name: string }> {
    if (typeof value !== 'string' || value.length === 0) return []
    try {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (style): style is { id: string | number; name: string } =>
          !!style &&
          typeof style === 'object' &&
          (typeof style.id === 'string' || typeof style.id === 'number') &&
          typeof style.name === 'string',
      )
    } catch {
      return []
    }
  }

  onMount(() => {
    const synthesis = typeof speechSynthesis === 'undefined' ? null : speechSynthesis
    if (!synthesis) {
      webSpeechSupported = false
      webSpeechVoices = []
      return
    }

    const refreshVoices = () => {
      webSpeechVoices = getWebSpeechTTSVoices(synthesis)
    }

    webSpeechSupported = true
    synthesis.addEventListener('voiceschanged', refreshVoices)
    refreshVoices()

    return () => {
      synthesis.removeEventListener('voiceschanged', refreshVoices)
    }
  })

  $effect(() =>
    subscribeServerCommandLocalEffectApplied((_event, localEffect) => {
      if (localEffect.kind !== 'characterDefinitionMutation' || localEffect.characterId !== scriptDraftCharacterId) {
        return
      }

      if (localEffect.operation === 'scripts') {
        scriptRecoveryBaseline.scripts = cloneJsonValue(localEffect.definitions as customscript[])
        clearDirtyScriptDefinitionFieldsMatchingAttempt(
          scriptDirtyFieldsById,
          characterScriptsDraft,
          localEffect.definitions as customscript[],
        )
      } else {
        scriptRecoveryBaseline.triggers = cloneJsonValue(localEffect.definitions as triggerscript[])
        clearDirtyScriptDefinitionFieldsMatchingAttempt(
          triggerDirtyFieldsById,
          characterTriggersDraft,
          localEffect.definitions as triggerscript[],
        )
      }
    }),
  )

  $effect(() => {
    const character = selectedCharacterOwner()
    const characterId = character?.chaId ?? null
    const ownerProjectionEpoch = characterId ? captureCharacterRowProjectionEpoch(characterId) : null
    const targetChanged = characterId !== scriptDraftCharacterId
    const ownerProjectionChanged =
      !targetChanged &&
      characterId === previousScriptDraftOwnerId &&
      ownerProjectionEpoch !== previousScriptDraftOwnerProjectionEpoch
    previousScriptDraftOwnerId = characterId
    previousScriptDraftOwnerProjectionEpoch = ownerProjectionEpoch
    const snapshot = snapshotJson({
      characterId,
      scripts: character?.customscript ?? [],
      triggers: character?.triggerscript ?? [],
    })

    if (targetChanged) {
      untrack(flushCurrentCharacterScriptDefinitionDraft)
      clearScriptDraftDirtyState()
    }

    if (targetChanged || ownerProjectionChanged) {
      scriptRecoveryBaseline = {
        scripts: cloneJsonValue(character?.customscript ?? []),
        triggers: cloneJsonValue(character?.triggerscript ?? []),
      }
    }
    if (targetChanged || snapshot !== scriptDraftSnapshot) {
      suppressScriptDraftDispatch = true
      scriptDraftCharacterId = characterId

      if (!targetChanged && ownerProjectionChanged && hasDirtyScriptDefinitionDraftFields()) {
        const nextScripts = reconcileScriptDefinitionDraftRows(
          characterScriptsDraft,
          character?.customscript ?? [],
          scriptDirtyFieldsById,
        )
        const nextTriggers = reconcileScriptDefinitionDraftRows(
          characterTriggersDraft,
          character?.triggerscript ?? [],
          triggerDirtyFieldsById,
        )

        if (nextScripts && nextTriggers) {
          characterScriptsDraft = nextScripts
          characterTriggersDraft = nextTriggers
          scriptDraftSnapshot = snapshotJson({
            characterId,
            scripts: characterScriptsDraft,
            triggers: characterTriggersDraft,
          })
        } else {
          clearScriptDraftDirtyState()
          characterScriptsDraft = cloneJsonValue(character?.customscript ?? [])
          characterTriggersDraft = cloneJsonValue(character?.triggerscript ?? [])
          scriptDraftSnapshot = snapshot
        }
      } else {
        if (!ownerProjectionChanged) {
          clearScriptDraftDirtyState()
        }
        characterScriptsDraft = cloneJsonValue(character?.customscript ?? [])
        characterTriggersDraft = cloneJsonValue(character?.triggerscript ?? [])
        scriptDraftSnapshot = snapshot
      }
      queueMicrotask(() => {
        suppressScriptDraftDispatch = false
      })
    }
  })

  $effect(() => {
    const characterId = scriptDraftCharacterId
    const compositionActive = scriptDraftCompositionActive
    const snapshot = snapshotJson({
      characterId,
      scripts: characterScriptsDraft,
      triggers: characterTriggersDraft,
    })

    if (compositionActive || suppressScriptDraftDispatch || !characterId || snapshot === scriptDraftSnapshot) return

    untrack(() => {
      if (scheduleCharacterScriptDefinitionDraft(characterId, characterScriptsDraft, characterTriggersDraft)) {
        const previousDraft = parseScriptDefinitionDraftSnapshot(scriptDraftSnapshot)
        markDirtyScriptDefinitionRowFields(scriptDirtyFieldsById, previousDraft.scripts, characterScriptsDraft)
        markDirtyScriptDefinitionRowFields(triggerDirtyFieldsById, previousDraft.triggers, characterTriggersDraft)
        scriptDraftSnapshot = snapshot
      }
    })
  })

  $effect(() => {
    const currentSubMenu = $CharConfigSubMenu
    if (previousCharacterConfigSubMenu === 4 && currentSubMenu !== 4) {
      untrack(flushCurrentCharacterScriptDefinitionDraft)
    }
    previousCharacterConfigSubMenu = currentSubMenu
  })

  let lasttokens = {
    desc: '',
    firstMsg: '',
  }
  let tokenizeRun = 0

  async function loadTokenize(desc: string | null, firstMsg: string | null, run: number) {
    if (desc !== null && lasttokens.desc !== desc) {
      const count = await tokenizeAccurate(desc)
      if (run !== tokenizeRun) return
      lasttokens.desc = desc
      tokens.desc = count
    }
    if (firstMsg !== null && lasttokens.firstMsg !== firstMsg) {
      const count = await tokenizeAccurate(firstMsg)
      if (run !== tokenizeRun) return
      lasttokens.firstMsg = firstMsg
      tokens.firstMsg = count
    }
  }

  function scheduleTokenize(desc: string | null, firstMsg: string | null) {
    const run = ++tokenizeRun
    setTimeout(() => {
      requestAnimationFrame(() => {
        if (run !== tokenizeRun) return
        void loadTokenize(desc, firstMsg, run)
      })
    }, 0)
  }

  let assetFileExtensions: Record<string, string | undefined> = $state({})
  let assetFilePath: Record<string, string | undefined> = $state({})
  let assetPreviewRun = 0
  let licensed = $state(currentEditableCharacterTarget()?.character.license ?? '')

  $effect.pre(() => {
    const chara = selectedCharacterOwner()
    const desc = chara?.desc ?? null
    const firstMsg = chara?.firstMessage ?? null

    untrack(() => {
      scheduleTokenize(desc, firstMsg)
    })
  })

  const selectedCharacterAssetSourceKey = $derived(
    currentRealCharacterDraftTarget() && useAdditionalAssetsPreview
      ? ((characterDraft.value as unknown as character).additionalAssets ?? [])
          .map((asset) => `${asset[1]}:${asset[2] ?? ''}`)
          .join('\n')
      : '',
  )

  $effect(() => {
    selectedCharacterAssetSourceKey
    const run = ++assetPreviewRun
    const nextExtensions: Record<string, string | undefined> = {}
    assetFilePath = {}
    if (currentRealCharacterDraftTarget() && useAdditionalAssetsPreview) {
      for (const asset of (characterDraft.value as unknown as character).additionalAssets ?? []) {
        const assetPath = asset[1]
        nextExtensions[assetPath] = asset.length > 2 && asset[2] ? asset[2] : assetPath.split('.').pop()
        getFileSrc(assetPath).then((filePath) => {
          if (run !== assetPreviewRun) return
          assetFilePath[assetPath] = filePath
        })
      }
    }
    assetFileExtensions = nextExtensions
  })

  $effect.pre(() => {
    licensed = currentEditableCharacterTarget()?.character.license ?? ''
  })
  $effect.pre(() => {
    if (characterDraft.value.ttsMode === 'novelai' && characterDraft.value.naittsConfig === undefined) {
      updateCharacterDraft((character) => {
        character.naittsConfig = {
          customvoice: false,
          voice: 'Aini',
          version: 'v2',
        }
      })
    }
  })
  $effect.pre(() => {
    if (characterDraft.value.ttsMode === 'gptsovits' && characterDraft.value.gptSoVitsConfig === undefined) {
      updateCharacterDraft((character) => {
        character.gptSoVitsConfig = {
          url: '',
          use_auto_path: false,
          ref_audio_path: '',
          use_long_audio: false,
          ref_audio_data: {
            fileName: '',
            assetId: '',
          },
          volume: 1.0,
          text_lang: 'auto',
          text: 'en',
          use_prompt: false,
          prompt_lang: 'en',
          top_p: 1,
          temperature: 0.7,
          speed: 1,
          top_k: 5,
          text_split_method: 'cut0',
        }
      })
    }
  })

  let fishSpeechModels: {
    _id: string
    title: string
    description: string
  }[] = $state([])

  $effect.pre(() => {
    if (characterDraft.value.ttsMode === 'fishspeech' && characterDraft.value.fishSpeechConfig === undefined) {
      updateCharacterDraft((character) => {
        character.fishSpeechConfig = {
          model: {
            _id: '',
            title: '',
            description: '',
          },
          chunk_length: 200,
          normalize: false,
        }
      })
    }
  })

  $effect.pre(() => {
    if (characterDraft.value.ttsMode === 'openai' && characterDraft.value.oaiTTSConfig === undefined) {
      updateCharacterDraft((character) => {
        character.oaiTTSConfig = {
          enabled: false,
          format: 'mp3',
        }
      })
    }
  })

  async function loadFishSpeechModelsIntoEditor() {
    fishSpeechModels = await loadFishSpeechModels()
  }

  function currentEditableCharacterTarget(): { selectedIndex: number; character: character } | null {
    const selectedIndex = $selectedCharID
    const selectedCharacter = selectedCharacterOwner()
    if (!selectedCharacter?.chaId) return null
    if (isServerCharacterShell(selectedCharacter)) return null
    if (selectedCharacter.type && selectedCharacter.type !== 'character') return null

    return { selectedIndex, character: selectedCharacter as character }
  }

  function stableOwnerId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }

  function characterOwnerAt(index: number): character | undefined {
    if (index < 0 || charactersResourceState.status !== 'ready') return undefined
    const candidate = charactersResourceState.characters[index]
    if (!stableOwnerId(candidate?.chaId)) return undefined
    if (charactersResourceState.rowStatuses[candidate.chaId] === 'error') return undefined
    return getCharacterResourceOwner(candidate.chaId) === candidate ? candidate : undefined
  }

  function selectedCharacterOwner(): character | undefined {
    const selectedIndex = $selectedCharID
    return characterOwnerAt(selectedIndex)
  }

  function currentRealCharacterDraftTarget(): { selectedIndex: number; character: character } | null {
    const target = currentEditableCharacterTarget()
    if (!target) return null
    const selectedCharacter = target.character
    if (characterDraft.characterId !== selectedCharacter.chaId) return null

    return target
  }

  async function importCharacterRegexScripts() {
    const ownerCharacterId = scriptDraftCharacterId
    if (!ownerCharacterId) return

    const importedRows = await importRegexRows()
    if (!importedRows || importedRows.length === 0) return

    const target = currentRealCharacterDraftTarget()
    if (!target || target.character.chaId !== ownerCharacterId || scriptDraftCharacterId !== ownerCharacterId) return
    characterScriptsDraft = [...characterScriptsDraft, ...importedRows]
  }

  function moveAlternateGreetingUp(index: number) {
    if (index === 0) return
    void applyAlternateGreetingMutation({ type: 'swap', firstIndex: index, secondIndex: index - 1 })
  }

  function moveAlternateGreetingDown(index: number) {
    if (index === characterDraft.value.alternateGreetings.length - 1) return
    void applyAlternateGreetingMutation({ type: 'swap', firstIndex: index, secondIndex: index + 1 })
  }

  interface AlternateGreetingChatOwnerSnapshot {
    chatId: string
    metadata: ChatMetadataOwnerFields
  }

  interface AlternateGreetingOwnerSnapshot {
    characterId: string
    selectedIndex: number
    character: character
    alternateGreetings: string[]
    chats: AlternateGreetingChatOwnerSnapshot[]
    projectionEpoch: number | null
    readyOwner: boolean
  }

  function captureAlternateGreetingOwnerSnapshot(): AlternateGreetingOwnerSnapshot | null {
    const target = currentRealCharacterDraftTarget()
    if (!target) return null
    const characterId = target.character.chaId

    if (charactersResourceState.status === 'ready') {
      if (getCharacterResourceOwner(characterId) !== target.character) return null
      const globalChatIdCounts = new Map<string, number>()
      for (const character of charactersResourceState.characters) {
        for (const chat of character.chats ?? []) {
          if (!stableOwnerId(chat?.id)) continue
          globalChatIdCounts.set(chat.id, (globalChatIdCounts.get(chat.id) ?? 0) + 1)
        }
      }

      const chats: AlternateGreetingChatOwnerSnapshot[] = []
      for (const chat of target.character.chats ?? []) {
        if (!stableOwnerId(chat?.id) || globalChatIdCounts.get(chat.id) !== 1) return null
        const owner = getChatMetadataOwnerSnapshot(characterId, chat.id)
        if (!owner) return null
        chats.push({ chatId: chat.id, metadata: cloneJsonValue(owner.metadata) })
      }
      return {
        characterId,
        selectedIndex: target.selectedIndex,
        character: target.character,
        alternateGreetings: cloneJsonValue(characterDraft.value.alternateGreetings),
        chats,
        projectionEpoch: captureCharacterRowProjectionEpoch(characterId),
        readyOwner: true,
      }
    }

    // Local-only startup compatibility cannot use the released chat owner yet.
    // Server-backed structural writes wait for the ready owner instead of
    // mutating the aggregate projection through a trusted component scope.
    if (
      canUseServerCommands() ||
      (charactersResourceState.status !== 'idle' && charactersResourceState.status !== 'loading')
    ) {
      return null
    }
    const chatIds = new Set<string>()
    const chats: AlternateGreetingChatOwnerSnapshot[] = []
    for (const chat of target.character.chats ?? []) {
      if (!stableOwnerId(chat?.id) || chatIds.has(chat.id)) return null
      chatIds.add(chat.id)
      chats.push({
        chatId: chat.id,
        metadata:
          Object.prototype.hasOwnProperty.call(chat, 'fmIndex') && chat.fmIndex !== undefined
            ? { fmIndex: cloneJsonValue(chat.fmIndex) }
            : {},
      })
    }
    return {
      characterId,
      selectedIndex: target.selectedIndex,
      character: target.character,
      alternateGreetings: cloneJsonValue(characterDraft.value.alternateGreetings),
      chats,
      projectionEpoch: null,
      readyOwner: false,
    }
  }

  function alternateGreetingOwnerSnapshotIsCurrent(snapshot: AlternateGreetingOwnerSnapshot): boolean {
    const currentTarget = currentRealCharacterDraftTarget()
    if (
      !currentTarget ||
      currentTarget.selectedIndex !== snapshot.selectedIndex ||
      currentTarget.character.chaId !== snapshot.characterId ||
      snapshotJson(characterDraft.value.alternateGreetings) !== snapshotJson(snapshot.alternateGreetings)
    ) {
      return false
    }

    if (snapshot.readyOwner) {
      if (
        charactersResourceState.status !== 'ready' ||
        getCharacterResourceOwner(snapshot.characterId) !== snapshot.character ||
        snapshot.projectionEpoch === null ||
        hasCharacterRowProjectionEpochChanged(snapshot.characterId, snapshot.projectionEpoch) ||
        snapshot.character.chats.length !== snapshot.chats.length
      ) {
        return false
      }
      const expectedChatIds = new Set(snapshot.chats.map((chat) => chat.chatId))
      if (expectedChatIds.size !== snapshot.chats.length) return false
      if (snapshot.character.chats.some((chat) => !stableOwnerId(chat?.id) || !expectedChatIds.has(chat.id)))
        return false

      return snapshot.chats.every((chat) => {
        const current = getChatMetadataOwnerSnapshot(snapshot.characterId, chat.chatId)
        return current && snapshotJson(current.metadata.fmIndex) === snapshotJson(chat.metadata.fmIndex)
      })
    }

    return currentTarget.character === snapshot.character
  }

  function applyAlternateGreetingOwnerProjection(
    snapshot: AlternateGreetingOwnerSnapshot,
    alternateGreetings: string[],
    chatGreetingIndices: Array<{ chatId: string; fmIndex: number }>,
  ): boolean {
    if (!alternateGreetingOwnerSnapshotIsCurrent(snapshot)) return false
    const nextByChatId = new Map(chatGreetingIndices.map((entry) => [entry.chatId, entry.fmIndex]))
    if (nextByChatId.size !== snapshot.chats.length || snapshot.chats.some((chat) => !nextByChatId.has(chat.chatId))) {
      return false
    }

    snapshot.character.alternateGreetings = cloneJsonValue(alternateGreetings)
    markCharacterResourceOwnerChanged(snapshot.characterId)
    if (snapshot.readyOwner) {
      for (const chat of snapshot.chats) {
        const fmIndex = nextByChatId.get(chat.chatId)
        if (fmIndex === undefined || !applyChatMetadataOwnerPatch(snapshot.characterId, chat.chatId, { fmIndex })) {
          return false
        }
      }
    } else {
      for (const chat of snapshot.character.chats) {
        const fmIndex = nextByChatId.get(chat.id)
        if (fmIndex !== undefined) chat.fmIndex = fmIndex
      }
    }
    return true
  }

  function rollbackAlternateGreetingOwnerProjection(
    snapshot: AlternateGreetingOwnerSnapshot,
    attemptedGreetings: string[],
    attemptedChatGreetingIndices: Array<{ chatId: string; fmIndex: number }>,
  ): void {
    const character = snapshot.readyOwner
      ? getCharacterResourceOwner(snapshot.characterId)
      : currentRealCharacterDraftTarget()?.character
    if (!character || character.chaId !== snapshot.characterId) return

    if (snapshotJson(character.alternateGreetings) === snapshotJson(attemptedGreetings)) {
      character.alternateGreetings = cloneJsonValue(snapshot.alternateGreetings)
      markCharacterResourceOwnerChanged(snapshot.characterId)
    }
    const attemptedByChatId = new Map(attemptedChatGreetingIndices.map((entry) => [entry.chatId, entry.fmIndex]))
    if (snapshot.readyOwner && charactersResourceState.status === 'ready') {
      for (const previous of snapshot.chats) {
        const attempted = attemptedByChatId.get(previous.chatId)
        if (attempted === undefined) continue
        restoreChatMetadataOwnerSnapshot({
          characterId: snapshot.characterId,
          chatId: previous.chatId,
          metadata: previous.metadata,
          attempted: { fmIndex: attempted },
        })
      }
    } else {
      for (const previous of snapshot.chats) {
        const chatMatches = character.chats.filter((candidate) => candidate.id === previous.chatId)
        const attempted = attemptedByChatId.get(previous.chatId)
        if (chatMatches.length !== 1 || attempted === undefined || chatMatches[0].fmIndex !== attempted) continue
        if (Object.prototype.hasOwnProperty.call(previous.metadata, 'fmIndex')) {
          chatMatches[0].fmIndex = previous.metadata.fmIndex as number
        } else {
          delete chatMatches[0].fmIndex
        }
      }
    }
  }

  async function applyAlternateGreetingMutation(operation: AlternateGreetingMutation): Promise<void> {
    if (alternateGreetingMutationPending) return
    const ownerSnapshot = captureAlternateGreetingOwnerSnapshot()
    if (!ownerSnapshot) return
    const characterId = ownerSnapshot.characterId
    const mutation = mutateAlternateGreetings(
      ownerSnapshot.alternateGreetings,
      ownerSnapshot.chats.map((chat) => ({ id: chat.chatId, fmIndex: chat.metadata.fmIndex as number | undefined })),
      operation,
    )
    if (!mutation) return

    const serverBacked = canUseServerCommands()
    if (serverBacked) {
      // Older debounced edits must enter the shared command queue first so this
      // collection-wide mutation remains the final atomic write.
      flushPendingCharacterDraftPatches()
    }

    const applyOptimistic = () => {
      if (
        !applyAlternateGreetingOwnerProjection(ownerSnapshot, mutation.alternateGreetings, mutation.chatGreetingIndices)
      ) {
        return
      }
    }
    const rollback = () => {
      const attemptedGreetings = snapshotJson(mutation.alternateGreetings)
      rollbackAlternateGreetingOwnerProjection(ownerSnapshot, mutation.alternateGreetings, mutation.chatGreetingIndices)
    }

    if (!serverBacked) {
      applyOptimistic()
      return
    }

    const attempt = ++alternateGreetingMutationAttempt
    alternateGreetingMutationPending = true
    alternateGreetingMutationStatus = 'idle'
    const result = await dispatchDurableAlternateGreetingMutation({
      characterId,
      alternateGreetings: mutation.alternateGreetings,
      operation,
      chatGreetingIndices: mutation.chatGreetingIndices,
      applyOptimistic,
      rollback,
      onFinalSettlement: (settlement) => {
        if (attempt !== alternateGreetingMutationAttempt) return
        alternateGreetingMutationStatus = settlement === 'accepted' ? 'idle' : 'failed'
      },
    })
    if (attempt === alternateGreetingMutationAttempt) {
      alternateGreetingMutationStatus = result === 'queued' ? 'queued' : result === 'failed' ? 'failed' : 'idle'
      alternateGreetingMutationPending = false
    }
  }

  function cloneJsonValue<T>(value: T): T {
    if (value === undefined) return value
    return JSON.parse(JSON.stringify(value)) as T
  }

  function snapshotJson(value: unknown): string {
    const snapshot = JSON.stringify(value)
    return snapshot === undefined ? '__undefined__' : snapshot
  }

  function hasDirtyScriptDefinitionDraftFields(): boolean {
    return scriptDirtyFieldsById.size > 0 || triggerDirtyFieldsById.size > 0
  }

  function clearScriptDraftDirtyState(): void {
    scriptDirtyFieldsById.clear()
    triggerDirtyFieldsById.clear()
  }

  function reconcileScriptDefinitionDraftRows<T extends customscript | triggerscript>(
    draftRows: T[],
    projectionRows: T[],
    dirtyFieldsById: Map<string, Set<string>>,
  ): T[] | null {
    if (dirtyFieldsById.size === 0) return cloneJsonValue(projectionRows ?? [])
    return mergeScriptDefinitionProjectionRows(draftRows ?? [], projectionRows ?? [], dirtyFieldsById)
  }

  function parseScriptDefinitionDraftSnapshot(snapshot: string): {
    scripts: customscript[]
    triggers: triggerscript[]
  } {
    if (!snapshot || snapshot === '__undefined__') {
      return { scripts: [], triggers: [] }
    }
    const parsed = JSON.parse(snapshot) as {
      scripts?: customscript[]
      triggers?: triggerscript[]
    }
    return {
      scripts: Array.isArray(parsed.scripts) ? parsed.scripts : [],
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers : [],
    }
  }

  function updateCharacterDraft(mutator: (character: character) => void): void {
    mutator(characterDraft.value as unknown as character)
    characterDraft.value = { ...characterDraft.value }
  }

  function characterDraftAvatarSnapshot(): string {
    const draft = characterDraft.value as unknown as character
    return snapshotJson({
      image: draft.image,
      ccAssets: draft.ccAssets,
      pngExif: draft.extentions?.pngExif,
    })
  }

  async function selectCharacterAvatarFromEditor(): Promise<void> {
    const target = currentRealCharacterDraftTarget()
    if (!target) return

    const characterId = target.character.chaId
    const characterIndex = target.selectedIndex
    const avatarSnapshot = characterDraftAvatarSnapshot()

    await selectCharacterAvatarImage(characterIndex, ({ image, pngExif }) => {
      const currentTarget = currentRealCharacterDraftTarget()
      if (
        currentTarget?.selectedIndex !== characterIndex ||
        currentTarget.character.chaId !== characterId ||
        characterDraftAvatarSnapshot() !== avatarSnapshot
      ) {
        return
      }

      updateCharacterDraft((character) => {
        if (character.image) {
          character.ccAssets ??= []
          character.ccAssets.push({
            type: 'icon',
            name: 'iconx',
            uri: character.image,
            ext: 'png',
          })
        }

        if (Object.keys(pngExif).length > 0) {
          character.extentions ??= {}
          character.extentions.pngExif ??= {}
          Object.assign(character.extentions.pngExif, pngExif)
        }
        character.image = image
      })
    })
  }

  function rotateCharacterImageFromDraft(index: number): void {
    if (!currentRealCharacterDraftTarget()) return

    updateCharacterDraft((character) => {
      const selectedAsset = character.ccAssets?.[index]
      if (!selectedAsset) return

      character.ccAssets?.splice(index, 1)
      if (character.image) {
        character.ccAssets ??= []
        character.ccAssets.push({
          type: 'icon',
          name: 'iconx',
          uri: character.image,
          ext: 'png',
        })
      }
      character.image = selectedAsset.uri
    })
  }

  function currentEditorEmotionUploadTarget() {
    const target = currentRealCharacterDraftTarget()
    if (!target) return null

    return captureCharacterEmotionUploadTarget({
      characterId: target.character.chaId,
      characterIndex: target.selectedIndex,
      emotionImages: (characterDraft.value as unknown as character).emotionImages,
    })
  }

  function editorEmotionUploadFreshness(operation: CharacterEmotionUploadOperation) {
    const selectedCharacter = selectedCharacterOwner()
    const targetRow = operation.characterIndex === undefined ? undefined : characterOwnerAt(operation.characterIndex)

    return {
      currentCharacterId: selectedCharacter?.chaId,
      rowCharacterId: operation.characterIndex === undefined ? undefined : (targetRow?.chaId ?? null),
      draftCharacterId: characterDraft.characterId,
      emotionImages: (characterDraft.value as unknown as character).emotionImages,
    }
  }

  function isCurrentEditorEmotionUpload(operation: CharacterEmotionUploadOperation): boolean {
    return isFreshCharacterEmotionUpload(operation, editorEmotionUploadFreshness(operation))
  }

  async function addCharacterEmotionsFromEditor(): Promise<void> {
    addingEmotion.set(true)
    let operation: CharacterEmotionUploadOperation | null = null
    try {
      const target = currentEditorEmotionUploadTarget()
      if (!target) return

      const files = await selectMultipleFile(['png', 'webp', 'gif'], {
        onFilesSelected: () => {
          operation = beginCharacterEmotionUpload(target)
        },
      })
      if (!files || files.length === 0 || !operation) return

      const activeOperation = operation
      const entries: CharacterEmotionImageEntry[] = []
      for (const file of files) {
        if (!isCurrentEditorEmotionUpload(activeOperation)) return

        const image = await saveAsset(file.data, '', file.name)
        if (!isCurrentEditorEmotionUpload(activeOperation)) return

        entries.push([file.name.replace(/\.(png|webp|gif)$/i, ''), image])
      }

      const emotionImages = appendFreshCharacterEmotionImages({
        operation: activeOperation,
        freshness: editorEmotionUploadFreshness(activeOperation),
        entries,
      })
      if (!emotionImages) return

      updateCharacterDraft((character) => {
        character.emotionImages = emotionImages
      })
    } finally {
      if (operation) {
        clearCharacterEmotionUpload(operation)
      }
      addingEmotion.set(false)
    }
  }

  function removeCharacterEmotionFromDraft(index: number): void {
    if (!currentRealCharacterDraftTarget()) return

    updateCharacterDraft((character) => {
      character.emotionImages.splice(index, 1)
    })
  }

  function additionalAssetExtension(name: string): string {
    return name.split('.').pop()?.toLowerCase() ?? ''
  }

  function currentEditorAdditionalAssetUploadTarget() {
    const target = currentRealCharacterDraftTarget()
    if (!target) return null

    return captureCharacterAdditionalAssetUploadTarget({
      characterId: target.character.chaId,
      characterIndex: target.selectedIndex,
      additionalAssets: (characterDraft.value as unknown as character).additionalAssets,
    })
  }

  function editorAdditionalAssetUploadFreshness(operation: CharacterAdditionalAssetUploadOperation) {
    const selectedCharacter = selectedCharacterOwner()
    const targetRow = operation.characterIndex === undefined ? undefined : characterOwnerAt(operation.characterIndex)

    return {
      currentCharacterId: selectedCharacter?.chaId,
      rowCharacterId: operation.characterIndex === undefined ? undefined : (targetRow?.chaId ?? null),
      draftCharacterId: characterDraft.characterId,
      additionalAssets: (characterDraft.value as unknown as character).additionalAssets,
    }
  }

  function isCurrentEditorAdditionalAssetUpload(operation: CharacterAdditionalAssetUploadOperation): boolean {
    return isFreshCharacterAdditionalAssetUpload(operation, editorAdditionalAssetUploadFreshness(operation))
  }

  async function uploadAdditionalAssetEntries(
    files: readonly SelectedAdditionalAssetFile[],
    operation: CharacterAdditionalAssetUploadOperation,
    isCurrentUpload: (operation: CharacterAdditionalAssetUploadOperation) => boolean,
  ): Promise<CharacterAdditionalAssetEntry[] | null> {
    const entries: CharacterAdditionalAssetEntry[] = []

    for (const file of files) {
      if (!isCurrentUpload(operation)) return null

      const extension = additionalAssetExtension(file.name)
      const assetPath = await saveAsset(file.data, '', extension)
      if (!isCurrentUpload(operation)) return null

      entries.push([file.name, assetPath, extension])
    }

    return entries
  }

  async function uploadCharacterAdditionalAssetsFromEditor(): Promise<void> {
    const target = currentEditorAdditionalAssetUploadTarget()
    if (!target) return

    let operation: CharacterAdditionalAssetUploadOperation | null = null
    try {
      const files = await selectMultipleFile(CHARACTER_ADDITIONAL_ASSET_EXTENSIONS, {
        onFilesSelected: () => {
          operation = beginCharacterAdditionalAssetUpload(target)
        },
      })
      if (!files || files.length === 0 || !operation) return

      const activeOperation = operation
      const uploadedEntries = await uploadAdditionalAssetEntries(
        files,
        activeOperation,
        isCurrentEditorAdditionalAssetUpload,
      )
      if (!uploadedEntries || uploadedEntries.length === 0) return

      const nextAdditionalAssets = appendFreshCharacterAdditionalAssets({
        operation: activeOperation,
        freshness: editorAdditionalAssetUploadFreshness(activeOperation),
        entries: uploadedEntries,
      })
      if (!nextAdditionalAssets) return
      ;(characterDraft.value as unknown as character).additionalAssets = nextAdditionalAssets
      characterDraft.value = { ...characterDraft.value }
    } finally {
      if (operation) {
        clearCharacterAdditionalAssetUpload(operation)
      }
    }
  }

  function currentEditorNotificationImageUploadTarget() {
    const target = currentEditableCharacterTarget()
    if (!target) return null

    return captureCharacterNotificationImageUploadTarget({
      characterId: target.character.chaId,
      characterIndex: target.selectedIndex,
      draftCharacterId: characterDraft.characterId,
      rowNotificationImage: target.character.notificationImage,
      draftNotificationImage: characterDraft.value.notificationImage,
    })
  }

  function editorNotificationImageUploadFreshness(operation: CharacterNotificationImageUploadOperation) {
    const editableTarget = currentEditableCharacterTarget()
    const targetRow = operation.characterIndex === undefined ? undefined : characterOwnerAt(operation.characterIndex)

    return {
      currentCharacterId: editableTarget?.character.chaId,
      rowCharacterId: operation.characterIndex === undefined ? undefined : (targetRow?.chaId ?? null),
      draftCharacterId: characterDraft.characterId,
      rowNotificationImage: targetRow?.notificationImage,
      draftNotificationImage: characterDraft.value.notificationImage,
    }
  }

  function isCurrentEditorNotificationImageUpload(operation: CharacterNotificationImageUploadOperation): boolean {
    return isFreshCharacterNotificationImageUpload(operation, editorNotificationImageUploadFreshness(operation))
  }

  async function uploadNotificationImageFromEditor(): Promise<void> {
    const target = currentEditorNotificationImageUploadTarget()
    if (!target) return

    let operation: CharacterNotificationImageUploadOperation | null = null
    try {
      const selected = (await selectSingleFile(NOTIFICATION_IMAGE_EXTENSIONS, {
        onFileSelected: () => {
          operation = beginCharacterNotificationImageUpload(target)
        },
      })) as SelectedSingleFile | null
      if (!selected || !operation) return

      const activeOperation = operation
      if (!isCurrentEditorNotificationImageUpload(activeOperation)) return

      const image = await saveAsset(selected.data, '', selected.name)
      const nextImage = applyFreshCharacterNotificationImageUpload({
        operation: activeOperation,
        freshness: editorNotificationImageUploadFreshness(activeOperation),
        image,
      })
      if (nextImage === null) return

      const realDraftTarget = currentRealCharacterDraftTarget()
      if (
        activeOperation.draftCharacterId === activeOperation.characterId &&
        realDraftTarget?.selectedIndex === activeOperation.characterIndex &&
        realDraftTarget.character.chaId === activeOperation.characterId
      ) {
        updateCharacterDraft((character) => {
          character.notificationImage = nextImage
        })
        return
      }

      if (activeOperation.characterIndex === undefined) return
      applyCharacterRowMutationScoped(activeOperation.characterIndex, activeOperation.characterId, (character) => {
        character.notificationImage = nextImage
      })
    } finally {
      if (operation) {
        clearCharacterNotificationImageUpload(operation)
      }
    }
  }

  function currentEditorTtsAssetUploadTarget(kind: CharacterTtsAssetUploadKind) {
    const target = currentRealCharacterDraftTarget()
    if (!target) return null

    const draft = characterDraft.value as unknown as character
    return captureCharacterTtsAssetUploadTarget({
      characterId: target.character.chaId,
      characterIndex: target.selectedIndex,
      draftCharacterId: characterDraft.characterId,
      kind,
      ttsMode: draft.ttsMode,
      vits: draft.vits,
      refAudioData: draft.gptSoVitsConfig?.ref_audio_data,
    })
  }

  function editorTtsAssetUploadFreshness(operation: CharacterTtsAssetUploadOperation) {
    const selectedCharacter = selectedCharacterOwner()
    const targetRow = operation.characterIndex === undefined ? undefined : characterOwnerAt(operation.characterIndex)
    const draft = characterDraft.value as unknown as character

    return {
      currentCharacterId: selectedCharacter?.chaId,
      rowCharacterId: operation.characterIndex === undefined ? undefined : (targetRow?.chaId ?? null),
      draftCharacterId: characterDraft.characterId,
      ttsMode: draft.ttsMode,
      vits: draft.vits,
      refAudioData: draft.gptSoVitsConfig?.ref_audio_data,
    }
  }

  function isCurrentEditorTtsAssetUpload(operation: CharacterTtsAssetUploadOperation): boolean {
    return isFreshCharacterTtsAssetUpload(operation, editorTtsAssetUploadFreshness(operation))
  }

  async function registerVitsModelFromEditor(): Promise<void> {
    const target = currentEditorTtsAssetUploadTarget('vits-model')
    if (!target) return

    let operation: CharacterTtsAssetUploadOperation | null = null
    try {
      const selected = (await selectSingleFile(['zip'], {
        onFileSelected: () => {
          operation = beginCharacterTtsAssetUpload(target)
        },
      })) as SelectedSingleFile | null | undefined
      if (!selected || !operation) return

      const activeOperation = operation
      if (!isCurrentEditorTtsAssetUpload(activeOperation)) return

      const model = await registerOnnxModelFromFile(selected, {
        shouldContinue: () => isCurrentEditorTtsAssetUpload(activeOperation),
      })
      if (!model) return

      const nextModel = applyFreshCharacterVitsModelRegistration({
        operation: activeOperation,
        freshness: editorTtsAssetUploadFreshness(activeOperation),
        model,
      })
      if (!nextModel) return

      updateCharacterDraft((character) => {
        character.vits = nextModel
      })
    } finally {
      if (operation) {
        clearCharacterTtsAssetUpload(operation)
      }
    }
  }

  async function uploadGptSoVitsReferenceAudioFromEditor(): Promise<void> {
    const target = currentEditorTtsAssetUploadTarget('gptsovits-ref-audio')
    if (!target) return

    let operation: CharacterTtsAssetUploadOperation | null = null
    try {
      const audio = (await selectSingleFile(['wav', 'ogg', 'aac', 'mp3'], {
        onFileSelected: () => {
          operation = beginCharacterTtsAssetUpload(target)
        },
      })) as SelectedSingleFile | null | undefined
      if (!audio || !operation) return

      const activeOperation = operation
      if (!isCurrentEditorTtsAssetUpload(activeOperation)) return

      const saveId = await saveAsset(audio.data, '', audio.name)
      if (!isCurrentEditorTtsAssetUpload(activeOperation)) return

      const nextRefAudioData = applyFreshCharacterGptSoVitsReferenceAudioUpload({
        operation: activeOperation,
        freshness: editorTtsAssetUploadFreshness(activeOperation),
        refAudioData: {
          fileName: audio.name,
          assetId: saveId,
        },
      })
      if (!nextRefAudioData) return

      updateCharacterDraft((character) => {
        if (!character.gptSoVitsConfig) return
        character.gptSoVitsConfig.ref_audio_data = nextRefAudioData
      })
    } finally {
      if (operation) {
        clearCharacterTtsAssetUpload(operation)
      }
    }
  }

  function clearOrRotateCharacterImage(): void {
    updateCharacterDraft((character) => {
      if (character.ccAssets && character.ccAssets.length > 0) {
        const image = character.ccAssets[0].uri
        character.ccAssets.splice(0, 1)
        character.image = image
      } else {
        character.image = ''
      }
    })
  }

  function clearNotificationImage(): void {
    const target = currentRealCharacterDraftTarget()
    if (!target) return

    invalidateCharacterNotificationImageUpload(target.character.chaId)
    updateCharacterDraft((character) => {
      character.notificationImage = ''
    })
  }

  function removeCharacterCcAsset(index: number): void {
    updateCharacterDraft((character) => {
      character.ccAssets?.splice(index, 1)
    })
  }

  function updateCharacterInlayScreen(): void {
    updateCharacterDraft((character) => {
      Object.assign(character, updateInlayScreen(character))
    })
  }

  function togglePrebuiltAssetExclude(assetId: string): void {
    updateCharacterDraft((character) => {
      character.prebuiltAssetExclude ??= []
      if (character.prebuiltAssetExclude.includes(assetId)) {
        character.prebuiltAssetExclude = character.prebuiltAssetExclude.filter((entry) => entry !== assetId)
      } else {
        character.prebuiltAssetExclude.push(assetId)
      }
    })
  }
</script>

{#if licensed !== 'private' && !$MobileGUI}
  <div class="flex mb-2" class:gap-2={iconButtonSize === 24} class:gap-1={iconButtonSize < 24}>
    <button
      type="button"
      data-char-config-section="profile"
      aria-label={language.character}
      title={language.character}
      aria-pressed={$CharConfigSubMenu === 0}
      class={$CharConfigSubMenu === 0 ? 'text-textcolor ' : 'text-textcolor2'}
      onclick={() => {
        $CharConfigSubMenu = 0
      }}>
      <UserIcon size={iconButtonSize} />
    </button>
    <button
      type="button"
      data-char-config-section="display"
      aria-label={language.characterDisplay}
      title={language.characterDisplay}
      aria-pressed={$CharConfigSubMenu === 1}
      class={$CharConfigSubMenu === 1 ? 'text-textcolor' : 'text-textcolor2'}
      onclick={() => {
        $CharConfigSubMenu = 1
      }}>
      <SmileIcon size={iconButtonSize} />
    </button>
    <button
      type="button"
      data-char-config-section="lorebook"
      aria-label={language.loreBook}
      title={language.loreBook}
      aria-pressed={$CharConfigSubMenu === 3}
      class={$CharConfigSubMenu === 3 ? 'text-textcolor' : 'text-textcolor2'}
      onclick={() => {
        $CharConfigSubMenu = 3
      }}>
      <BookIcon size={iconButtonSize} />
    </button>
    {#if currentEditableCharacterTarget()}
      <button
        type="button"
        data-char-config-section="tts"
        aria-label="TTS"
        title="TTS"
        aria-pressed={$CharConfigSubMenu === 5}
        class={$CharConfigSubMenu === 5 ? 'text-textcolor' : 'text-textcolor2'}
        onclick={() => {
          $CharConfigSubMenu = 5
        }}>
        <Volume2Icon size={iconButtonSize} />
      </button>
      <button
        type="button"
        data-char-config-section="scripts"
        aria-label={language.scripts}
        title={language.scripts}
        aria-pressed={$CharConfigSubMenu === 4}
        class={$CharConfigSubMenu === 4 ? 'text-textcolor' : 'text-textcolor2'}
        onclick={() => {
          $CharConfigSubMenu = 4
        }}>
        <Braces size={iconButtonSize} />
      </button>
    {/if}
    <button
      type="button"
      data-char-config-section="advanced"
      aria-label={language.advancedSettings}
      title={language.advancedSettings}
      aria-pressed={$CharConfigSubMenu === 2}
      class={$CharConfigSubMenu === 2 ? 'text-textcolor' : 'text-textcolor2'}
      onclick={() => {
        $CharConfigSubMenu = 2
      }}>
      <ActivityIcon size={iconButtonSize} />
    </button>
    {#if currentEditableCharacterTarget()}
      <button
        type="button"
        data-char-config-section="manage"
        aria-label={`${language.exportCharacter} / ${language.removeCharacter}`}
        title={`${language.exportCharacter} / ${language.removeCharacter}`}
        aria-pressed={$CharConfigSubMenu === 6}
        class={$CharConfigSubMenu === 6 ? 'text-textcolor' : 'text-textcolor2'}
        onclick={() => {
          $CharConfigSubMenu = 6
        }}>
        <Share2Icon size={iconButtonSize} />
      </button>
    {/if}
  </div>
{/if}

{#if $CharConfigSubMenu === 0}
  {#if licensed !== 'private'}
    <TextInput
      size="xl"
      marginBottom
      placeholder="Character Name"
      ariaLabel="Character Name"
      bind:value={characterDraft.value.name} />
    <TextInput
      size="lg"
      marginBottom
      placeholder={language.displayName}
      ariaLabel={language.displayName}
      bind:value={characterDraft.value.displayName} />
    <span class="text-textcolor">{language.description} <Help key="charDesc" /></span>
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      ariaLabel={language.description}
      bind:value={characterDraft.value.desc}></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm">{tokens.desc} {language.tokens}</span>
    <span class="text-textcolor">{language.firstMessage} <Help key="charFirstMessage" /></span>
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      ariaLabel={language.firstMessage}
      bind:value={characterDraft.value.firstMessage}></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm">{tokens.firstMsg} {language.tokens}</span>
    <span class="text-textcolor">{language.customNotificationMessage} <Help key="customNotificationMessage" /></span>
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      ariaLabel={language.customNotificationMessage}
      bind:value={characterDraft.value.customNotificationMessage}></TextAreaInput>
  {/if}
{:else if licensed === 'private'}
  <span>You are not allowed</span>
  {(() => {
    $CharConfigSubMenu = 0
  })()}
{:else if $CharConfigSubMenu === 1}
  {#if !$MobileGUI}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.characterDisplay}</h2>
  {/if}

  <div class="flex w-full rounded-md border border-selected mb-4">
    <button
      aria-pressed={viewSubMenu === 0}
      onclick={() => {
        viewSubMenu = 0
      }}
      class="p-2 flex-1"
      class:bg-selected={viewSubMenu === 0}>
      <span>{language.charIcon}</span>
    </button>
    <button
      aria-pressed={viewSubMenu === 1}
      onclick={() => {
        viewSubMenu = 1
      }}
      class="p-2 flex-1 border-r border-l border-selected"
      class:bg-selected={viewSubMenu === 1}>
      <span>{language.viewScreen}</span>
    </button>
    <button
      aria-pressed={viewSubMenu === 2}
      onclick={() => {
        viewSubMenu = 2
      }}
      class="p-2 flex-1"
      class:bg-selected={viewSubMenu === 2}>
      <span>{language.additionalAssets}</span>
    </button>
  </div>

  {#if viewSubMenu === 0}
    <div class="p-2 border-darkborderc border rounded-md flex flex-wrap gap-2">
      {#if characterDraft.value.image !== '' && characterDraft.value.image}
        <button
          aria-label={`${iconRemoveMode ? language.remove : language.select}: ${language.charIcon}`}
          onclick={() => {
            if (
              currentRealCharacterDraftTarget() &&
              characterDraft.value.image !== '' &&
              characterDraft.value.image &&
              iconRemoveMode
            ) {
              clearOrRotateCharacterImage()
              iconRemoveMode = false
            }
          }}>
          {#await getCharImage(characterDraft.value.image, characterDraft.value.largePortrait ? 'lgcss' : 'css')}
            <div
              class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
              class:ring-red-500={iconRemoveMode}>
            </div>
          {:then im}
            <div
              class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
              class:ring-red-500={iconRemoveMode}
              style={im}>
            </div>
          {/await}
        </button>
      {/if}
      {#if characterDraft.value.ccAssets}
        {#each characterDraft.value.ccAssets as assets, i}
          <button
            aria-label={`${iconRemoveMode ? language.remove : language.select}: ${language.charIcon} ${i + 2}`}
            onclick={async () => {
              if (!iconRemoveMode) {
                rotateCharacterImageFromDraft(i)
              } else if (currentRealCharacterDraftTarget()) {
                removeCharacterCcAsset(i)
                iconRemoveMode = false
              }
            }}>
            {#await getCharImage(assets.uri, characterDraft.value.largePortrait ? 'lgcss' : 'css')}
              <div
                class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                class:ring-red-500={iconRemoveMode}
                class:ring-3={iconRemoveMode}>
              </div>
            {:then im}
              <div
                class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                style={im}
                class:ring-red-500={iconRemoveMode}
                class:ring-3={iconRemoveMode}>
              </div>
            {/await}
          </button>
        {/each}
      {/if}
      <button
        aria-label={`${language.add}: ${language.charIcon}`}
        onclick={async () => {
          await selectCharacterAvatarFromEditor()
        }}>
        <div
          class="rounded-md h-24 w-24 cursor-pointer border-darkborderc border border-dashed flex justify-center items-center hover:border-blue-500"
          style={characterDraft.value.largePortrait ? 'height: 10.66rem;' : ''}>
          <PlusIcon />
        </div>
      </button>
    </div>
    <div class="flex w-full items-end justify-end mt-2">
      <button
        class={iconRemoveMode ? 'text-red-500' : 'text-textcolor2 hover:text-textcolor'}
        aria-label={`${language.remove}: ${language.charIcon}`}
        aria-pressed={iconRemoveMode}
        onclick={() => {
          iconRemoveMode = !iconRemoveMode
        }}>
        <TrashIcon size="18" />
      </button>
    </div>

    {#if characterDraft.value.image !== ''}
      <div class="flex items-center mt-4">
        <Check bind:check={characterDraft.value.largePortrait} name={language.largePortrait} />
      </div>
    {/if}

    <div class="p-2 border-darkborderc border rounded-md mt-4">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-textcolor">{language.notificationImage} <Help key="notificationImage" /></span>
        {#if characterDraft.value.notificationImage}
          <button
            class="text-textcolor2 hover:text-red-500"
            aria-label={`${language.remove}: ${language.notificationImage}`}
            onclick={() => {
              clearNotificationImage()
            }}>
            <TrashIcon size="18" />
          </button>
        {/if}
      </div>
      <div class="flex flex-wrap gap-2">
        {#if characterDraft.value.notificationImage}
          <button
            aria-label={`${language.edit}: ${language.notificationImage}`}
            onclick={async () => {
              await uploadNotificationImageFromEditor()
            }}>
            {#await getCharImage(characterDraft.value.notificationImage, 'css')}
              <div class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow">
              </div>
            {:then im}
              <div
                class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                style={im}>
              </div>
            {/await}
          </button>
        {/if}
        <button
          aria-label={`${language.add}: ${language.notificationImage}`}
          onclick={async () => {
            await uploadNotificationImageFromEditor()
          }}>
          <div
            class="rounded-md h-20 w-20 cursor-pointer border-darkborderc border border-dashed flex justify-center items-center hover:border-blue-500">
            <PlusIcon />
          </div>
        </button>
      </div>
    </div>
  {:else if viewSubMenu === 1}
    <SelectInput
      className="mb-2"
      ariaLabel={language.characterDisplay}
      bind:value={characterDraft.value.viewScreen}
      onchange={() => {
        updateCharacterInlayScreen()
      }}>
      <OptionInput value="none">{language.none}</OptionInput>
      <OptionInput value="emotion">{language.emotionImage}</OptionInput>
      <OptionInput value="imggen">{language.imageGeneration}</OptionInput>
    </SelectInput>

    {#if characterDraft.value.viewScreen === 'emotion'}
      <span class="text-textcolor mt-6">{language.emotionImage} <Help key="emotion" /></span>
      <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

      <div class="w-full max-w-full border border-selected p-2 rounded-md">
        <table class="w-full max-w-full tabler">
          <tbody>
            <tr>
              <th class="font-medium w-1/3">{language.image}</th>
              <th class="font-medium w-1/2">{language.emotion}</th>
              <th class="font-medium"></th>
            </tr>
            {#if characterDraft.value.emotionImages.length === 0}
              <tr>
                <td colspan="3">{language.noImages}</td>
              </tr>
            {:else}
              {#each characterDraft.value.emotionImages as emo, i}
                <tr>
                  {#await getCharImage(emo[1], 'plain')}
                    <td class="font-medium truncate w-1/3"></td>
                  {:then im}
                    <td class="font-medium truncate w-1/3"><img src={im} alt="img" class="w-full" /></td>
                  {/await}
                  <td class="font-medium truncate w-1/2">
                    <TextInput
                      marginBottom
                      size="lg"
                      ariaLabel={`${language.emotion} ${i + 1}`}
                      bind:value={characterDraft.value.emotionImages[i][0]} />
                  </td>
                  <td>
                    <button
                      class="font-medium cursor-pointer hover:text-green-500"
                      aria-label={`${language.remove}: ${language.emotionImage} ${i + 1}`}
                      onclick={() => {
                        removeCharacterEmotionFromDraft(i)
                      }}><TrashIcon /></button>
                  </td>
                </tr>
              {/each}
            {/if}
          </tbody>
        </table>
      </div>

      <div class="text-textcolor2 hover:text-textcolor mt-2 flex">
        {#if !$addingEmotion}
          <button
            class="cursor-pointer hover:text-green-500"
            aria-label={`${language.add}: ${language.emotionImage}`}
            onclick={() => {
              void addCharacterEmotionsFromEditor()
            }}>
            <PlusIcon />
          </button>
        {:else}
          <span>Loading...</span>
        {/if}
      </div>

      {#if characterDraft.value.inlayViewScreen}
        <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
        <TextAreaInput
          highlight
          ariaLabel={language.imgGenInstructions}
          bind:value={characterDraft.value.newGenData.emotionInstructions} />
      {/if}

      <CheckInput
        bind:check={characterDraft.value.inlayViewScreen}
        name={language.inlayViewScreen}
        onChange={() => {
          if (currentRealCharacterDraftTarget()) {
            if (characterDraft.value.inlayViewScreen && characterDraft.value.additionalAssets === undefined) {
              characterDraft.value.additionalAssets = []
            } else if (
              !characterDraft.value.inlayViewScreen &&
              (characterDraft.value.additionalAssets?.length ?? 0) === 0
            ) {
              characterDraft.value.additionalAssets = []
            }

            updateCharacterInlayScreen()
          }
        }} />
    {/if}
    {#if characterDraft.value.viewScreen === 'imggen'}
      <span class="text-textcolor mt-6">{language.imageGeneration} <Help key="imggen" /></span>
      <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

      <span class="text-textcolor mt-2">{language.imgGenPrompt}</span>
      <TextAreaInput highlight ariaLabel={language.imgGenPrompt} bind:value={characterDraft.value.newGenData.prompt} />
      <span class="text-textcolor mt-2">{language.imgGenNegatives}</span>
      <TextAreaInput
        highlight
        ariaLabel={language.imgGenNegatives}
        bind:value={characterDraft.value.newGenData.negative} />
      <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
      <TextAreaInput
        highlight
        ariaLabel={language.imgGenInstructions}
        bind:value={characterDraft.value.newGenData.instructions} />

      <CheckInput
        bind:check={characterDraft.value.inlayViewScreen}
        name={language.inlayViewScreen}
        onChange={() => {
          if (currentRealCharacterDraftTarget()) {
            updateCharacterInlayScreen()
          }
        }} />
    {/if}
  {:else if viewSubMenu === 2}
    {#if newImageHandlingBeta}
      <CheckInput bind:check={characterDraft.value.prebuiltAssetCommand} name={language.insertAssetPrompt} />

      {#if characterDraft.value.prebuiltAssetCommand}
        <span class="text-textcolor mt-2">{language.assetStyle}</span>
        <SelectInput
          className="mb-2"
          ariaLabel={language.assetStyle}
          bind:value={characterDraft.value.prebuiltAssetStyle}>
          <OptionInput value="">{language.static}</OptionInput>
          <OptionInput value="dynamic">{language.dynamic}</OptionInput>
        </SelectInput>
      {/if}
    {/if}
    <div class="w-full max-w-full border border-selected rounded-md p-2 mt-2">
      <table class="contain w-full max-w-full tabler mt-2">
        <tbody>
          <tr>
            <th class="font-medium">{language.value}</th>
            <th class="font-medium cursor-pointer w-10">
              <button
                class="hover:text-green-500"
                aria-label={`${language.add}: ${language.additionalAssets}`}
                onclick={async () => {
                  await uploadCharacterAdditionalAssetsFromEditor()
                }}>
                <PlusIcon />
              </button>
            </th>
          </tr>
          {#if !characterDraft.value.additionalAssets || characterDraft.value.additionalAssets.length === 0}
            <tr>
              <td class="text-textcolor2"> No Assets</td>
            </tr>
          {:else}
            {#each characterDraft.value.additionalAssets as assets, i (assetListRenderKey(assets, i))}
              <tr>
                <td class="font-medium truncate">
                  {#if assetFilePath[assets[1]] && useAdditionalAssetsPreview}
                    {#if assetFileExtensions[assets[1]] === 'mp4'}
                      <!-- svelte-ignore a11y_media_has_caption -->
                      <video controls class="mt-2 px-2 w-full m-1 rounded-md"
                        ><source src={assetFilePath[assets[1]]} type="video/mp4" /></video>
                    {:else if assetFileExtensions[assets[1]] === 'mp3'}
                      <audio controls class="mt-2 px-2 w-full h-16 m-1 rounded-md" loop
                        ><source src={assetFilePath[assets[1]]} type="audio/mpeg" /></audio>
                    {:else if ['png', 'webp', 'jpeg', 'jpg', 'gif'].includes(assetFileExtensions[assets[1]] ?? '')}
                      <img src={assetFilePath[assets[1]]} class="w-16 h-16 m-1 rounded-md" alt={assets[0]} />
                    {/if}
                  {/if}
                  <TextInput
                    size="sm"
                    marginBottom
                    ariaLabel={`${language.additionalAssets} ${i + 1}`}
                    bind:value={characterDraft.value.additionalAssets[i][0]}
                    placeholder="..." />
                </td>

                <th class="font-medium cursor-pointer w-10">
                  <button
                    class="hover:text-blue-500"
                    aria-label={`${language.remove}: ${assets[0] || `${language.additionalAssets} ${i + 1}`}`}
                    onclick={() => {
                      if (currentRealCharacterDraftTarget()) {
                        let additionalAssets = characterDraft.value.additionalAssets
                        additionalAssets.splice(i, 1)
                        characterDraft.value.additionalAssets = additionalAssets
                        characterDraft.value = { ...characterDraft.value }
                      }
                    }}>
                    <TrashIcon />
                  </button>
                  {#if useAdditionalAssetsPreview}
                    <button
                      class="hover:text-blue-500"
                      class:text-textcolor2={characterDraft.value.prebuiltAssetExclude?.includes?.(assets[1])}
                      aria-label={`${language.image}: ${assets[0] || `${language.additionalAssets} ${i + 1}`}`}
                      aria-pressed={!characterDraft.value.prebuiltAssetExclude?.includes?.(assets[1])}
                      onclick={() => {
                        togglePrebuiltAssetExclude(assets[1])
                      }}>
                      {#if characterDraft.value.prebuiltAssetExclude?.includes?.(assets[1])}
                        <ImageOffIcon />
                      {:else}
                        <ImageIcon />
                      {/if}
                    </button>
                  {/if}
                </th>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
{:else if $CharConfigSubMenu === 3}
  {#if !$MobileGUI}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.loreBook} <Help key="lorebook" /></h2>
  {/if}
  <LoreBook />
{:else if $CharConfigSubMenu === 4}
  {#if currentRealCharacterDraftTarget()}
    {#if !$MobileGUI}
      <h2 class="mb-2 text-2xl font-bold mt-2">{language.scripts}</h2>
    {/if}

    <span class="text-textcolor mt-2">{language.backgroundHTML} <Help key="backgroundHTML" /></span>
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      ariaLabel={language.backgroundHTML}
      bind:value={characterDraft.value.backgroundHTML}></TextAreaInput>

    <span class="text-textcolor mt-4">{language.regexScript} <Help key="regexScript" /></span>
    <RegexList
      bind:value={characterScriptsDraft}
      ownerKey={scriptDraftCharacterId ?? ''}
      beforeDisplayActivation={prepareCharacterRegexDisplayActivation}
      onCompositionChange={(active) => {
        scriptDraftCompositionActive = active
      }} />
    <div class="text-textcolor2 mt-2 flex gap-2">
      <button
        class="font-medium cursor-pointer hover:text-green-500"
        aria-label={`${language.add}: ${language.regexScript}`}
        onclick={() => {
          const target = currentRealCharacterDraftTarget()
          if (target && scriptDraftCharacterId === target.character.chaId) {
            characterScriptsDraft = [
              ...characterScriptsDraft,
              {
                comment: '',
                in: '',
                out: '',
                type: 'editinput',
              },
            ]
          }
        }}><PlusIcon /></button>
      <button
        class="font-medium cursor-pointer hover:text-green-500"
        aria-label={`${language.export}: ${language.regexScript}`}
        onclick={() => {
          exportRegex(characterScriptsDraft)
        }}><DownloadIcon /></button>
      <button
        class="font-medium cursor-pointer hover:text-green-500"
        aria-label={`${language.import}: ${language.regexScript}`}
        onclick={importCharacterRegexScripts}><HardDriveUploadIcon /></button>
    </div>

    <span class="text-textcolor mt-4">{language.triggerScript} <Help key="triggerScript" /></span>
    <TriggerList
      bind:value={characterTriggersDraft}
      ownerKey={scriptDraftCharacterId ?? ''}
      lowLevelAble={selectedCharacterOwner()?.lowLevelAccess ?? false} />

    {#if characterDraft.value.virtualscript || showUnrecommended}
      <span class="text-textcolor mt-4">{language.charjs} <Help key="charjs" unrecommended /></span>
      <TextAreaInput
        margin="both"
        autocomplete="off"
        ariaLabel={language.charjs}
        bind:value={characterDraft.value.virtualscript}></TextAreaInput>
    {/if}
  {/if}
{:else if $CharConfigSubMenu === 6}
  {#if selectedCharacterOwner()?.license !== 'CC BY-NC-SA 4.0' && selectedCharacterOwner()?.license !== 'CC BY-SA 4.0' && selectedCharacterOwner()?.license !== 'CC BY-ND 4.0' && selectedCharacterOwner()?.license !== 'CC BY-NC-ND 4.0'}
    <Button
      size="sm"
      onclick={async () => {
        const res = await exportChar($selectedCharID)
      }}
      className="mt-2">{language.exportCharacter}</Button>
  {/if}

  <div
    class="mt-2 flex items-center gap-2"
    data-risu-character-removal
    data-risu-mutation-status={characterRemovalStatus}
    aria-busy={characterRemovalPending}>
    <Button onclick={removeCurrentCharacter} disabled={characterRemovalPending} size="sm"
      >{language.removeCharacter}</Button>
    {#if characterRemovalStatus === 'failed'}
      <span class="text-xs text-textcolor2" role="status" aria-live="polite">
        {language.mutationStatusFailed}
      </span>
    {/if}
  </div>
{:else if $CharConfigSubMenu === 5}
  {#if currentRealCharacterDraftTarget()}
    {#if !$MobileGUI}
      <h2 class="mb-2 text-2xl font-bold mt-2">TTS</h2>
    {/if}
    <span class="text-textcolor">{language.provider}</span>
    <SelectInput
      className="mb-4 mt-2"
      ariaLabel={language.provider}
      bind:value={characterDraft.value.ttsMode}
      onchange={(e) => {
        if (currentRealCharacterDraftTarget()) {
          updateCharacterDraft((character) => {
            character.ttsSpeech = ''
          })
        }
      }}>
      <OptionInput value="">{language.disabled}</OptionInput>
      <OptionInput value="elevenlab">ElevenLabs</OptionInput>
      <OptionInput value="webspeech">Web Speech</OptionInput>
      <OptionInput value="VOICEVOX">VOICEVOX</OptionInput>
      <OptionInput value="openai">OpenAI</OptionInput>
      <OptionInput value="novelai">NovelAI</OptionInput>
      <OptionInput value="huggingface">Huggingface</OptionInput>
      <OptionInput value="vits">VITS</OptionInput>
      <OptionInput value="gptsovits">GPT-SoVITS</OptionInput>
      <OptionInput value="fishspeech">fish-speech</OptionInput>
    </SelectInput>

    {#if characterDraft.value.ttsMode === 'webspeech'}
      {#if !webSpeechSupported}
        <span class="text-textcolor">Web Speech isn't supported in your browser or OS</span>
      {:else}
        <span class="text-textcolor">{language.Speech}</span>
        <SelectInput className="mb-4 mt-2" ariaLabel={language.Speech} bind:value={characterDraft.value.ttsSpeech}>
          <OptionInput value="">Auto</OptionInput>
          {#each webSpeechVoices as voice}
            <OptionInput value={voice}>{voice}</OptionInput>
          {/each}
        </SelectInput>
        {#if characterDraft.value.ttsSpeech !== ''}
          <span class="text-red-400 text-sm"
            >If you do not set it to Auto, it may not work properly when importing from another OS or browser.</span>
        {/if}
      {/if}
    {:else if characterDraft.value.ttsMode === 'elevenlab'}
      <span class="text-sm mb-2 text-textcolor2"
        >Please set the ElevenLabs API key in "global Settings → Bot Settings → Others → ElevenLabs API key"</span>
      {#await getElevenTTSVoices() then voices}
        <span class="text-textcolor">{language.Speech}</span>
        <SelectInput className="mb-4 mt-2" ariaLabel={language.Speech} bind:value={characterDraft.value.ttsSpeech}>
          <OptionInput value="">Unset</OptionInput>
          {#each voices as voice}
            <OptionInput value={voice.voice_id}>{voice.name}</OptionInput>
          {/each}
        </SelectInput>
      {:catch}
        <span class="text-textcolor">{language.ttsCatalogError}</span>
      {/await}
    {:else if characterDraft.value.ttsMode === 'VOICEVOX'}
      <span class="text-textcolor">Speaker</span>
      <SelectInput className="mb-4 mt-2" ariaLabel="Speaker" bind:value={characterDraft.value.voicevoxConfig.speaker}>
        {#await getVOICEVOXVoices() then voices}
          {#each voices as voice}
            <OptionInput value={voice.list} selected={characterDraft.value.voicevoxConfig.speaker === voice.list}
              >{voice.name}</OptionInput>
          {/each}
        {/await}
      </SelectInput>
      {#if characterDraft.value.voicevoxConfig.speaker}
        <span class="text=neutral-200">Style</span>
        <SelectInput className="mb-4 mt-2" ariaLabel="Style" bind:value={characterDraft.value.ttsSpeech}>
          {#each voicevoxStyles(characterDraft.value.voicevoxConfig.speaker) as styles}
            <OptionInput value={styles.id} selected={characterDraft.value.ttsSpeech === styles.id}
              >{styles.name}</OptionInput>
          {/each}
        </SelectInput>
      {/if}
      <span class="text-textcolor">Speed scale</span>
      <NumberInput
        size={'sm'}
        marginBottom
        ariaLabel="Speed scale"
        bind:value={characterDraft.value.voicevoxConfig.SPEED_SCALE} />

      <span class="text-textcolor">Pitch scale</span>
      <NumberInput
        size={'sm'}
        marginBottom
        ariaLabel="Pitch scale"
        bind:value={characterDraft.value.voicevoxConfig.PITCH_SCALE} />

      <span class="text-textcolor">Volume scale</span>
      <NumberInput
        size={'sm'}
        marginBottom
        ariaLabel="Volume scale"
        bind:value={characterDraft.value.voicevoxConfig.VOLUME_SCALE} />

      <span class="text-textcolor">Intonation scale</span>
      <NumberInput
        size={'sm'}
        marginBottom
        ariaLabel="Intonation scale"
        bind:value={characterDraft.value.voicevoxConfig.INTONATION_SCALE} />
      <span class="text-sm mb-2 text-textcolor2"
        >To use VOICEVOX, you need to run a colab and put the localtunnel URL in "Settings → Other Bots".
        https://colab.research.google.com/drive/1tyeXJSklNfjW-aZJAib1JfgOMFarAwze</span>
    {:else if characterDraft.value.ttsMode === 'novelai'}
      <span class="text-textcolor">{language.ttsCustomVoiceSeed}</span>
      <Check bind:check={characterDraft.value.naittsConfig.customvoice} name={language.ttsCustomVoiceSeed} hiddenName />
      {#if !characterDraft.value.naittsConfig.customvoice}
        <span class="text-textcolor">Voice</span>
        <SelectInput className="mb-4 mt-2" ariaLabel="Voice" bind:value={characterDraft.value.naittsConfig.voice}>
          {#await getNovelAIVoices() then voices}
            {#each voices as voiceGroup}
              <optgroup label={voiceGroup.gender} class="bg-darkbg appearance-none">
                {#each voiceGroup.voices as voice}
                  <OptionInput value={voice} selected={characterDraft.value.naittsConfig.voice === voice}
                    >{voice}</OptionInput>
                {/each}
              </optgroup>
            {/each}
          {/await}
        </SelectInput>
      {:else}
        <span class="text-textcolor">Voice</span>
        <TextInput size={'sm'} ariaLabel="Voice" bind:value={characterDraft.value.naittsConfig.voice} />
      {/if}
      <span class="text-textcolor">Version</span>
      <SelectInput className="mb-4 mt-2" ariaLabel="Version" bind:value={characterDraft.value.naittsConfig.version}>
        <OptionInput value="v1">v1</OptionInput>
        <OptionInput value="v2">v2</OptionInput>
      </SelectInput>
    {:else if characterDraft.value.ttsMode === 'openai'}
      <span class="text-textcolor">Voice</span>
      {#if !characterDraft.value.oaiTTSConfig?.enabled}
        <SelectInput className="mb-4 mt-2" ariaLabel="Voice" bind:value={characterDraft.value.oaiVoice}>
          <OptionInput value="">Unset</OptionInput>
          {#each oaiVoices as voice}
            <OptionInput value={voice}>{voice}</OptionInput>
          {/each}
        </SelectInput>
      {:else}
        <TextInput
          className="mb-4 mt-2"
          ariaLabel="Voice"
          bind:value={characterDraft.value.oaiTTSConfig.voice}
          placeholder={characterDraft.value.oaiVoice || 'alloy'} />
      {/if}

      <span class="text-textcolor">{language.ttsAdvancedEndpoint}</span>
      <Check bind:check={characterDraft.value.oaiTTSConfig.enabled} name={language.ttsAdvancedEndpoint} hiddenName />

      {#if characterDraft.value.oaiTTSConfig?.enabled}
        <span class="text-textcolor">Base URL</span>
        <TextInput
          className="mb-4 mt-2"
          ariaLabel="Base URL"
          bind:value={characterDraft.value.oaiTTSConfig.baseURL}
          placeholder="https://api.openai.com/v1" />

        <span class="text-textcolor">API Key (overrides global)</span>
        <SecretInput
          className="mb-4 mt-2"
          ariaLabel="API Key (overrides global)"
          ownerKey={characterDraft.value.chaId}
          bind:value={characterDraft.value.oaiTTSConfig.apiKey}
          placeholder="Leave empty to use global OpenAI API key" />

        <span class="text-textcolor">Model</span>
        <TextInput
          className="mb-4 mt-2"
          ariaLabel="Model"
          bind:value={characterDraft.value.oaiTTSConfig.model}
          placeholder="tts-1" />

        <span class="text-textcolor">Response Format</span>
        <SelectInput
          className="mb-4 mt-2"
          ariaLabel="Response Format"
          bind:value={characterDraft.value.oaiTTSConfig.format}>
          <OptionInput value="mp3">mp3</OptionInput>
          <OptionInput value="opus">opus</OptionInput>
          <OptionInput value="aac">aac</OptionInput>
          <OptionInput value="flac">flac</OptionInput>
          <OptionInput value="wav">wav</OptionInput>
          <OptionInput value="pcm">pcm</OptionInput>
        </SelectInput>
      {/if}
    {:else if characterDraft.value.ttsMode === 'huggingface'}
      <span class="text-textcolor">Model</span>
      <TextInput className="mb-4 mt-2" ariaLabel="Model" bind:value={characterDraft.value.hfTTS.model} />

      <span class="text-textcolor">Language</span>
      <TextInput
        className="mb-4 mt-2"
        ariaLabel="Language"
        bind:value={characterDraft.value.hfTTS.language}
        placeholder="en" />
    {:else if characterDraft.value.ttsMode === 'vits'}
      {#if characterDraft.value.vits}
        <span class="text-textcolor">{characterDraft.value.vits.name ?? 'Unnamed VitsModel'}</span>
      {:else}
        <span class="text-textcolor">No Model</span>
      {/if}
      <Button onclick={registerVitsModelFromEditor}>{language.selectModel}</Button>
    {:else if characterDraft.value.ttsMode === 'gptsovits'}
      <span class="text-textcolor">{language.ttsVolume}</span>
      <SliderInput
        min={0.0}
        max={1.0}
        step={0.01}
        fixed={2}
        bind:value={characterDraft.value.gptSoVitsConfig.volume}
        ariaLabel={language.ttsVolume} />
      <span class="text-textcolor">URL</span>
      <TextInput className="mb-4 mt-2" ariaLabel="URL" bind:value={characterDraft.value.gptSoVitsConfig.url} />

      <span class="text-textcolor">{language.ttsUseAutoPath}</span>
      <Check
        bind:check={characterDraft.value.gptSoVitsConfig.use_auto_path}
        name={language.ttsUseAutoPath}
        hiddenName />

      {#if !characterDraft.value.gptSoVitsConfig.use_auto_path}
        <span class="text-textcolor">Reference Audio Path (e.g. C:/Users/user/Downloads/GPT-SoVITS-v2-240821)</span>
        <TextInput
          className="mb-4 mt-2"
          ariaLabel="Reference Audio Path"
          bind:value={characterDraft.value.gptSoVitsConfig.ref_audio_path} />
      {/if}

      <span class="text-textcolor">{language.ttsUseLongAudio}</span>
      <Check
        bind:check={characterDraft.value.gptSoVitsConfig.use_long_audio}
        name={language.ttsUseLongAudio}
        hiddenName />

      <span class="text-textcolor">Reference Audio Data (3~10s audio file)</span>
      <Button onclick={uploadGptSoVitsReferenceAudioFromEditor} className="h-10">
        {#if characterDraft.value.gptSoVitsConfig.ref_audio_data.assetId === '' || characterDraft.value.gptSoVitsConfig.ref_audio_data.assetId === undefined}
          {language.selectFile}
        {:else}
          {characterDraft.value.gptSoVitsConfig.ref_audio_data.fileName}
        {/if}
      </Button>
      <span class="text-textcolor">Text Language</span>
      <SelectInput
        className="mb-4 mt-2"
        ariaLabel="Text Language"
        bind:value={characterDraft.value.gptSoVitsConfig.text_lang}>
        <OptionInput value="auto">Multi-language Mixed</OptionInput>
        <OptionInput value="auto_yue">Multi-language Mixed (Cantonese)</OptionInput>
        <OptionInput value="en">English</OptionInput>
        <OptionInput value="zh">Chinese-English Mixed</OptionInput>
        <OptionInput value="ja">Japanese-English Mixed</OptionInput>
        <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
        <OptionInput value="ko">Korean-English Mixed</OptionInput>
        <OptionInput value="all_zh">Chinese</OptionInput>
        <OptionInput value="all_ja">Japanese</OptionInput>
        <OptionInput value="all_yue">Cantonese</OptionInput>
        <OptionInput value="all_ko">Korean</OptionInput>
      </SelectInput>

      {#if !characterDraft.value.gptSoVitsConfig.use_long_audio}
        <span class="text-textcolor">{language.ttsUseReferenceAudioScript}</span>
        <Check
          bind:check={characterDraft.value.gptSoVitsConfig.use_prompt}
          name={language.ttsUseReferenceAudioScript}
          hiddenName />
      {/if}

      {#if characterDraft.value.gptSoVitsConfig.use_prompt && !characterDraft.value.gptSoVitsConfig.use_long_audio}
        <span class="text-textcolor">Reference Audio Script</span>
        <TextAreaInput
          className="mb-4 mt-2"
          ariaLabel="Reference Audio Script"
          bind:value={characterDraft.value.gptSoVitsConfig.prompt} />
      {/if}

      <span class="text-textcolor">Reference Audio Language</span>
      <SelectInput
        className="mb-4 mt-2"
        ariaLabel="Reference Audio Language"
        bind:value={characterDraft.value.gptSoVitsConfig.prompt_lang}>
        <OptionInput value="auto">Multi-language Mixed</OptionInput>
        <OptionInput value="auto_yue">Multi-language Mixed (Cantonese)</OptionInput>
        <OptionInput value="en">English</OptionInput>
        <OptionInput value="zh">Chinese-English Mixed</OptionInput>
        <OptionInput value="ja">Japanese-English Mixed</OptionInput>
        <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
        <OptionInput value="ko">Korean-English Mixed</OptionInput>
        <OptionInput value="all_zh">Chinese</OptionInput>
        <OptionInput value="all_ja">Japanese</OptionInput>
        <OptionInput value="all_yue">Cantonese</OptionInput>
        <OptionInput value="all_ko">Korean</OptionInput>
      </SelectInput>
      <span class="text-textcolor">{language.modelProfiles.runtimeFields.topP}</span>
      <SliderInput
        min={0.0}
        max={1.0}
        step={0.05}
        fixed={2}
        bind:value={characterDraft.value.gptSoVitsConfig.top_p}
        ariaLabel={language.modelProfiles.runtimeFields.topP} />

      <span class="text-textcolor">{language.temperature}</span>
      <SliderInput
        min={0.0}
        max={1.0}
        step={0.05}
        fixed={2}
        bind:value={characterDraft.value.gptSoVitsConfig.temperature}
        ariaLabel={language.temperature} />

      <span class="text-textcolor">{language.ttsSpeed}</span>
      <SliderInput
        min={0.6}
        max={1.65}
        step={0.05}
        fixed={2}
        bind:value={characterDraft.value.gptSoVitsConfig.speed}
        ariaLabel={language.ttsSpeed} />

      <span class="text-textcolor">{language.modelProfiles.runtimeFields.topK}</span>
      <SliderInput
        min={1}
        max={100}
        step={1}
        bind:value={characterDraft.value.gptSoVitsConfig.top_k}
        ariaLabel={language.modelProfiles.runtimeFields.topK} />

      <span class="text-textcolor">Text Split Method</span>
      <SelectInput
        className="mb-4 mt-2"
        ariaLabel="Text Split Method"
        bind:value={characterDraft.value.gptSoVitsConfig.text_split_method}>
        <OptionInput value="cut0">Cut 0 (No splitting)</OptionInput>
        <OptionInput value="cut1">Cut 1 (Split every 4 sentences)</OptionInput>
        <OptionInput value="cut2">Cut 2 (Split every 50 characters)</OptionInput>
        <OptionInput value="cut3">Cut 3 (Split by Chinese periods)</OptionInput>
        <OptionInput value="cut4">Cut 4 (Split by English periods)</OptionInput>
        <OptionInput value="cut5">Cut 5 (Split by various punctuation marks)</OptionInput>
      </SelectInput>
    {:else if characterDraft.value.ttsMode === 'fishspeech'}
      {#await loadFishSpeechModelsIntoEditor()}
        <span class="text-textcolor">Loading...</span>
      {:then}
        <span class="text-textcolor">Model</span>
        <SelectInput
          className="mb-4 mt-2"
          ariaLabel="Model"
          bind:value={characterDraft.value.fishSpeechConfig.model._id}>
          <OptionInput value="">Not selected</OptionInput>
          {#each fishSpeechModels as model}
            <OptionInput value={model._id}>
              <div class="flex items-center">
                <span>{model.title}</span>
                <span class="text-sm text-textcolor2">{model.description}</span>
              </div>
            </OptionInput>
          {/each}
        </SelectInput>
      {:catch}
        <span class="text-textcolor">{language.ttsCatalogError}</span>
      {/await}

      <span class="text-textcolor">Chunk Length</span>
      <NumberInput
        className="mb-4 mt-2"
        ariaLabel="Chunk Length"
        bind:value={characterDraft.value.fishSpeechConfig.chunk_length} />

      <span class="mt-2 text-textcolor">{language.ttsNormalize}</span>
      <Check
        className="mb-4 mt-2"
        bind:check={characterDraft.value.fishSpeechConfig.normalize}
        name={language.ttsNormalize}
        hiddenName />
    {/if}
    {#if characterDraft.value.ttsMode}
      <div class="flex items-center mt-2">
        <Check bind:check={characterDraft.value.ttsReadOnlyQuoted} name={language.ttsReadOnlyQuoted} />
      </div>
    {/if}
  {/if}
{:else if $CharConfigSubMenu === 2}
  {#if !$MobileGUI}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.advancedSettings}</h2>
  {/if}
  <span class="text-textcolor mt-2">Bias <Help key="bias" /></span>
  <div class="w-full max-w-full border border-selected rounded-md p-2 mb-2">
    <table class="w-full max-w-full tabler mt-2">
      <tbody>
        <tr>
          <th class="font-medium w-1/2">Bias</th>
          <th class="font-medium w-1/3">{language.value}</th>
          <th>
            <button
              class="font-medium cursor-pointer hover:text-green-500"
              aria-label={`${language.add}: Bias`}
              onclick={() => {
                if (currentRealCharacterDraftTarget()) {
                  characterDraft.value.bias.push(['', 0])
                  characterDraft.value = { ...characterDraft.value }
                }
              }}><PlusIcon /></button>
          </th>
        </tr>
        {#if characterDraft.value.bias.length === 0}
          <tr>
            <td colspan="3">{language.noBias}</td>
          </tr>
        {/if}
        {#each characterDraft.value.bias as bias, i}
          <tr class="align-middle text-center">
            <td class="font-medium truncate w-1/2">
              <TextInput
                fullh
                fullwidth
                ariaLabel={`Bias ${i + 1}`}
                bind:value={characterDraft.value.bias[i][0]}
                placeholder="string" />
            </td>
            <td class="font-medium truncate w-1/3">
              <NumberInput
                fullh
                fullwidth
                ariaLabel={`${language.value} ${i + 1}`}
                bind:value={characterDraft.value.bias[i][1]}
                max={100}
                min={-100} />
            </td>
            <td>
              <button
                class="font-medium flex justify-center items-center w-full h-full cursor-pointer hover:text-green-500"
                aria-label={`${language.remove}: Bias ${i + 1}`}
                onclick={() => {
                  if (currentRealCharacterDraftTarget()) {
                    characterDraft.value.bias.splice(i, 1)
                    characterDraft.value = { ...characterDraft.value }
                  }
                }}><TrashIcon /></button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <span class="text-textcolor">{language.exampleMessage} <Help key="exampleMessage" /></span>
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    ariaLabel={language.exampleMessage}
    bind:value={characterDraft.value.exampleMessage}></TextAreaInput>

  <span class="text-textcolor">{language.creatorNotes} <Help key="creatorQuotes" /></span>
  <MultiLangInput
    bind:value={characterDraft.value.creatorNotes}
    className="my-2"
    onInput={() => {
      updateCharacterDraft((character) => {
        character.removedQuotes = false
      })
    }}></MultiLangInput>

  <span class="text-textcolor">{language.systemPrompt} <Help key="systemPrompt" /></span>
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    ariaLabel={language.systemPrompt}
    bind:value={characterDraft.value.systemPrompt}></TextAreaInput>

  <span class="text-textcolor">{language.replaceGlobalNote} <Help key="replaceGlobalNote" /></span>
  <TextAreaInput
    highlight
    margin="both"
    autocomplete="off"
    ariaLabel={language.replaceGlobalNote}
    bind:value={characterDraft.value.replaceGlobalNote}></TextAreaInput>

  {#if typeof characterDraft.value.additionalText === 'string' && characterDraft.value.additionalText.length > 0}
    <div class="my-2" data-risu-additional-text-unsupported="true">
      <span class="text-textcolor">{language.additionalText} <Help key="additionalText" /></span>
      <p class="text-sm text-textcolor2">{language.additionalTextUnsupported}</p>
    </div>
  {/if}

  {#if showUnrecommended || characterDraft.value.personality.length > 3}
    <span class="text-textcolor">{language.personality} <Help key="personality" unrecommended /></span>
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      ariaLabel={language.personality}
      bind:value={characterDraft.value.personality}></TextAreaInput>
  {/if}
  {#if showUnrecommended || characterDraft.value.scenario.length > 3}
    <span class="text-textcolor">{language.scenario} <Help key="scenario" unrecommended /></span>
    <TextAreaInput
      highlight
      margin="both"
      autocomplete="off"
      ariaLabel={language.scenario}
      bind:value={characterDraft.value.scenario}></TextAreaInput>
  {/if}

  <span class="text-textcolor mt-2">{language.defaultVariables} <Help key="defaultVariables" /></span>
  <TextAreaInput
    margin="both"
    autocomplete="off"
    ariaLabel={language.defaultVariables}
    bind:value={characterDraft.value.defaultVariables}></TextAreaInput>

  <span class="text-textcolor mt-2">{language.translatorNote} <Help key="translatorNote" /></span>
  <TextAreaInput
    margin="both"
    autocomplete="off"
    ariaLabel={language.translatorNote}
    bind:value={characterDraft.value.translatorNote}></TextAreaInput>

  <span class="text-textcolor">{language.creator}</span>
  <TextInput
    size="sm"
    autocomplete="off"
    ariaLabel={language.creator}
    bind:value={characterDraft.value.additionalData.creator} />

  <span class="text-textcolor">{language.CharVersion}</span>
  <TextInput
    size="sm"
    ariaLabel={language.CharVersion}
    bind:value={characterDraft.value.additionalData.character_version} />

  <span class="text-textcolor">{language.nickname} <Help key="nickname" /></span>
  <TextInput size="sm" ariaLabel={language.nickname} bind:value={characterDraft.value.nickname} />

  <span class="text-textcolor">{language.depthPrompt}</span>
  <div class="flex justify-center items-center">
    <NumberInput
      size="sm"
      ariaLabel={`${language.depthPrompt}: ${language.depth}`}
      bind:value={characterDraft.value.depth_prompt.depth}
      className="w-12" />
    <TextInput
      size="sm"
      ariaLabel={`${language.depthPrompt}: ${language.prompt}`}
      bind:value={characterDraft.value.depth_prompt.prompt}
      className="flex-1" />
  </div>

  <span class="text-textcolor mt-2">{language.altGreet}</span>
  <div class="w-full max-w-full border border-selected rounded-md p-2" aria-busy={alternateGreetingMutationPending}>
    {#if alternateGreetingMutationStatus === 'failed'}
      <p class="text-red-500 text-sm" role="alert">{language.alternateGreetingMutationFailed}</p>
    {/if}
    <table class="contain w-full max-w-full tabler mt-2">
      <tbody>
        <tr>
          <th class="font-medium">{language.value}</th>
          <th class="font-medium cursor-pointer w-8">
            <button
              class="hover:text-green-500"
              aria-label={`${language.add}: ${language.altGreet}`}
              onclick={() => {
                if (currentRealCharacterDraftTarget()) {
                  let alternateGreetings = characterDraft.value.alternateGreetings
                  alternateGreetings.push('')
                  characterDraft.value.alternateGreetings = alternateGreetings
                  characterDraft.value = { ...characterDraft.value }
                }
              }}>
              <PlusIcon />
            </button>
          </th>
        </tr>
        {#if characterDraft.value.alternateGreetings.length === 0}
          <tr>
            <td colspan="3">{language.noData}</td>
          </tr>
        {/if}
        {#each characterDraft.value.alternateGreetings as bias, i}
          <tr>
            <td class="font-medium truncate">
              <TextAreaInput
                highlight
                ariaLabel={`${language.altGreet} ${i + 1}`}
                bind:value={characterDraft.value.alternateGreetings[i]}
                placeholder="..."
                fullwidth />
            </td>
            <th class="font-medium cursor-pointer w-8">
              <div class="flex flex-col items-center">
                <button
                  class="hover:text-blue-500 p-1"
                  aria-label={`${language.moveUp}: ${language.altGreet} ${i + 1}`}
                  onclick={() => moveAlternateGreetingUp(i)}
                  disabled={alternateGreetingMutationPending || i === 0}>
                  <ArrowUp size={16} />
                </button>
                <button
                  class="hover:text-blue-500 p-1"
                  aria-label={`${language.moveDown}: ${language.altGreet} ${i + 1}`}
                  onclick={() => moveAlternateGreetingDown(i)}
                  disabled={alternateGreetingMutationPending ||
                    i === characterDraft.value.alternateGreetings.length - 1}>
                  <ArrowDown size={16} />
                </button>
                <button
                  class="hover:text-red-500 p-1"
                  aria-label={`${language.remove}: ${language.altGreet} ${i + 1}`}
                  disabled={alternateGreetingMutationPending}
                  onclick={() => {
                    void applyAlternateGreetingMutation({ type: 'delete', index: i })
                  }}>
                  <TrashIcon size={16} />
                </button>
              </div>
            </th>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="flex items-center mt-4">
    <Check bind:check={characterDraft.value.lowLevelAccess} name={language.lowLevelAccess} />
    <span> <Help key="lowLevelAccess" name={language.lowLevelAccess} /></span>
  </div>

  <div class="mt-4">
    <ScriptModelOverrideSelectors bind:value={characterDraft.value.scriptModelOverrides} />
  </div>

  <div class="flex items-center mt-4">
    <Check bind:check={characterDraft.value.hideChatIcon} name={language.hideChatIcon} />
  </div>

  <div class="flex items-center mt-4">
    <Check bind:check={characterDraft.value.utilityBot} name={language.utilityBot} />
    <span> <Help key="utilityBot" name={language.utilityBot} /></span>
  </div>

  <div class="flex items-center mt-4">
    <Check bind:check={characterDraft.value.escapeOutput} name={language.escapeOutput} />
  </div>

  {#if hypaV3Enabled}
    <Button
      onclick={() => {
        $hypaV3ModalOpen = true
      }}
      className="mt-4">
      {language.hypaMemoryV3Modal}
    </Button>
  {/if}

  <Button onclick={applyModule} className="mt-4">
    {language.applyModule}
  </Button>
{/if}

<style>
  .tabler {
    table-layout: fixed;
  }

  .tabler td {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
