import {
  PROTOCOL_ROUTE_OPERATION_CATALOG,
  findProtocolRouteOperationById,
  protocolRouteOperationMatches,
  type ProtocolRouteCacheBehavior,
  type ProtocolRouteDurabilityTag,
  type ProtocolRouteMethod,
  type ProtocolRouteOperationId,
  type ProtocolRouteResponseClass,
  type ProtocolRouteStreamingShape,
} from '@risuai/protocol/route-operation'

export const BROWSER_OPERATION_FAMILIES = ['resource', 'cache', 'generation', 'raw-generation'] as const
export type BrowserOperationFamily = (typeof BROWSER_OPERATION_FAMILIES)[number]

export interface BrowserOperationBinding {
  key: string
  family: BrowserOperationFamily
  routeOperationId: ProtocolRouteOperationId
  method: ProtocolRouteMethod
  examplePath: string
  cache: ProtocolRouteCacheBehavior
  streaming: ProtocolRouteStreamingShape
  durability: ProtocolRouteDurabilityTag
  response: ProtocolRouteResponseClass
  /** Browser source location that owns the request or caller gate. */
  owner: `${string}#${string}`
}

export const BROWSER_OPERATION_NON_OVERLAP_REASONS = [
  'browser-state-semantics',
  'browser-persistence-semantics',
  'runtime-instance-identity',
  'diagnostic-only',
  'browser-capability-gate',
  'no-live-browser-adapter',
] as const
export type BrowserOperationNonOverlapReason = (typeof BROWSER_OPERATION_NON_OVERLAP_REASONS)[number]

export interface BrowserOperationNonOverlap {
  id: string
  family: BrowserOperationFamily
  reason: BrowserOperationNonOverlapReason
  owner: `${string}#${string}`
  detail: string
}

const operation = <const T extends BrowserOperationBinding>(binding: T): T => binding

/**
 * Browser-owned, non-authoritative links to the shared HTTP operation vocabulary.
 * These entries describe transport behavior only. Fastify remains the sole owner
 * of authentication, active-writer, credential, host, rate-limit, and handler policy.
 */
export const BROWSER_OPERATION_BINDINGS = [
  operation({
    key: 'bootstrap-read',
    family: 'resource',
    routeOperationId: 'bootstrap',
    method: 'GET',
    examplePath: '/api/v1/bootstrap',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/bootstrap.ts#fetchServerBootstrap',
  }),
  operation({
    key: 'ownership-read',
    family: 'resource',
    routeOperationId: 'ownership',
    method: 'GET',
    examplePath: '/api/v1/ownership',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/bootstrap.ts#fetchServerOwnership',
  }),
  operation({
    key: 'settings-read',
    family: 'resource',
    routeOperationId: 'settings-read',
    method: 'GET',
    examplePath: '/api/v1/settings',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerSettings',
  }),
  operation({
    key: 'shell-resource-read',
    family: 'resource',
    routeOperationId: 'shell-resource-read',
    method: 'GET',
    examplePath: '/api/v1/resources/shell',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerShell',
  }),
  operation({
    key: 'standalone-setting-read',
    family: 'resource',
    routeOperationId: 'standalone-setting-resource-read',
    method: 'GET',
    examplePath: '/api/v1/resources/settings/selectedPersona',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerStandaloneSetting',
  }),
  operation({
    key: 'inlay-catalog-read',
    family: 'resource',
    routeOperationId: 'inlay-catalog-read',
    method: 'GET',
    examplePath: '/api/v1/inlay-assets',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerInlayCatalog',
  }),
  operation({
    key: 'settings-cache-read',
    family: 'resource',
    routeOperationId: 'settings-cache-read',
    method: 'POST',
    examplePath: '/api/v1/settings',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerSettings',
  }),
  operation({
    key: 'settings-group-read',
    family: 'resource',
    routeOperationId: 'settings-group-read',
    method: 'GET',
    examplePath: '/api/v1/settings/display',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerSettingsGroup',
  }),
  operation({
    key: 'settings-group-cache-read',
    family: 'resource',
    routeOperationId: 'settings-group-cache-read',
    method: 'POST',
    examplePath: '/api/v1/settings/display',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerSettingsGroup',
  }),
  operation({
    key: 'collections-read',
    family: 'resource',
    routeOperationId: 'collections-read',
    method: 'GET',
    examplePath: '/api/v1/collections',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCollections',
  }),
  operation({
    key: 'collections-cache-read',
    family: 'resource',
    routeOperationId: 'collections-cache-read',
    method: 'POST',
    examplePath: '/api/v1/collections',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCollections',
  }),
  operation({
    key: 'collection-read',
    family: 'resource',
    routeOperationId: 'collection-read',
    method: 'GET',
    examplePath: '/api/v1/collections/personas',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCollection',
  }),
  operation({
    key: 'collection-cache-read',
    family: 'resource',
    routeOperationId: 'collection-cache-read',
    method: 'POST',
    examplePath: '/api/v1/collections/personas',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCollection',
  }),
  operation({
    key: 'characters-read',
    family: 'resource',
    routeOperationId: 'characters-read',
    method: 'GET',
    examplePath: '/api/v1/characters',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCharacters',
  }),
  operation({
    key: 'characters-cache-read',
    family: 'resource',
    routeOperationId: 'characters-cache-read',
    method: 'POST',
    examplePath: '/api/v1/characters',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCharacters',
  }),
  operation({
    key: 'character-order-read',
    family: 'resource',
    routeOperationId: 'character-order-read',
    method: 'GET',
    examplePath: '/api/v1/characters/order',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCharacterOrder',
  }),
  operation({
    key: 'character-selection-read',
    family: 'resource',
    routeOperationId: 'character-selection-read',
    method: 'GET',
    examplePath: '/api/v1/characters/character-1/selection',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCharacterSelection',
  }),
  operation({
    key: 'character-read',
    family: 'resource',
    routeOperationId: 'character-read',
    method: 'GET',
    examplePath: '/api/v1/characters/character-1',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerCharacter',
  }),
  operation({
    key: 'character-greeting-translations-read',
    family: 'resource',
    routeOperationId: 'character-greeting-translations-read',
    method: 'GET',
    examplePath: '/api/v1/characters/character-1/greeting-translations',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/greetingTranslations.svelte.ts#fetchGreetingTranslationProjection',
  }),
  operation({
    key: 'chat-messages-read',
    family: 'resource',
    routeOperationId: 'chat-messages-read',
    method: 'GET',
    examplePath: '/api/v1/chats/chat-1/messages',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerChatMessages',
  }),
  operation({
    key: 'chat-messages-bulk-read',
    family: 'resource',
    routeOperationId: 'chat-messages-bulk-read',
    method: 'POST',
    examplePath: '/api/v1/chats/messages/bulk',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerBulkChatMessages',
  }),
  operation({
    key: 'chat-lore-token-counts',
    family: 'resource',
    routeOperationId: 'chat-lore-token-counts',
    method: 'GET',
    examplePath: '/api/v1/chats/chat-1/lore-token-counts',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/loreTokenCounts.ts#fetchLoreTokenCounts',
  }),
  operation({
    key: 'chat-display-sources',
    family: 'resource',
    routeOperationId: 'chat-display-sources',
    method: 'POST',
    examplePath: '/api/v1/chats/chat-1/display-sources',
    cache: 'unspecified',
    streaming: 'sse-optional',
    durability: 'none',
    response: 'structured-or-sse',
    owner: 'src/ts/server/displaySources.ts#requestServerDisplaySource',
  }),
  operation({
    key: 'character-lorebook-read',
    family: 'resource',
    routeOperationId: 'character-lorebook-read',
    method: 'GET',
    examplePath: '/api/v1/characters/character-1/lorebook',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerCharacterLorebook',
  }),
  operation({
    key: 'character-lorebook-cache-read',
    family: 'resource',
    routeOperationId: 'character-lorebook-cache-read',
    method: 'POST',
    examplePath: '/api/v1/characters/character-1/lorebook',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerCharacterLorebook',
  }),
  operation({
    key: 'character-lorebooks-bulk-read',
    family: 'resource',
    routeOperationId: 'character-lorebooks-bulk-read',
    method: 'POST',
    examplePath: '/api/v1/characters/lorebooks/bulk',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerBulkCharacterLorebooks',
  }),
  operation({
    key: 'legacy-preset-read',
    family: 'resource',
    routeOperationId: 'legacy-preset-read',
    method: 'GET',
    examplePath: '/api/v1/legacy-presets/preset-1',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerLegacyPreset',
  }),
  operation({
    key: 'legacy-preset-cache-read',
    family: 'resource',
    routeOperationId: 'legacy-preset-cache-read',
    method: 'POST',
    examplePath: '/api/v1/legacy-presets/preset-1',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerLegacyPreset',
  }),
  operation({
    key: 'prompt-preset-template-read',
    family: 'resource',
    routeOperationId: 'prompt-preset-template-read',
    method: 'GET',
    examplePath: '/api/v1/prompt-presets/preset-1/template',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerPromptPresetTemplate',
  }),
  operation({
    key: 'prompt-preset-template-cache-read',
    family: 'resource',
    routeOperationId: 'prompt-preset-template-cache-read',
    method: 'POST',
    examplePath: '/api/v1/prompt-presets/preset-1/template',
    cache: 'request-hash',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/hydrationReads.ts#fetchServerPromptPresetTemplate',
  }),
  operation({
    key: 'bardwiki-chat-read',
    family: 'resource',
    routeOperationId: 'bardwiki-chat-read',
    method: 'GET',
    examplePath: '/api/v1/bardwiki/chats/chat-1',
    cache: 'conditional',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerBardWikiChat',
  }),
  operation({
    key: 'bardwiki-document-read',
    family: 'resource',
    routeOperationId: 'bardwiki-document-read',
    method: 'GET',
    examplePath: '/api/v1/bardwiki/chats/chat-1/documents/document-1',
    cache: 'conditional',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerBardWikiDocument',
  }),
  operation({
    key: 'bardwiki-document-versions-read',
    family: 'resource',
    routeOperationId: 'bardwiki-document-versions-read',
    method: 'GET',
    examplePath: '/api/v1/bardwiki/chats/chat-1/documents/document-1/versions',
    cache: 'conditional',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/resourceReads.ts#fetchServerBardWikiVersions',
  }),
  operation({
    key: 'bardwiki-vault-export',
    family: 'cache',
    routeOperationId: 'bardwiki-vault-export',
    method: 'GET',
    examplePath: '/api/v1/bardwiki/chats/chat-1/export',
    cache: 'no-store',
    streaming: 'binary',
    durability: 'none',
    response: 'binary',
    owner: 'src/ts/server/bardWikiCommands.ts#exportBardWikiVault',
  }),
  operation({
    key: 'command-events',
    family: 'cache',
    routeOperationId: 'events',
    method: 'GET',
    examplePath: '/api/v1/events',
    cache: 'no-cache',
    streaming: 'sse',
    durability: 'none',
    response: 'sse',
    owner: 'src/ts/server/events.ts#subscribeServerCommandEvents',
  }),
  operation({
    key: 'asset-read',
    family: 'cache',
    routeOperationId: 'asset-read',
    method: 'GET',
    examplePath: '/api/v1/assets/asset-1',
    cache: 'immutable',
    streaming: 'binary',
    durability: 'none',
    response: 'binary',
    owner: 'src/ts/server/assets.ts#readServerAsset',
  }),
  operation({
    key: 'request-history-list',
    family: 'cache',
    routeOperationId: 'request-history-list',
    method: 'GET',
    examplePath: '/api/v1/request-history',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/requestHistory.ts#listRequestHistory',
  }),
  operation({
    key: 'request-history-detail',
    family: 'cache',
    routeOperationId: 'request-history-detail',
    method: 'GET',
    examplePath: '/api/v1/request-history/request-1',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/requestHistory.ts#getRequestHistoryRecord',
  }),
  operation({
    key: 'mcp-oauth-refresh',
    family: 'cache',
    routeOperationId: 'mcp-oauth-refresh',
    method: 'POST',
    examplePath: '/api/v1/mcp/oauth/refresh',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/mcpOAuthRefresh.ts#requestStoredMcpOAuthRefresh',
  }),
  operation({
    key: 'embedding-operations',
    family: 'cache',
    routeOperationId: 'embedding-operations',
    method: 'POST',
    examplePath: '/api/v1/embedding-operations',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/embeddingOperations.ts#requestEmbeddingOperation',
  }),
  operation({
    key: 'provider-operations',
    family: 'cache',
    routeOperationId: 'provider-operations',
    method: 'POST',
    examplePath: '/api/v1/provider-operations',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/providerOperations.ts#requestProviderOperation',
  }),
  operation({
    key: 'openai-transcription',
    family: 'cache',
    routeOperationId: 'openai-transcription',
    method: 'POST',
    examplePath: '/api/v1/media/openai/transcriptions',
    cache: 'no-store',
    streaming: 'none',
    durability: 'none',
    response: 'structured',
    owner: 'src/ts/server/openAITranscription.ts#requestOpenAITranscription',
  }),
  operation({
    key: 'tts-synthesis',
    family: 'cache',
    routeOperationId: 'tts-synthesis',
    method: 'POST',
    examplePath: '/api/v1/tts/synthesize',
    cache: 'no-store',
    streaming: 'binary',
    durability: 'none',
    response: 'binary',
    owner: 'src/ts/server/tts.ts#requestTtsSynthesis',
  }),
  operation({
    key: 'image-generation',
    family: 'cache',
    routeOperationId: 'image-generation',
    method: 'POST',
    examplePath: '/api/v1/image-generation',
    cache: 'no-store',
    streaming: 'binary',
    durability: 'none',
    response: 'binary',
    owner: 'src/ts/server/imageGeneration.ts#requestImageGeneration',
  }),
  operation({
    key: 'memory-job-list',
    family: 'cache',
    routeOperationId: 'memory-job-list',
    method: 'GET',
    examplePath: '/api/v1/memory/jobs',
    cache: 'conditional',
    streaming: 'none',
    durability: 'server-job',
    response: 'structured',
    owner: 'src/ts/process/request/serverMemory.ts#listServerMemoryJobs',
  }),
  operation({
    key: 'generation-completion',
    family: 'generation',
    routeOperationId: 'generation-completion',
    method: 'POST',
    examplePath: '/api/v1/generate/completion',
    cache: 'no-store',
    streaming: 'sse-optional',
    durability: 'none',
    response: 'structured-or-sse',
    owner: 'src/ts/process/request/serverCompletion.ts#requestServerCompletion',
  }),
  operation({
    key: 'generation-operation-submit',
    family: 'generation',
    routeOperationId: 'generation-operation-submit',
    method: 'POST',
    examplePath: '/api/v1/generation-operations',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'durable-generation',
    response: 'structured',
    owner: 'src/ts/server/generationOperations.ts#submitStagedAcceptedSendOperation',
  }),
  operation({
    key: 'generation-operation-status',
    family: 'generation',
    routeOperationId: 'generation-operation-status',
    method: 'GET',
    examplePath: '/api/v1/generation-operations/operation-1',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'durable-generation',
    response: 'structured',
    owner: 'src/ts/server/generationOperations.ts#readGenerationOperationStatus',
  }),
  operation({
    key: 'generation-operation-stream',
    family: 'generation',
    routeOperationId: 'generation-operation-stream',
    method: 'GET',
    examplePath: '/api/v1/generation-operations/operation-1/stream',
    cache: 'no-cache',
    streaming: 'sse',
    durability: 'durable-generation',
    response: 'sse',
    owner: 'src/ts/server/generationOperations.ts#generationOperationStreamDescriptor',
  }),
  operation({
    key: 'generation-operation-cancel',
    family: 'generation',
    routeOperationId: 'generation-operation-cancel',
    method: 'PUT',
    examplePath: '/api/v1/generation-operations/operation-1/cancellation',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'durable-generation',
    response: 'structured',
    owner: 'src/ts/server/generationOperations.ts#stopGenerationOperation',
  }),
  operation({
    key: 'generation-operation-retry',
    family: 'generation',
    routeOperationId: 'generation-operation-retry',
    method: 'POST',
    examplePath: '/api/v1/generation-operations/operation-1/retries',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'durable-generation',
    response: 'structured',
    owner: 'src/ts/server/generationOperations.ts#retryGenerationOperation',
  }),
  operation({
    key: 'generation-chat',
    family: 'generation',
    routeOperationId: 'generation-chat',
    method: 'POST',
    examplePath: '/api/v1/generate/chat',
    cache: 'no-cache',
    streaming: 'sse',
    durability: 'server-job',
    response: 'sse',
    owner: 'src/ts/process/request/serverChat.ts#requestServerChat',
  }),
  operation({
    key: 'generation-chat-reattach',
    family: 'generation',
    routeOperationId: 'generation-chat-reattach',
    method: 'GET',
    examplePath: '/api/v1/generate/chat/job-1/stream',
    cache: 'no-cache',
    streaming: 'sse',
    durability: 'server-job',
    response: 'sse',
    owner: 'src/ts/process/request/serverChat.ts#requestServerChatGeneration',
  }),
  operation({
    key: 'generation-chat-terminal-snapshot',
    family: 'generation',
    routeOperationId: 'generation-chat-terminal-snapshot',
    method: 'GET',
    examplePath: '/api/v1/generate/chat/job-1/terminal-snapshot',
    cache: 'no-store',
    streaming: 'binary',
    durability: 'server-job',
    response: 'binary',
    owner: 'src/ts/process/request/serverChat.ts#fetchDurableTerminalSnapshot',
  }),
  operation({
    key: 'generation-chat-cancel',
    family: 'generation',
    routeOperationId: 'generation-chat-cancel',
    method: 'DELETE',
    examplePath: '/api/v1/generate/chat/job-1',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'server-job',
    response: 'structured',
    owner: 'src/ts/process/request/serverChat.ts#cancelServerChatGeneration',
  }),
  operation({
    key: 'atomic-submit-caller-gate',
    family: 'raw-generation',
    routeOperationId: 'generation-operation-submit',
    method: 'POST',
    examplePath: '/api/v1/generation-operations',
    cache: 'unspecified',
    streaming: 'none',
    durability: 'durable-generation',
    response: 'structured',
    owner: 'src/ts/process/acceptedSendCoordinator.svelte.ts#coordinateAcceptedChatSend',
  }),
  operation({
    key: 'compatibility-chat-caller-gate',
    family: 'raw-generation',
    routeOperationId: 'generation-chat',
    method: 'POST',
    examplePath: '/api/v1/generate/chat',
    cache: 'no-cache',
    streaming: 'sse',
    durability: 'server-job',
    response: 'sse',
    owner: 'src/ts/process/index.svelte.ts#sendChat',
  }),
] as const satisfies readonly BrowserOperationBinding[]

export const BROWSER_RAW_GENERATION_OPERATION_IDS = {
  atomicSubmit: 'generation-operation-submit',
  compatibilityChat: 'generation-chat',
} as const satisfies Record<string, ProtocolRouteOperationId>

/** Browser concepts that intentionally do not identify an HTTP operation. */
export const BROWSER_OPERATION_NON_OVERLAPS = [
  {
    id: 'resource-purpose-vocabulary',
    family: 'resource',
    reason: 'browser-state-semantics',
    owner: 'packages/shared-core/src/resourceManifest.ts#RESOURCE_PURPOSES',
    detail: 'Render, interaction, mutation, generation, and editor-prefill purposes describe browser use.',
  },
  {
    id: 'resource-requirement-identity',
    family: 'resource',
    reason: 'browser-state-semantics',
    owner: 'packages/shared-core/src/resourceManifest.ts#RESOURCE_SURFACE_MANIFEST',
    detail: 'Surface requirement keys compose browser hydration and are not HTTP route identifiers.',
  },
  {
    id: 'resource-cache-record-keys',
    family: 'cache',
    reason: 'browser-persistence-semantics',
    owner: 'src/ts/server/resourceCache.ts#prepareResourceCacheRequest',
    detail: 'Local cache record keys and validators remain browser persistence details.',
  },
  {
    id: 'runtime-generation-uuids',
    family: 'generation',
    reason: 'runtime-instance-identity',
    owner: 'src/ts/server/generationOperations.ts#createProtocolUuid',
    detail: 'Per-attempt operation, message, retry, and job identifiers are runtime values, not route IDs.',
  },
  {
    id: 'generation-caller-header',
    family: 'raw-generation',
    reason: 'diagnostic-only',
    owner: 'src/ts/process/request/serverChat.ts#serverChatCaller',
    detail: 'x-risu-caller labels diagnostics and never grants server authority.',
  },
  {
    id: 'raw-generation-callsite-inventory',
    family: 'raw-generation',
    reason: 'browser-capability-gate',
    owner: 'src/ts/process/rawGenerationCallerAllowlist.test.ts#raw chat generation caller allowlist',
    detail: 'Source callsite inventory enforces browser coordination but does not identify an HTTP operation.',
  },
  {
    id: 'generation-preview-prompt-route',
    family: 'generation',
    reason: 'no-live-browser-adapter',
    owner: 'src/ts/process/request/serverChat.ts#serverChatCaller',
    detail: 'Preview-prompt mode currently uses generation-chat; no browser caller posts the dedicated preview route.',
  },
] as const satisfies readonly BrowserOperationNonOverlap[]

export interface BrowserOperationBindingCandidate extends Omit<BrowserOperationBinding, 'routeOperationId'> {
  routeOperationId: string
}

export interface BrowserOperationNonOverlapCandidate extends Omit<BrowserOperationNonOverlap, 'reason'> {
  reason: string
}

export function validateBrowserOperationBindings(bindings: readonly BrowserOperationBindingCandidate[]): string[] {
  const errors: string[] = []
  const catalogIds = new Set<string>()
  for (const descriptor of PROTOCOL_ROUTE_OPERATION_CATALOG) {
    if (catalogIds.has(descriptor.id)) errors.push(`duplicate shared route operation id: ${descriptor.id}`)
    catalogIds.add(descriptor.id)
  }

  const keys = new Set<string>()
  const familyOperations = new Set<string>()
  for (const binding of bindings) {
    if (keys.has(binding.key)) errors.push(`duplicate browser operation key: ${binding.key}`)
    keys.add(binding.key)
    const familyOperation = `${binding.family}:${binding.routeOperationId}`
    if (familyOperations.has(familyOperation)) {
      errors.push(`duplicate browser operation mapping: ${familyOperation}`)
    }
    familyOperations.add(familyOperation)
    if (!binding.owner.includes('#') || binding.owner.startsWith('#') || binding.owner.endsWith('#')) {
      errors.push(`invalid browser operation owner: ${binding.key}`)
    }

    const descriptor = findProtocolRouteOperationById(binding.routeOperationId as ProtocolRouteOperationId)
    if (!descriptor) {
      errors.push(`stale browser route operation id: ${binding.routeOperationId}`)
      continue
    }
    if (!protocolRouteOperationMatches(descriptor, binding.method, binding.examplePath)) {
      errors.push(`browser operation route mismatch: ${binding.key} -> ${binding.method} ${binding.examplePath}`)
    }
    for (const field of ['cache', 'streaming', 'durability', 'response'] as const) {
      if (binding[field] !== descriptor[field]) {
        errors.push(
          `browser operation ${field} mismatch: ${binding.key} expected ${descriptor[field]}, got ${binding[field]}`,
        )
      }
    }
  }
  return errors
}

export function validateBrowserOperationNonOverlaps(entries: readonly BrowserOperationNonOverlapCandidate[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const reasons = new Set<string>(BROWSER_OPERATION_NON_OVERLAP_REASONS)
  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate browser non-overlap id: ${entry.id}`)
    ids.add(entry.id)
    if (!reasons.has(entry.reason)) errors.push(`unknown browser non-overlap reason: ${entry.reason}`)
    if (!entry.owner.includes('#') || entry.owner.startsWith('#') || entry.owner.endsWith('#')) {
      errors.push(`invalid browser non-overlap owner: ${entry.id}`)
    }
    if (!entry.detail.trim()) errors.push(`empty browser non-overlap detail: ${entry.id}`)
  }
  return errors
}

const manifestErrors = [
  ...validateBrowserOperationBindings(BROWSER_OPERATION_BINDINGS),
  ...validateBrowserOperationNonOverlaps(BROWSER_OPERATION_NON_OVERLAPS),
]
if (manifestErrors.length > 0) {
  throw new Error(`Invalid browser operation manifest:\n${manifestErrors.join('\n')}`)
}
