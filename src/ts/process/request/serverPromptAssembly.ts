import {
  isServerCharacterShell,
  type character,
  type Chat,
  type Database,
  type triggerscript,
} from '../../storage/database.svelte'
import { LLMFlags } from '../../model/types'
import { isPluginRuntimeReady, pluginV2 } from '../../plugins/plugins.svelte'
import { resolveActiveModuleStates } from '../../moduleActivation'
import { isServerChatMessagePlaceholder } from '../../server/chatMessagePlaceholders'
import {
  applyEffectivePresetComposition,
  databaseKeyForModelPresetField,
  isLegacyModelPresetCompatibilityRecord,
  MODEL_PRESET_FIELDS,
} from '../../presetSplit'
import {
  modelProfileGenerationBlockReason,
  resolveModelProfile,
  resolveModelProfileWithLegacyCompatibility,
  type ResolvedModelProfile,
} from '../../model/modelProfileResolver'
import { normalizeModelRoleProfiles } from '../../model/modelProfileRecords'
import { resolveUniquePromptPreset } from '@risuai/shared-core/effective-prompt-template'

/**
 * Route shape shared with `ServerCompletionRoute` in `serverCompletion.ts`.
 * The `local` arm remains for compatibility callers, while the live Fastify
 * resolver below returns only `server` or `unsupported`. `unsupported` carries
 * the user-facing failure message surfaced by the gate.
 */
export type ServerPromptAssemblyRoute = { type: 'local' } | { type: 'server' } | { type: 'unsupported'; reason: string }

export type ServerPromptAssemblyOrigin = 'ui-send-preflight' | 'ui-draft-preflight' | 'send-chat' | 'durable'

export interface ServerPromptAssemblyTranscriptOwnerDiagnostic {
  messageCount: number
  sameMessageArray: boolean
}

export interface ServerPromptAssemblyInput {
  /** Coherent generation-owner snapshot captured before this preflight runs. */
  database: Database
  currentChar: character
  currentChat: Chat
  origin?: ServerPromptAssemblyOrigin
  pendingUserMessageSupplied?: boolean
  transcriptOwner?: ServerPromptAssemblyTranscriptOwnerDiagnostic | null
  generationOperationProtocol?: boolean
  preview?: boolean
  previewPrompt?: boolean
  continue?: boolean
  regenerateMessageId?: string
}

type ServerPromptAssemblyMode = 'send' | 'continue' | 'preview' | 'preview_prompt' | 'regenerate'

/** Mirrors `serverChatMode` in `serverBackedSendChat.ts`. */
function deriveMode(input: ServerPromptAssemblyInput): ServerPromptAssemblyMode {
  if (input.previewPrompt) return 'preview_prompt'
  if (input.preview) return 'preview'
  if (typeof input.regenerateMessageId === 'string') return 'regenerate'
  if (input.continue) return 'continue'
  return 'send'
}

function formatTailFlag(value: unknown, allowedString?: string): string {
  if (typeof value === 'boolean' || value === allowedString) return String(value)
  return typeof value
}

function formatSendTailDiagnostic(
  input: ServerPromptAssemblyInput,
  mode: ServerPromptAssemblyMode,
  rawMessages: unknown,
  messages: unknown[] | undefined,
): string {
  const count = rawMessages === undefined ? 'missing' : messages ? String(messages.length) : 'not-array'
  const hasTail = !!messages && messages.length > 0
  let tail = 'none'
  if (hasTail) {
    const lastMessage = messages.at(-1)
    const tailRecord =
      lastMessage !== null && typeof lastMessage === 'object' ? (lastMessage as Record<string, unknown>) : undefined
    const role = tailRecord?.role
    const data = tailRecord?.data
    const tailFacts = [
      `role:${typeof role === 'string' ? role : typeof role}`,
      `data:${typeof data}`,
      ...(typeof data === 'string' ? [`length:${data.length}`] : []),
      `placeholder:${isServerChatMessagePlaceholder(lastMessage)}`,
      `chatId:${typeof tailRecord?.chatId === 'string' && tailRecord.chatId.length > 0}`,
    ]
    if (tailRecord && Object.prototype.hasOwnProperty.call(tailRecord, 'disabled')) {
      tailFacts.push(`disabled:${formatTailFlag(tailRecord.disabled, 'allBefore')}`)
    }
    if (tailRecord && Object.prototype.hasOwnProperty.call(tailRecord, 'isComment')) {
      tailFacts.push(`isComment:${formatTailFlag(tailRecord.isComment)}`)
    }
    tail = tailFacts.join(',')
  }

  const owner =
    input.transcriptOwner === null
      ? 'none'
      : input.transcriptOwner
        ? `${input.transcriptOwner.messageCount}/${input.transcriptOwner.sameMessageArray ? 'same' : 'different'}`
        : 'unknown'
  const protocol =
    typeof input.generationOperationProtocol === 'boolean' ? String(input.generationOperationProtocol) : 'unknown'

  return ` [origin=${input.origin ?? 'unknown'} mode=${mode} count=${count} tail=${tail} pending=${input.pendingUserMessageSupplied === true} shell=${isServerCharacterShell(input.currentChar)} owner=${owner} protocol=${protocol}]`
}

// Inlay / asset markers the local converter resolves into image/asset bytes.
// The server assembler resolves them too:
// inlay and asset bytes come from the server store. Legacy inlay ids can ride
// the request as id aliases, but never as base64 bytes. Only the non-vision
// caption case below remains unsupported.
const INLAY_MARKER = /\{\{(?:inlay|inlayed|inlayeddata)::/i
const ASSET_MARKER = /\{\{asset_?prompt::/i

/**
 * Multimodal / asset content: any message carrying a runtime `multimodals` array
 * (set by scripting) or an inlay/asset marker in its `.data`. Used to detect the
 * non-vision caption fallback case.
 */
function sendHasMultimodalOrAsset(currentChat: Chat): boolean {
  for (const message of currentChat.message ?? []) {
    const multimodals = (message as { multimodals?: unknown }).multimodals
    if (Array.isArray(multimodals) && multimodals.length > 0) return true
    const data = message.data
    if (typeof data === 'string' && (INLAY_MARKER.test(data) || ASSET_MARKER.test(data))) {
      return true
    }
  }
  return false
}

/** Whether the active resolved profile accepts inline image input. */
function modelAcceptsImageInput(input: ServerPromptAssemblyInput): boolean {
  const profile = resolveProfileForChat(input.database, input.currentChat)
  const flags = profile.runtimeOptions.enableCustomFlags
    ? (profile.runtimeOptions.customFlags ?? [])
    : profile.modelInfo.flags
  return flags.includes(LLMFlags.hasImageInput)
}

// Interactive Lua dialog APIs. A `triggerlua` script that calls one of these
// mid-assembly needs a browser dialog the server cannot drive (the server VM
// throws an InteractiveApiError, `luaRuntime.ts`). By default the server lets Lua
// pass preflight and fails only if one of these APIs is actually invoked. The
// Strict Script Check advanced setting restores the old conservative source scan.
const INTERACTIVE_LUA_API_RE = /\b(?:alertInput|alertSelect|alertConfirm)\b/

/** Whether any `triggerlua` effect's source references an interactive dialog API. */
function triggersUseInteractiveLua(triggers: triggerscript[] | undefined): boolean {
  if (!Array.isArray(triggers)) return false
  return triggers.some((trigger) => {
    const effect = trigger?.effect?.[0]
    return (
      effect?.type === 'triggerlua' &&
      typeof (effect as { code?: unknown }).code === 'string' &&
      INTERACTIVE_LUA_API_RE.test((effect as { code: string }).code)
    )
  })
}

/**
 * pluginV2 edit hooks (local-assembler class 5, plugin arm): any registered
 * pluginV2 edit/replacer function. **Permanent `unsupported`** because pluginV2
 * code does not execute server-side and is superseded by Plugin V3. This detector
 * never flips to `server`; the unsupported-feature contract prevents a
 * server-side execution path from being silently added.
 */
function hasPluginV2EditSet(): boolean {
  if (!isPluginRuntimeReady()) return false
  return (
    pluginV2.editinput.size > 0 ||
    pluginV2.editoutput.size > 0 ||
    pluginV2.editprocess.size > 0 ||
    pluginV2.editdisplay.size > 0 ||
    pluginV2.replacerbeforeRequest.size > 0 ||
    pluginV2.replacerafterRequest.size > 0
  )
}

/**
 * Lua script content: a `triggerlua` effect on the character or any enabled
 * module. The server Lua VM runs non-interactive hooks and blocks interactive
 * dialog APIs at invocation time. When Strict Script Check is enabled, scripts
 * that reference browser dialog APIs (`alertInput`/`alertSelect`/`alertConfirm`)
 * stay `unsupported` during preflight.
 * Kept separate from `hasPluginV2EditSet` so the permanent pluginV2 hard-fail is
 * undisturbed.
 */
function luaUsesInteractiveApi(input: ServerPromptAssemblyInput): boolean {
  const moduleTriggers = resolveActiveModuleStates(input.database, input.currentChar, input.currentChat).flatMap(
    ({ module }) => module.trigger ?? [],
  )
  return triggersUseInteractiveLua(input.currentChar.triggerscript) || triggersUseInteractiveLua(moduleTriggers)
}

const MODEL_RUNTIME_DATABASE_EXTRA_FIELDS = [
  'providerCredentials',
  'OaiCompAPIKeys',
  'google',
  'vertexRegion',
  'vertexClientEmail',
  'vertexPrivateKey',
  'claudeAPIKey',
  'ollamaApiKey',
  'ollamaRequestFormat',
  'ollamaURL',
  'ollamaModelSource',
  'ollamaThinkingMode',
  'openrouterKey',
  'openrouterFallback',
  'openrouterMiddleOut',
  'nanogptProvider',
  'nanogptUseSubscriptionEndpoint',
  'nanogptKey',
  'nanogptSubscriptionState',
  'autofillRequestUrl',
  'reverseProxyOobaMode',
  'mistralKey',
  'cohereAPIKey',
  'mancerHeader',
  'hordeConfig',
  'halfStreaming',
  'useStreaming',
  'genTime',
  'customTokenizer',
  'ollamaCloudModel',
  'ollamaModel',
  'nanogptRequestModel',
  'customModels',
] as const

function shouldCopyModelRuntimeBaseValue(value: unknown): boolean {
  if (value === undefined) return false
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function pickModelRuntimeDatabaseBase(database: Database): Record<string, unknown> {
  const source = database as unknown as Record<string, unknown>
  const base: Record<string, unknown> = {}
  const pick = (key: string): void => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return
    const value = source[key]
    if (shouldCopyModelRuntimeBaseValue(value)) base[key] = value
  }

  for (const field of MODEL_PRESET_FIELDS) {
    pick(databaseKeyForModelPresetField(field))
  }
  for (const field of MODEL_RUNTIME_DATABASE_EXTRA_FIELDS) {
    pick(field)
  }
  return base
}

/**
 * True if the send carries content the server `/chat` assembler cannot reproduce.
 * Coarse presence detection: on doubt, report content as `unsupported`, never
 * silently fall through to a server assembly that would drop it.
 */
function sendHasUnsupportedContent(input: ServerPromptAssemblyInput): string | null {
  // When the model lacks image input, the local assembler replaces an image with
  // a `runImageEmbedding` caption, a browser-only ML pipeline with no server
  // equivalent. Rather than emit a silently captionless prompt, any
  // image/asset/inlay content on a non-vision model is `unsupported`.
  if (sendHasMultimodalOrAsset(input.currentChat) && !modelAcceptsImageInput(input)) {
    return 'This model has no image input, so image/asset content would need the browser caption fallback, which server prompt assembly cannot reproduce. Select a vision-capable server-routed model before retrying.'
  }
  // Image-gen / emotion view instructions are server-assembled. The post-gen
  // image generation / inlay-screen rendering stays a browser effect.
  // Lua scripts route to the server by default. With Strict Script Check enabled,
  // keep the old conservative behavior and block source that references a
  // browser-only interactive dialog API.
  if (input.database.strictScriptCheck === true && luaUsesInteractiveApi(input)) {
    return 'Lua scripts using interactive dialogs (alertInput / alertSelect / alertConfirm) require the browser and are not supported by server prompt assembly.'
  }
  // pluginV2 edit hooks stay permanently `unsupported` (no-port list; deprecated
  // by Plugin V3). Reported separately from Lua; see `hasPluginV2EditSet`.
  if (hasPluginV2EditSet()) {
    return 'Plugin (V2) scripts run only in the browser plugin runtime and are not supported by server prompt assembly.'
  }
  return null
}

function effectiveModelDatabaseForChat(db: Database, currentChat: Chat): Database {
  const settings = currentChat.generationSettings
  const modelPreset = findPresetById(db.modelPresets, settings?.modelPresetId)
  const promptPreset = findUniquePromptPresetById(db.promptPresets, settings?.promptPresetId)
  const effective = pickModelRuntimeDatabaseBase(db)
  applyEffectivePresetComposition(effective, {
    modelPreset,
    promptPreset,
    scope: 'model-runtime',
  })
  return effective as unknown as Database
}

function findPresetById(collection: unknown, id: string | undefined): Record<string, unknown> | undefined {
  if (!id || !Array.isArray(collection)) return undefined
  return collection.find((item): item is Record<string, unknown> => {
    return !!item && typeof item === 'object' && !Array.isArray(item) && (item as { id?: unknown }).id === id
  })
}

function findUniquePromptPresetById(collection: unknown, id: string | undefined): Record<string, unknown> | undefined {
  if (!Array.isArray(collection)) return undefined
  const records = collection.filter((item): item is Record<string, unknown> => {
    return !!item && typeof item === 'object' && !Array.isArray(item)
  })
  return resolveUniquePromptPreset(records, id)
}

function resolveProfileForChat(databaseSnapshot: Database, currentChat: Chat): ResolvedModelProfile {
  const database = effectiveModelDatabaseForChat(databaseSnapshot, currentChat)
  const modelPreset = findPresetById(databaseSnapshot.modelPresets, currentChat.generationSettings?.modelPresetId)
  const legacyBinding = normalizeModelRoleProfiles(database.modelRoleProfiles).chatMain.mode === 'legacy'
  return isLegacyModelPresetCompatibilityRecord(modelPreset) || legacyBinding
    ? resolveModelProfileWithLegacyCompatibility({ database })
    : resolveModelProfile({ database })
}

function unsupportedServerGenerationReason(aiModel: string): string {
  return `Generation for ${aiModel} is not supported in Fastify server mode. Select a server-routed provider or change this model before retrying.`
}

function resolveServerProviderPreflight(input: ServerPromptAssemblyInput): ServerPromptAssemblyRoute | null {
  const profile = resolveProfileForChat(input.database, input.currentChat)
  const profileBlockReason = modelProfileGenerationBlockReason(profile)
  if (profileBlockReason) {
    return {
      type: 'unsupported',
      reason: profileBlockReason,
    }
  }
  if (profile.modelInfo.unsupportedReason) {
    return {
      type: 'unsupported',
      reason: profile.modelInfo.unsupportedReason,
    }
  }
  if (profile.providerCapability.routable) return null
  return {
    type: 'unsupported',
    reason: unsupportedServerGenerationReason(profile.modelId),
  }
}

/**
 * Decide whether `sendChat` must assemble its prompt on the server or hard-fail.
 * The completion adapter no longer builds provider wire payloads, but prompt
 * assembly still performs this provider preflight so unsupported Fastify sends
 * fail before mutating chat state.
 *
 * Decision order:
 *   1. mode / user-message structural check.
 *   2. single, non-group character.
 *   3. server-routable provider (shared provider-capability table).
 *   4. no interactive-Lua / pluginV2 content, and no image/asset/inlay content
 *      on a model without image input. Vision-model image/asset/inlay content,
 *      image-gen / emotion view instructions, and non-interactive Lua hooks are
 *      server-assembled; pluginV2 edit hooks stay a permanent hard fail.
 *   5. otherwise → `server`.
 *
 * The verdict is always `server` or `unsupported` — never a silent local
 * fall-through.
 */
export function resolveServerPromptAssembly(input: ServerPromptAssemblyInput): ServerPromptAssemblyRoute {
  if (!input.database || typeof input.database !== 'object') {
    return {
      type: 'unsupported',
      reason: 'Server prompt assembly requires a ready generation settings snapshot.',
    }
  }

  const mode = deriveMode(input)
  if (mode === 'send') {
    const rawMessages: unknown = (input.currentChat as { message?: unknown }).message
    const messages: unknown[] | undefined = Array.isArray(rawMessages) ? rawMessages : undefined
    const lastMessage = messages?.at(-1)
    const lastMessageRecord =
      lastMessage !== null && typeof lastMessage === 'object' ? (lastMessage as Record<string, unknown>) : undefined
    const isTextSendTail =
      typeof lastMessageRecord?.data === 'string' &&
      (lastMessageRecord.role === 'user' || lastMessageRecord.role === 'char')
    if (!isTextSendTail) {
      return {
        type: 'unsupported',
        reason:
          'Server prompt assembly for a send requires a text user or assistant tail message.' +
          formatSendTailDiagnostic(input, mode, rawMessages, messages),
      }
    }
  }

  // Group rows are filtered during database normalization, but keep an explicit
  // guard for imported or directly constructed inputs that bypass that filter.
  if ((input.currentChar as { type?: string }).type === 'group') {
    return {
      type: 'unsupported',
      reason: 'Group chats are not supported by server prompt assembly.',
    }
  }

  const providerReason = resolveServerProviderPreflight(input)
  if (providerReason !== null) return providerReason

  const contentReason = sendHasUnsupportedContent(input)
  if (contentReason !== null) {
    return { type: 'unsupported', reason: contentReason }
  }

  return { type: 'server' }
}
