import type {
  MODEL_PRESET_FIELDS,
  PROMPT_PRESET_FIELDS,
  PROMPT_PRESET_MODEL_OVERRIDE_FIELDS,
} from '@risuai/shared-core/preset-split'
import type { ChatGenerationSettings } from '@risuai/shared-core/chat-generation-settings'
import type { AgentRecord, AgentPresetRecord } from '@risuai/shared-core/agent-preset-records'
import type {
  ModelProfileRecord,
  ModelProfileRecordRuntimeOptions,
  ModelProfileRecordProviderOptions,
  ModelRoleProfileMap,
} from '@risuai/shared-core/model-profile-records'
import type { ProviderCredentialRecord } from '@risuai/shared-core/provider-credential-records'
import type {
  LegacyFallbackModelMap,
  LegacySeperateModelMap,
  NormalizedModelRoleOverrides,
} from '@risuai/shared-core/model-roles'
import type { LLMFormat, LLMTokenizer, LLMFlags } from '@risuai/shared-core/model-types'
import type { ScriptModelOverrides } from '@risuai/shared-core/script-model-overrides'
import type { BardWikiGlobalSettings } from '@risuai/protocol'
import type { HypaV3Settings } from '../memoryPlanner.js'
import type { ServerModule, ServerModuleRegexScript, ServerModuleLorebook } from './moduleDescriptors.js'
import type { ServerTriggerScript } from './triggerDescriptors.js'
import type { PromptTemplateCard } from './promptTemplate.js'
import type { PromptMessage } from './promptMessage.js'

/** Optional fields and supported legacy null clears retain downstream defaults and preset precedence. */
export type GenerationSettings = {
  adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  additionalParams?: [string, string][]
  additionalPrompt?: string
  agentPresetDefaultId?: string
  agentPresets?: AgentPresetRecord[]
  agents?: AgentRecord[]
  aiModel?: string
  applyAdditionalParamsToAll?: boolean
  autofillRequestUrl?: boolean
  automaticCachePoint?: boolean
  banCharacterset?: string[]
  bardWiki?: BardWikiGlobalSettings
  bias?: [string, number][]
  chainOfThought?: boolean
  claude1HourCaching?: boolean
  claudeAPIKey?: string
  cohereAPIKey?: string
  complexRegexCompatibilityMode?: 'strict' | 'worker'
  complexRegexDisplayTimeoutMs?: number
  complexRegexInputTimeoutMs?: number
  complexRegexOutputTimeoutMs?: number
  customAPIFormat?: LLMFormat
  customFlags?: LLMFlags[]
  customModels?: {
    id: string
    internalId: string
    url: string
    format: LLMFormat
    tokenizer: LLMTokenizer
    key: string
    name: string
    params?: string
    flags: LLMFlags[]
  }[]
  customProxyRequestModel?: string
  customTokenizer?: string
  dallEQuality?: string
  deepseekReasoningEffort?: 'high' | 'max'
  deepseekThinkingType?: 'off' | 'enabled'
  descriptionPrefix?: string
  dynamicAssets?: boolean
  dynamicAssetsEditDisplay?: boolean
  dynamicOutput?: ServerDynamicOutput | null
  echoDelay?: number
  echoMessage?: string
  enableCustomFlags?: boolean
  enabledModules?: string[]
  extractJson?: string
  fallbackModels?: Partial<LegacyFallbackModelMap>
  fallbackWhenBlankResponse?: boolean
  falLora?: string
  falLoraScale?: number
  falModel?: string
  forceReplaceUrl?: string
  formatingOrder?: Array<
    | 'main'
    | 'jailbreak'
    | 'chats'
    | 'lorebook'
    | 'globalNote'
    | 'authorNote'
    | 'lastChat'
    | 'description'
    | 'postEverything'
    | 'personaPrompt'
  >
  frequencyPenalty?: number
  generationSeed?: number
  genTime?: number
  globalChatVariables?: { [key: string]: string }
  globalNote?: string
  globalscript?: ServerModuleRegexScript[]
  google?: {
    accessToken?: string
    projectId?: string
  }
  googleClaudeTokenizing?: boolean
  gptVisionQuality?: string
  groupOtherBotRole?: string
  groupTemplate?: string
  halfStreaming?: boolean
  hordeConfig?: ServerHordeConfig
  hypaCustomSettings?: {
    url: string
    key: string
    model: string
  }
  hypaModel?: string
  hypaV3?: boolean
  hypaV3Key?: string
  hypaV3Presets?: Array<{ id: string; name: string; settings: Partial<HypaV3Settings> }>
  ImagenAspectRatio?: string
  ImagenImageSize?: string
  ImagenModel?: string
  ImagenPersonGeneration?: string
  instructChatTemplate?: string
  jailbreak?: string
  jailbreakToggle?: boolean
  JinjaTemplate?: string
  jsonSchema?: string
  jsonSchemaEnabled?: boolean
  koboldURL?: string
  localStopStrings?: string[] | null
  loreBookDepth?: number
  loreBookToken?: number
  mainPrompt?: string
  mancerHeader?: string
  maxContext?: number
  maxResponse?: number
  min_p?: number
  mistralKey?: string
  modelPresets?: ServerModelPreset[]
  modelPresetsId?: number
  modelProfiles?: ServerModelProfile[]
  modelRoleProfiles?: Partial<ModelRoleProfileMap>
  modelRoles?: Partial<NormalizedModelRoleOverrides>
  modelRuntimeDefaults?: ServerModelRuntimeOptions
  modelTools?: string[]
  moduleIntergration?: string
  modules?: ServerModule[]
  NAII2I?: boolean
  NAIImgConfig?: Partial<ServerNAIImgConfig>
  NAIImgModel?: string
  nanogptKey?: string
  nanogptProvider?: string
  nanogptRequestModel?: string
  nanogptRequestModelName?: string
  nanogptSubscriptionState?: string
  nanogptUseSubscriptionEndpoint?: boolean
  newOAIHandle?: boolean
  OaiCompAPIKeys?: { [key: string]: string }
  OAIPrediction?: string
  ollamaApiKey?: string
  ollamaCloudModel?: string
  ollamaCloudModelName?: string
  ollamaModel?: string
  ollamaModelName?: string
  ollamaModelSource?: 'local' | 'cloud'
  ollamaRequestFormat?: LLMFormat
  ollamaThinkingMode?: 'auto' | 'off' | 'on' | 'low' | 'medium' | 'high'
  ollamaURL?: string
  ooba?: ServerOobaSettings
  openAIFlexProcessing?: boolean
  openAIKey?: string
  openrouterFallback?: boolean
  openrouterKey?: string
  openrouterMiddleOut?: boolean
  openrouterProvider?: {
    order?: string[]
    only?: string[]
    ignore?: string[]
  }
  openrouterRequestModel?: string
  outputImageModal?: boolean
  personaPrompt?: string
  personas?: ServerPersona[]
  PresensePenalty?: number
  presetRegex?: ServerModuleRegexScript[]
  promptInfoInsideChat?: boolean
  promptPreprocess?: boolean
  promptPresets?: ServerPromptPreset[]
  promptPresetsId?: number
  promptSettings?: ServerPromptSettings | null
  promptTemplate?: PromptTemplateCard[] | null
  promptTextInfoInsideChat?: boolean
  providerCredentials?: ProviderCredentialRecord[]
  proxyKey?: string
  reasoningEffort?: number
  regexOutputSizeLimitMiB?: number
  removeIncompleteResponse?: boolean
  repetition_penalty?: number
  requestHistoryLimit?: number
  requestRetrys?: number
  reverseProxyOobaArgs?: ServerOobaChatCompletionRequestParams | null
  reverseProxyOobaMode?: boolean
  sdConfig?: ServerSdConfig
  sdProvider?: string
  selectedHypaV3PresetId?: string | null
  selectedPersona?: number
  selectedPersonaId?: string | null
  seperateModels?: Partial<LegacySeperateModelMap> | null
  seperateModelsForAxModels?: boolean
  seperateParameters?: ServerSeparateParameterSettings
  seperateParametersByModel?: boolean
  seperateParametersEnabled?: boolean
  stabilityModel?: string
  stabllityStyle?: string
  streamGeminiThoughts?: boolean
  strictJsonSchema?: boolean
  systemContentReplacement?: string
  systemRoleReplacement?: 'user' | 'assistant'
  temperature?: number
  templateDefaultVariables?: string
  textgenWebUIBlockingURL?: string
  thinkingTokens?: number | null
  thinkingType?: 'off' | 'budget' | 'adaptive'
  top_a?: number
  top_k?: number
  top_p?: number
  ttsAutoSpeech?: boolean
  username?: string
  useSayNothing?: boolean
  useStreaming?: boolean
  verbosity?: number
  vertexClientEmail?: string
  vertexPrivateKey?: string
  vertexRegion?: string
  voyageApiKey?: string
  wavespeedImage?: {
    key: string
    model: string
    loras: Array<{ path: string; scale: number }>
    reference_mode: string
    reference_image: string
    reference_base64image: string
  }
  subModel?: string
  language?: string
  userIcon?: string
  userNote?: string
  customPromptTemplateToggle?: string
}

/** A request-local selected-owner view, never the persistence authority. */
export type FastifyDatabase = WorkingGenerationSettings & { characters: FastifyCharacter[]; currentChar?: number }
/**
 * Display projection validates a separately selected graph. Its collections
 * contain only the prompt/persona owners and executable modules that can
 * affect the selected chat; unrelated collection rows never enter this view.
 */
export type DisplaySourceDatabase = {
  characters: FastifyCharacter[]
  currentChar?: number
  agentPresetDefaultId?: string
  agentPresets?: AgentPresetRecord[]
  dynamicAssets?: boolean
  dynamicAssetsEditDisplay?: boolean
  enabledModules?: string[]
  globalChatVariables?: { [key: string]: string }
  globalscript?: ServerModuleRegexScript[]
  moduleIntergration?: string
  modules?: DeepReadonly<ServerModule>[]
  personaPrompt?: string
  personas?: DeepReadonly<ServerPersona>[]
  presetRegex?: ServerModuleRegexScript[]
  promptPresets?: DeepReadonly<ServerPromptPreset>[]
  selectedPersona?: number
  selectedPersonaId?: string | null
  templateDefaultVariables?: string
  username?: string
}
export type ServerModelPreset = Pick<
  GenerationSettings,
  Extract<(typeof MODEL_PRESET_FIELDS)[number], keyof GenerationSettings>
> & { id: string; name?: string; reasonEffort?: number }
export type ServerPromptPreset = Pick<
  GenerationSettings,
  Extract<
    (typeof PROMPT_PRESET_FIELDS)[number] | (typeof PROMPT_PRESET_MODEL_OVERRIDE_FIELDS)[number],
    keyof GenerationSettings
  >
> & {
  id: string
  name?: string
  archived?: boolean
  overrideModelParameters?: boolean
  overrideModelOthers?: boolean
  recommendedModelPresetId?: string | null
  regex?: ServerModuleRegexScript[]
  reasonEffort?: number
}
export type ServerPersona = {
  id: string
  name?: string
  displayName?: string
  icon?: string
  personaPrompt?: string
  note?: string
  largePortrait?: boolean
  modules?: string[]
}
export type GenerationPreflightCharacter = Pick<FastifyCharacter, 'chaId' | 'modules' | 'supaMemory'>
export type GenerationPreflightChat = Pick<
  FastifyChat,
  'id' | 'generationSettings' | 'hypaContextTruncationAcknowledged' | 'modules'
>
export type GenerationPreflightInputs = {
  database: GenerationPreflightSettings
  currentChar: GenerationPreflightCharacter
  currentChat: GenerationPreflightChat
}

export type FastifyCharacter = {
  type?: 'character'
  name: string
  firstMessage: string
  desc: string
  notes: string
  chats: FastifyChat[]
  chatFolders: Array<{ id: string; name?: string; color?: string; folded: boolean }>
  chatPage: number
  viewScreen: 'emotion' | 'none' | 'imggen'
  bias: Array<[string, number]>
  emotionImages: Array<[string, string]>
  globalLore: FastifyLoreBook[]
  chaId: string
  sdData: Array<[string, string]>
  customscript: FastifyCustomScript[]
  utilityBot: boolean
  exampleMessage: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  alternateGreetings: string[]
  tags: string[]
  creator: string
  characterVersion: string
  personality: string
  scenario: string
  firstMsgIndex: number
  replaceGlobalNote: string
  additionalText: string
  defaultVariables?: string
  triggerscript: ServerTriggerScript[]
  inlayViewScreen?: boolean
  newGenData?: { prompt: string; negative: string; instructions: string; emotionInstructions: string }
  displayName?: string
  image?: string
  nickname?: string
  supaMemory?: boolean
  additionalAssets?: Array<[string, string, string]>
  lowLevelAccess?: boolean
  modules?: string[]
  scriptModelOverrides?: ScriptModelOverrides
  scriptstate?: Record<string, string | number | boolean>
  loreSettings?: { tokenBudget: number; scanDepth: number; recursiveScanning: boolean; fullWordMatching?: boolean }
  depth_prompt?: { depth: number; prompt: string }
  backgroundHTML?: string
  backgroundCSS?: string
  removedQuotes?: boolean
  escapeOutput?: boolean
  doNotChangeSeperateModels?: boolean
  prebuiltAssetCommand?: boolean | string
  prebuiltAssetStyle?: string
  prebuiltAssetExclude?: string[]
  extentions?: Record<string, unknown>
}

export type FastifyChat = {
  message: FastifyMessage[]
  note: string
  name: string
  localLore: FastifyLoreBook[]
  generationSettings?: ChatGenerationSettings
  sdData?: string
  lastMemory?: string
  hypaContextTruncationAcknowledged?: boolean
  suggestMessages?: string[]
  isStreaming?: boolean
  scriptstate?: { [key: string]: string | number | boolean }
  modules?: string[]
  id?: string
  bindedPersona?: string
  fmIndex?: number
  selectedDraftHookId?: string
  translatorPresetId?: string
  autoTranslate?: boolean
  autoTranslateBotOnly?: boolean
  bilingualDisplay?: boolean
  bilingualEmphasis?: 'original' | 'translation'
  hypaV3Data?: ServerSerializableHypaV3Data
  folderId?: string | null
  lastDate?: number
  bookmarks?: string[]
  bookmarkNames?: { [chatId: string]: string }
  pinned?: boolean
}

export type FastifyMessage = {
  role: 'user' | 'char'
  data: string
  translation?: FastifyMessageTranslation | null
  saying?: string
  chatId?: string
  time?: number | null
  generationInfo?: FastifyMessageGenerationInfo
  promptInfo?: FastifyMessagePresetInfo
  name?: string | null
  otherUser?: boolean
  disabled?: false | true | 'allBefore'
  isComment?: boolean
}

export type ServerDynamicOutput = {
  autoAdjustSchema?: boolean
  dynamicMessages?: boolean
  dynamicMemory?: boolean
  dynamicResponseTiming?: boolean
  dynamicOutputPrompt?: boolean
  showTypingEffect?: boolean
  dynamicRequest?: boolean
}

export type ServerSeparateParameters = {
  temperature?: number
  top_k?: number
  repetition_penalty?: number
  min_p?: number
  top_a?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  reasoning_effort?: number
  thinking_tokens?: number
  thinking_type?: 'off' | 'budget' | 'adaptive'
  deepseek_thinking_type?: 'off' | 'enabled'
  adaptive_thinking_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  deepseek_reasoning_effort?: 'high' | 'max'
  outputImageModal?: boolean
  verbosity?: number
}

export type ServerHordeConfig = {
  apiKey?: string
  model?: string
  softPrompt?: string
}

export type ServerSdConfig = {
  width: number
  height: number
  sampler_name: string
  script_name: string
  denoising_strength: number
  enable_hr: boolean
  hr_scale: number
  hr_upscaler: string
}

export type ServerNAIImgConfig = {
  width: number
  height: number
  sampler: string
  noise_schedule: string
  steps: number
  scale: number
  cfg_rescale: number
  sm: boolean
  sm_dyn: boolean
  noise: number
  strength: number
  image: string
  base64image: string
  InfoExtracted: number
  autoSmea: boolean
  use_coords: boolean
  legacy_uc: boolean
  v4_prompt: ServerNAIImgConfigV4Prompt
  v4_negative_prompt: ServerNAIImgConfigV4NegativePrompt
  reference_image_multiple?: string[]
  reference_strength_multiple?: number[]
  vibe_data?: ServerNAIVibeData
  vibe_model_selection?: string
  variety_plus: boolean
  decrisp: boolean
  reference_mode: string
  character_image: string
  character_base64image: string
  style_aware: boolean
}

export type ServerNAIImgConfigV4Prompt = {
  caption: ServerNAIImgConfigV4Caption
  use_coords: boolean
  use_order: boolean
}

export type ServerNAIImgConfigV4NegativePrompt = {
  caption: ServerNAIImgConfigV4Caption
  legacy_uc: boolean
}

export type ServerNAIImgConfigV4Caption = {
  base_caption: string
  char_captions: ServerNAIImgConfigV4CharCaption[]
}

export type ServerNAIImgConfigV4CharCaption = {
  char_caption: string
  centers: {
    x: number
    y: number
  }[]
}

export type ServerNAIVibeData = {
  identifier: string
  version: number
  type: string
  image: string
  id: string
  encodings: {
    [key: string]: {
      [key: string]: ServerNAIVibeEncoding
    }
  }
  name: string
  thumbnail: string
  createdAt: number
  importInfo: {
    model: string
    information_extracted: number
    strength: number
  }
}

export type ServerNAIVibeEncoding = {
  encoding: string
  params: {
    information_extracted: number
  }
}

export type ServerOobaSettings = {
  max_new_tokens?: number
  do_sample?: boolean
  temperature?: number
  top_p?: number
  typical_p?: number
  repetition_penalty?: number
  encoder_repetition_penalty?: number
  top_k?: number
  min_length?: number
  no_repeat_ngram_size?: number
  num_beams?: number
  penalty_alpha?: number
  length_penalty?: number
  early_stopping?: boolean
  seed?: number
  add_bos_token?: boolean
  truncation_length?: number
  ban_eos_token?: boolean
  skip_special_tokens?: boolean
  top_a?: number
  tfs?: number
  epsilon_cutoff?: number
  eta_cutoff?: number
  formating?: {
    header: string
    systemPrefix: string
    userPrefix: string
    assistantPrefix: string
    seperator: string
    useName: boolean
  }
}

export type FastifyMessageTranslation = {
  text: string
  source: 'raw'
  sourceHash: string
  targetLanguage: string
  inputLanguage: string
  translatorType: 'google' | 'deepl' | 'deeplX' | 'llm'
  settingsHash: string
  updatedAt: number
}

export type FastifyMessageGenerationInfo = {
  model?: string
  generationId?: string
  databaseLineage?: string
  operationId?: string
  acceptedMessageId?: string
  attemptNo?: number
  jobId?: string
  effectLedgerKeyType?: 'operation' | 'generation'
  effectLedgerKeyId?: string
  effectLedgerCharacterId?: string
  effectLedgerChatId?: string
  inputTokens?: number
  outputTokens?: number
  maxContext?: number
  agentPreset?: Record<string, unknown>
  stageTiming?: {
    stage1?: number
    stage2?: number
    stage3?: number
    stage4?: number
  }
}

export type FastifyMessagePresetInfo = {
  promptName?: string
  promptToggles?: { key: string; value: string }[]
  promptText?: PromptMessage[]
}

export type FastifyLoreBook = DeepReadonly<ServerModuleLorebook>
export type FastifyCustomScript = ServerModuleRegexScript
export type ServerSeparateParameterSettings = {
  memory?: ServerSeparateParameters
  emotion?: ServerSeparateParameters
  translate?: ServerSeparateParameters
  otherAx?: ServerSeparateParameters
  scriptMain?: ServerSeparateParameters
  scriptAux?: ServerSeparateParameters
  overrides?: Record<string, ServerSeparateParameters>
}
export type ServerPromptSettings = {
  assistantPrefill?: string
  postEndInnerFormat?: string
  sendChatAsSystem?: boolean
  sendName?: boolean
  utilOverride?: boolean
  customChainOfThought?: boolean
  maxThoughtTagDepth?: number
  trimStartNewChat?: boolean
}
export type ServerSerializableHypaV3Data = {
  summaries: Array<{ text: string; chatMemos: string[]; isImportant: boolean; categoryId?: string; tags?: string[] }>
  categories?: Array<{ id: string; name: string }>
  lastSelectedSummaries?: number[]
  metrics?: {
    lastImportantSummaries: number[]
    lastRecentSummaries: number[]
    lastSimilarSummaries: number[]
    lastRandomSummaries: number[]
  }
  modalSettings?: {
    displayMode: string
    displayRangeFrom: number
    displayRangeTo: number
    displayRecentCount: number
    displayImportant: boolean
    displaySelected: boolean
  }
}

export type ServerOobaChatCompletionRequestParams = {
  mode?: 'instruct' | 'chat' | 'chat-instruct'
  turn_template?: string
  name1_instruct?: string
  name2_instruct?: string
  context_instruct?: string
  system_message?: string
  name1?: string
  name2?: string
  context?: string
  greeting?: string
  chat_instruct_command?: string
  preset?: string
  tokenizer?: string
  min_p?: number
  top_k?: number
  repetition_penalty?: number
  repetition_penalty_range?: number
  typical_p?: number
  tfs?: number
  top_a?: number
  epsilon_cutoff?: number
  eta_cutoff?: number
  guidance_scale?: number
  negative_prompt?: string
  penalty_alpha?: number
  mirostat_mode?: number
  mirostat_tau?: number
  mirostat_eta?: number
  temperature_last?: boolean
  do_sample?: boolean
  seed?: number
  encoder_repetition_penalty?: number
  no_repeat_ngram_size?: number
  min_length?: number
  num_beams?: number
  length_penalty?: number
  early_stopping?: boolean
  truncation_length?: number
  max_tokens_second?: number
  custom_token_bans?: string
  auto_max_new_tokens?: boolean
  ban_eos_token?: boolean
  add_bos_token?: boolean
  skip_special_tokens?: boolean
  grammar_string?: string
}

export type ProviderGenerationSettings = WorkingGenerationSettings & {
  currentChar?: number
  characters?: Array<{ name?: string }>
}
export type MemoryGenerationSettings = WorkingGenerationSettings & {
  characters?: Array<{ chaId?: string; name?: string; chats?: Array<GenerationPreflightChat & { name?: string }> }>
}

/** Concrete known provider/runtime fields replace the shared validation-input unknowns. */
export type ServerModelRuntimeOptions = Omit<ModelProfileRecordRuntimeOptions, 'dynamicOutput'> & {
  dynamicOutput?: ServerDynamicOutput | null
}
export type ServerModelProviderOptions = Omit<ModelProfileRecordProviderOptions, 'reverseProxy'> & {
  reverseProxy?: {
    autofillRequestUrl?: boolean
    oobaSystemHoist?: boolean
    oobaArgs?: ServerOobaChatCompletionRequestParams | null
  }
}
export type ServerModelProfile = Omit<ModelProfileRecord, 'runtimeOptions' | 'providerOptions'> & {
  runtimeOptions?: ServerModelRuntimeOptions
  providerOptions?: ServerModelProviderOptions
}

/** Resolved configuration is a value graph; only working state owns mutations. */
export type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T
export type ResolvedGenerationSettings = DeepReadonly<GenerationSettings>

/** Request-owned scalar overlay; nested configuration remains readonly. */
export type WorkingGenerationSettings = Omit<
  { -readonly [Key in keyof ResolvedGenerationSettings]: ResolvedGenerationSettings[Key] },
  'globalChatVariables'
> & { globalChatVariables?: Record<string, string> }

/** Preflight needs module toggle metadata, without executable module bodies. */
export type GenerationPreflightModule = Pick<DeepReadonly<ServerModule>, 'id' | 'namespace' | 'customModuleToggle'>
export type GenerationConfigurationSettings<Module extends GenerationPreflightModule> = Omit<
  WorkingGenerationSettings,
  'modules'
> & { modules?: readonly Module[] }
export type GenerationPreflightSettings = GenerationConfigurationSettings<GenerationPreflightModule>
export type ResolvedGenerationConfigurationSettings<Module extends GenerationPreflightModule> = Omit<
  ResolvedGenerationSettings,
  'modules'
> & { readonly modules?: readonly Module[] }
