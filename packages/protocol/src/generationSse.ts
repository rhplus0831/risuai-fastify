import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

/**
 * Transport-neutral contract for `POST /api/v1/generate/chat` named SSE events.
 *
 * Event objects carry the discriminator as `type`. On the wire, `type` becomes
 * the SSE `event:` name and the remaining properties are JSON in `data:`.
 * Shipped event objects are additive: unknown properties remain valid, while
 * existing discriminators and required properties are stable.
 */

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown())
const StringNumberBooleanSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean()])
const NullableStringSchema = Type.Union([Type.String(), Type.Null()])

export const PromptChatMultimodalSchema = Type.Object({
  type: Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio'), Type.Literal('signature')]),
  base64: Type.String(),
  height: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
})

export const PromptChatRowSchema = Type.Object({
  role: Type.Union([Type.Literal('system'), Type.Literal('user'), Type.Literal('assistant'), Type.Literal('function')]),
  content: Type.String(),
  memo: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  removable: Type.Optional(Type.Boolean()),
  attr: Type.Optional(Type.Array(Type.String())),
  multimodals: Type.Optional(Type.Array(PromptChatMultimodalSchema)),
  thoughts: Type.Optional(Type.Array(Type.String())),
  cachePoint: Type.Optional(Type.Boolean()),
})

export type PromptChatMultimodal = Static<typeof PromptChatMultimodalSchema>
export type PromptChatRow = Static<typeof PromptChatRowSchema>

export const PromptChatMessageTranslationSchema = Type.Object({
  text: Type.String(),
  source: Type.Literal('raw'),
  sourceHash: Type.String(),
  targetLanguage: Type.String(),
  inputLanguage: Type.String(),
  translatorType: Type.Union([
    Type.Literal('google'),
    Type.Literal('deepl'),
    Type.Literal('deeplX'),
    Type.Literal('llm'),
  ]),
  settingsHash: Type.String(),
  updatedAt: Type.Number(),
})

export const PromptChatMessageGenerationInfoSchema = Type.Object({
  model: Type.Optional(Type.String()),
  generationId: Type.Optional(Type.String()),
  databaseLineage: Type.Optional(Type.String()),
  operationId: Type.Optional(Type.String()),
  acceptedMessageId: Type.Optional(Type.String()),
  attemptNo: Type.Optional(Type.Number()),
  jobId: Type.Optional(Type.String()),
  effectLedgerKeyType: Type.Optional(Type.Union([Type.Literal('operation'), Type.Literal('generation')])),
  effectLedgerKeyId: Type.Optional(Type.String()),
  effectLedgerCharacterId: Type.Optional(Type.String()),
  effectLedgerChatId: Type.Optional(Type.String()),
  inputTokens: Type.Optional(Type.Number()),
  outputTokens: Type.Optional(Type.Number()),
  maxContext: Type.Optional(Type.Number()),
  agentPreset: Type.Optional(UnknownRecordSchema),
  stageTiming: Type.Optional(
    Type.Object({
      stage1: Type.Optional(Type.Number()),
      stage2: Type.Optional(Type.Number()),
      stage3: Type.Optional(Type.Number()),
      stage4: Type.Optional(Type.Number()),
    }),
  ),
})

export const PromptChatMessagePresetInfoSchema = Type.Object({
  promptName: Type.Optional(Type.String()),
  promptToggles: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.String(),
        value: Type.String(),
      }),
    ),
  ),
  promptText: Type.Optional(Type.Array(PromptChatRowSchema)),
})

export const PromptChatMessageSchema = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('char')]),
  data: Type.String(),
  translation: Type.Optional(Type.Union([PromptChatMessageTranslationSchema, Type.Null()])),
  saying: Type.Optional(Type.String()),
  chatId: Type.Optional(Type.String()),
  time: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  generationInfo: Type.Optional(PromptChatMessageGenerationInfoSchema),
  promptInfo: Type.Optional(PromptChatMessagePresetInfoSchema),
  name: Type.Optional(NullableStringSchema),
  otherUser: Type.Optional(Type.Boolean()),
  disabled: Type.Optional(Type.Union([Type.Boolean(), Type.Literal('allBefore')])),
  isComment: Type.Optional(Type.Boolean()),
})

export type PromptChatMessageTranslation = Static<typeof PromptChatMessageTranslationSchema>
export type PromptChatMessage = Static<typeof PromptChatMessageSchema>

export const PromptChatMutationSourceSchema = Type.Union([
  Type.Literal('user_message'),
  Type.Literal('regenerate'),
  Type.Literal('run_var'),
  Type.Literal('history_normalize'),
  Type.Literal('history_inject'),
  Type.Literal('start_trigger'),
  Type.Literal('input_trigger'),
  Type.Literal('editinput'),
  Type.Literal('agent_preset'),
  Type.Literal('output_trigger'),
])

export const PromptChatMessageMutationSchema = Type.Union([
  Type.Object({
    type: Type.Literal('append'),
    source: Type.Literal('user_message'),
    index: Type.Number(),
    message: PromptChatMessageSchema,
  }),
  Type.Object({
    type: Type.Literal('replace_all'),
    source: Type.Union([
      Type.Literal('regenerate'),
      Type.Literal('run_var'),
      Type.Literal('history_normalize'),
      Type.Literal('history_inject'),
      Type.Literal('start_trigger'),
      Type.Literal('input_trigger'),
      Type.Literal('editinput'),
      Type.Literal('agent_preset'),
      Type.Literal('output_trigger'),
    ]),
    beforeLength: Type.Number(),
    afterLength: Type.Number(),
    firstChangedIndex: Type.Optional(Type.Number()),
    messages: Type.Array(PromptChatMessageSchema),
  }),
  Type.Object({
    type: Type.Literal('replace_by_id'),
    source: Type.Literal('history_inject'),
    messageId: Type.String(),
    before: PromptChatMessageSchema,
    message: PromptChatMessageSchema,
  }),
])

export const PromptChatMessagePatchSchema = Type.Object({
  chatId: Type.String(),
  characterId: Type.String(),
  selectedCharID: Type.Number(),
  chatPage: Type.Number(),
  varChanged: Type.Boolean(),
  messageMutations: Type.Array(PromptChatMessageMutationSchema),
  chatVarMutations: Type.Array(
    Type.Object({
      key: Type.String(),
      before: Type.Union([StringNumberBooleanSchema, Type.Null()]),
      after: Type.Union([StringNumberBooleanSchema, Type.Null()]),
    }),
  ),
  chatMetadataMutations: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.Literal('lastMemory'),
        before: NullableStringSchema,
        after: NullableStringSchema,
      }),
    ),
  ),
  characterFieldMutations: Type.Optional(
    Type.Array(
      Type.Object({
        key: Type.Union([
          Type.Literal('name'),
          Type.Literal('firstMessage'),
          Type.Literal('backgroundHTML'),
          Type.Literal('desc'),
        ]),
        before: NullableStringSchema,
        after: Type.String(),
      }),
    ),
  ),
  localLoreMutation: Type.Optional(
    Type.Object({
      before: Type.Array(Type.Unknown()),
      after: Type.Array(Type.Unknown()),
    }),
  ),
  additionalSystemPrompt: Type.Array(
    Type.Object({
      type: Type.Literal('insert_prompt_row'),
      source: Type.Literal('additional_sys_prompt'),
      origin: Type.Union([Type.Literal('start'), Type.Literal('historyend'), Type.Literal('promptend')]),
      slot: Type.Union([Type.Literal('lastChat'), Type.Literal('postEverything')]),
      placement: Type.Union([Type.Literal('push'), Type.Literal('unshift')]),
      row: PromptChatRowSchema,
    }),
  ),
})

export const PromptChatRestorationSchema = Type.Object({
  chatId: Type.String(),
  characterId: Type.String(),
  selectedCharID: Type.Number(),
  chatPage: Type.Number(),
  messages: Type.Array(PromptChatMessageSchema),
  scriptstate: Type.Optional(Type.Record(Type.String(), StringNumberBooleanSchema)),
})

export type PromptChatMutationSource = Static<typeof PromptChatMutationSourceSchema>
export type PromptChatMessageMutation = Static<typeof PromptChatMessageMutationSchema>
export type PromptChatMessagePatch = Static<typeof PromptChatMessagePatchSchema>
export type PromptChatRestoration = Static<typeof PromptChatRestorationSchema>

export const GenerationEffectLedgerRefSchema = Type.Object({
  version: Type.Literal(1),
  databaseLineage: Type.String(),
  keyType: Type.Union([Type.Literal('operation'), Type.Literal('generation')]),
  keyId: Type.String(),
  generationId: Type.String(),
  characterId: Type.String(),
  chatId: Type.String(),
  messageId: Type.String(),
})

export type GenerationEffectLedgerRef = Static<typeof GenerationEffectLedgerRefSchema>

export const PromptChatStageSchema = Type.Union([
  Type.Literal('validate'),
  Type.Literal('prompt'),
  Type.Literal('provider'),
  Type.Literal('done'),
])

export type PromptChatStage = Static<typeof PromptChatStageSchema>

export const LineageEnvelopeSchema = Type.Object({
  databaseLineage: Type.String(),
  operationId: Type.String(),
  writerSessionId: Type.String(),
  writerEpoch: Type.Number(),
  operationStateVersion: Type.Number(),
  projectionEpoch: Type.Number(),
  attemptNo: Type.Number(),
  jobId: Type.String(),
  acceptedMessageId: Type.Optional(Type.String()),
  targetMessageId: Type.Optional(Type.String()),
})

export type LineageEnvelope = Static<typeof LineageEnvelopeSchema>

export const StageEventSchema = Type.Object({
  type: Type.Literal('stage'),
  stage: PromptChatStageSchema,
  status: Type.Union([Type.Literal('start'), Type.Literal('end')]),
})

export const JobAcceptedEventSchema = Type.Object({
  type: Type.Literal('job_accepted'),
  jobId: Type.String(),
})

export const PromptEventSchema = Type.Object({
  type: Type.Literal('prompt'),
  messages: Type.Optional(
    Type.Array(
      Type.Object({
        role: Type.String(),
        content: Type.Unknown(),
      }),
    ),
  ),
  promptInfo: Type.Optional(UnknownRecordSchema),
  lorebookActivation: Type.Optional(Type.Unknown()),
  formated: Type.Optional(Type.Array(PromptChatRowSchema)),
  biases: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.Number()]))),
})

export const InfoEventSchema = Type.Object({
  type: Type.Literal('info'),
  timings: Type.Optional(Type.Record(Type.String(), Type.Number())),
  tokens: Type.Optional(
    Type.Object({
      prompt: Type.Optional(Type.Number()),
      completion: Type.Optional(Type.Number()),
      total: Type.Optional(Type.Number()),
    }),
  ),
  halfStreaming: Type.Optional(Type.Boolean()),
  responseBudget: Type.Optional(Type.Number()),
  generationId: Type.Optional(Type.String()),
  generationInfo: Type.Optional(UnknownRecordSchema),
  continueDisposition: Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('extend')])),
  continueBase: Type.Optional(Type.String()),
  revision: Type.Optional(Type.Number()),
  generationDisplayProjection: Type.Optional(
    Type.Object({
      version: Type.Literal(1),
      mode: Type.Literal('regenerate'),
      targetMessageId: Type.String(),
      generationId: Type.String(),
      operationId: Type.String(),
      attemptNo: Type.Number(),
      projectionEpoch: Type.Number(),
    }),
  ),
})

export const TokenEventSchema = Type.Object({
  type: Type.Literal('token'),
  // Empty content with progress metadata reports generation of filtered reasoning.
  content: Type.String(),
  generatedTokens: Type.Optional(Type.Number()),
  elapsedMs: Type.Optional(Type.Number()),
})

export const ReplayGapEventSchema = Type.Object({
  type: Type.Literal('replay_gap'),
  reason: Type.Literal('replay_budget_exceeded'),
  jobId: Type.String(),
  evictedEvents: Type.Number(),
  evictedBytes: Type.Number(),
})

export const MessagePatchEventSchema = Type.Object({
  type: Type.Literal('message_patch'),
  patch: PromptChatMessagePatchSchema,
})

export const SideEffectEventSchema = Type.Object({
  type: Type.Literal('side_effect'),
  kind: Type.Union([
    Type.Literal('tts'),
    Type.Literal('image'),
    Type.Literal('inlay_screen'),
    Type.Literal('hypav3_progress'),
    Type.Literal('stable_diff'),
  ]),
  payload: Type.Unknown(),
})

export const AgentPresetProgressEventSchema = Type.Object({
  type: Type.Literal('agent_preset_progress'),
  chatId: Type.String(),
  presetId: Type.String(),
  presetName: Type.String(),
  phase: Type.Union([Type.Literal('beforeMain'), Type.Literal('afterMain')]),
  status: Type.Union([
    Type.Literal('started'),
    Type.Literal('running'),
    Type.Literal('finished'),
    Type.Literal('error'),
  ]),
  totalSteps: Type.Number(),
  completedSteps: Type.Number(),
  activeSteps: Type.Array(
    Type.Object({
      stepId: Type.String(),
      stepName: Type.String(),
      outputKey: Type.String(),
    }),
  ),
})

export const PostGenerationProgressEventSchema = Type.Object({
  type: Type.Literal('post_generation_progress'),
  phase: Type.Union([Type.Literal('editOutput'), Type.Literal('onOutput'), Type.Literal('translation')]),
  status: Type.Union([
    Type.Literal('started'),
    Type.Literal('running'),
    Type.Literal('finished'),
    Type.Literal('error'),
    Type.Literal('translating'),
  ]),
  runSeq: Type.Number(),
  ownerType: Type.Optional(Type.Union([Type.Literal('character'), Type.Literal('module')])),
  ownerId: Type.Optional(Type.String()),
  ownerName: Type.Optional(Type.String()),
  triggerId: Type.Optional(Type.String()),
  triggerIndex: Type.Optional(Type.Number()),
  triggerComment: Type.Optional(Type.String()),
  triggerType: Type.Optional(Type.String()),
  effectIndex: Type.Optional(Type.Number()),
  effectType: Type.Optional(Type.String()),
  llmCallCount: Type.Number(),
  pendingLlmCount: Type.Number(),
  llmCallCounts: Type.Object({ LLM: Type.Number(), axLLM: Type.Number() }),
  pendingLlmCounts: Type.Object({ LLM: Type.Number(), axLLM: Type.Number() }),
  messageId: Type.Optional(Type.String()),
  jobId: Type.Optional(Type.String()),
})

export const WarningEventSchema = Type.Object({
  type: Type.Literal('warning'),
  message: Type.String(),
  context: Type.Optional(UnknownRecordSchema),
})

export const GenerationPersistenceDispositionSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('rejected'),
  Type.Literal('unconfirmed'),
  Type.Literal('committed_cleanup_pending'),
])

export const GenerationProjectionSchema = Type.Object({
  characterId: Type.String(),
  chatId: Type.String(),
  generationId: Type.String(),
  mode: Type.Union([Type.Literal('send'), Type.Literal('continue'), Type.Literal('regenerate')]),
  targetMessageId: Type.Optional(Type.String()),
})

export const AgentPresetErrorSchema = Type.Object({
  error: Type.Literal('agent_preset_generation_failed'),
  message: Type.String(),
  statusCode: Type.Number(),
  phase: Type.Optional(Type.Union([Type.Literal('beforeMain'), Type.Literal('afterMain')])),
  presetId: Type.Optional(Type.String()),
  presetName: Type.Optional(Type.String()),
  stepId: Type.Optional(Type.String()),
  stepName: Type.Optional(Type.String()),
  outputKey: Type.Optional(Type.String()),
  failureKind: Type.Optional(Type.String()),
  failurePolicyOutcome: Type.Optional(Type.String()),
  diagnostics: Type.Optional(Type.Unknown()),
})

export const PostGenerationTranslationSchema = Type.Union([
  Type.Object({
    status: Type.Literal('succeeded'),
    jobId: Type.String(),
    translation: PromptChatMessageTranslationSchema,
  }),
  Type.Object({
    status: Type.Literal('failed'),
    jobId: Type.String(),
    error: Type.String(),
  }),
  Type.Object({
    status: Type.Literal('running'),
    jobId: Type.String(),
  }),
])

export const PostGenerationFrameSchema = Type.Object({
  messageId: Type.Optional(Type.String()),
  finalText: Type.Optional(Type.String()),
  messagePatch: Type.Optional(PromptChatMessagePatchSchema),
  resendChat: Type.Optional(Type.Boolean()),
  agentPresetError: Type.Optional(AgentPresetErrorSchema),
  revision: Type.Optional(Type.Number()),
  translation: Type.Optional(PostGenerationTranslationSchema),
  effectLedger: Type.Optional(GenerationEffectLedgerRefSchema),
})

export const ErrorEventSchema = Type.Object({
  type: Type.Literal('error'),
  error: Type.String(),
  reason: Type.Optional(Type.String()),
  status: Type.Optional(Type.Number()),
  statusText: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  restoration: Type.Optional(PromptChatRestorationSchema),
  result: Type.Optional(Type.String()),
  postGeneration: Type.Optional(PostGenerationFrameSchema),
  persistenceDisposition: Type.Optional(
    Type.Union([Type.Literal('queued'), Type.Literal('rejected'), Type.Literal('unconfirmed')]),
  ),
  generationProjection: Type.Optional(GenerationProjectionSchema),
})

export const GenerationOperationStateSchema = Type.Union([
  Type.Literal('cancel_requested'),
  Type.Literal('accepted'),
  Type.Literal('launching'),
  Type.Literal('owned_by_job'),
  Type.Literal('stopping'),
  Type.Literal('retryable'),
  Type.Literal('abandoned'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
  Type.Literal('terminal_failed'),
  Type.Literal('invalidated'),
  Type.Literal('finalizing'),
])

export const DoneEventSchema = Type.Object({
  type: Type.Literal('done'),
  outcome: Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('cancelled')])),
  result: Type.Optional(Type.String()),
  terminalSnapshot: Type.Optional(
    Type.Object({
      version: Type.Literal(1),
      href: Type.String(),
      bytes: Type.Number(),
    }),
  ),
  alternates: Type.Optional(Type.Array(Type.String())),
  generationId: Type.Optional(Type.String()),
  generationInfo: Type.Optional(UnknownRecordSchema),
  halfStreaming: Type.Optional(Type.Boolean()),
  continueDisposition: Type.Optional(Type.Union([Type.Literal('append'), Type.Literal('extend')])),
  continueBase: Type.Optional(Type.String()),
  postGeneration: Type.Optional(PostGenerationFrameSchema),
  persistenceDisposition: Type.Optional(Type.Literal('committed_cleanup_pending')),
  operationState: Type.Optional(GenerationOperationStateSchema),
  resultMessageId: Type.Optional(Type.String()),
})

const PromptChatEventPayloadSchema = Type.Union([
  StageEventSchema,
  JobAcceptedEventSchema,
  PromptEventSchema,
  InfoEventSchema,
  TokenEventSchema,
  ReplayGapEventSchema,
  MessagePatchEventSchema,
  SideEffectEventSchema,
  AgentPresetProgressEventSchema,
  PostGenerationProgressEventSchema,
  WarningEventSchema,
  ErrorEventSchema,
  DoneEventSchema,
])

export const PromptChatEventSchema = Type.Intersect([PromptChatEventPayloadSchema, Type.Partial(LineageEnvelopeSchema)])

export type StageEvent = Static<typeof StageEventSchema>
export type JobAcceptedEvent = Static<typeof JobAcceptedEventSchema>
export type PromptEvent = Static<typeof PromptEventSchema>
export type InfoEvent = Static<typeof InfoEventSchema>
export type TokenEvent = Static<typeof TokenEventSchema>
export type ReplayGapEvent = Static<typeof ReplayGapEventSchema>
export type MessagePatchEvent = Static<typeof MessagePatchEventSchema>
export type SideEffectEvent = Static<typeof SideEffectEventSchema>
export type AgentPresetProgressEvent = Static<typeof AgentPresetProgressEventSchema>
export type PostGenerationProgressEvent = Static<typeof PostGenerationProgressEventSchema>
export type WarningEvent = Static<typeof WarningEventSchema>
export type GenerationPersistenceDisposition = Static<typeof GenerationPersistenceDispositionSchema>
export type GenerationProjection = Static<typeof GenerationProjectionSchema>
export type AgentPresetError = Static<typeof AgentPresetErrorSchema>
export type PostGenerationTranslation = Static<typeof PostGenerationTranslationSchema>
export type PostGenerationTranslationFrame = PostGenerationTranslation
export type PostGenerationFrame = Static<typeof PostGenerationFrameSchema>
export type ErrorEvent = Static<typeof ErrorEventSchema>
export type GenerationOperationState = Static<typeof GenerationOperationStateSchema>
export type DoneEvent = Static<typeof DoneEventSchema>
export type PromptChatEvent = Static<typeof PromptChatEventSchema>
export type PromptChatEventType = PromptChatEvent['type']

export type PostGenerationLuaProgressEvent = PostGenerationProgressEvent & {
  phase: 'editOutput' | 'onOutput'
  status: 'started' | 'running' | 'finished' | 'error'
}

export type PostGenerationTranslationProgressEvent = PostGenerationProgressEvent & {
  phase: 'translation'
  status: 'translating'
  runSeq: 0
  messageId: string
  jobId: string
}

export const PROMPT_CHAT_EVENT_TYPES = [
  'stage',
  'job_accepted',
  'prompt',
  'info',
  'token',
  'replay_gap',
  'message_patch',
  'side_effect',
  'agent_preset_progress',
  'post_generation_progress',
  'warning',
  'error',
  'done',
] as const satisfies readonly PromptChatEventType[]

const PROMPT_CHAT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PROMPT_CHAT_EVENT_TYPES)

export function isPromptChatEvent(value: unknown): value is PromptChatEvent {
  return Value.Check(PromptChatEventSchema, value)
}

export function isPromptChatEventType(value: unknown): value is PromptChatEventType {
  return typeof value === 'string' && PROMPT_CHAT_EVENT_TYPE_SET.has(value)
}

/** Parse an SSE event name plus its decoded `data:` object into the shared union. */
export function parsePromptChatSseEvent(eventName: string, data: unknown): PromptChatEvent | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const candidate = { ...(data as Record<string, unknown>), type: eventName }
  return isPromptChatEvent(candidate) ? candidate : null
}

// Compatibility aliases retained while consumers move to canonical DTO names.
export type ServerChatLineageEnvelope = LineageEnvelope
export type ServerChatMessagePatch = PromptChatMessagePatch
export type ServerChatMessageMutation = PromptChatMessageMutation
export type ServerChatRestoration = PromptChatRestoration
export type ServerChatGenerationProjection = GenerationProjection
export type ServerChatAgentPresetError = AgentPresetError
export type ServerChatPostGeneration = PostGenerationFrame
export type ServerGenerationEffectLedgerRef = GenerationEffectLedgerRef
export type ServerChatPostGenerationTranslation = PostGenerationTranslation
export type ServerChatSideEffect = Omit<SideEffectEvent, 'type'>
export type ServerChatWarning = Omit<WarningEvent, 'type'>
export type ServerChatGenerationPersistenceDisposition = GenerationPersistenceDisposition
export const CLIENT_PROMPT_CHAT_EVENT_TYPES = PROMPT_CHAT_EVENT_TYPES
