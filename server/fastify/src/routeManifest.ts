import {
  PROTOCOL_MUTATING_METHODS,
  PROTOCOL_ROUTE_OPERATION_CATALOG,
  isProtocolMutatingMethod,
  protocolRouteOperationMatches,
  type ProtocolRouteMethod,
  type ProtocolRouteOperationDescriptor,
  type ProtocolRouteOperationId,
  type ProtocolRoutePathMatch,
  type ProtocolRouteStreamingShape,
} from '@risuai/protocol/route-operation'

export {
  PROTOCOL_MUTATING_METHODS,
  isProtocolMutatingMethod,
  type ProtocolRouteMethod,
  type ProtocolRoutePathMatch,
  type ProtocolRouteStreamingShape,
}

export type ProtocolRouteAuthDecision = 'required' | 'public' | 'conditional' | 'diagnostics-read'

export type ProtocolRouteActiveWriterDecision =
  | 'active-writer'
  | 'auth-session'
  | 'not-applicable'
  | 'read-only-post'
  | 'runtime-generation'
  | 'runtime-proxy'
  | 'stateless-helper'
  | 'writer-registration'

export interface ProtocolRoutePolicy {
  id: ProtocolRouteOperationId
  auth: {
    decision: ProtocolRouteAuthDecision
    reason: string
  }
  activeWriter: {
    decision: ProtocolRouteActiveWriterDecision
    reason: string
  }
  notes?: string
}

export interface ProtocolRouteManifestEntry extends ProtocolRouteOperationDescriptor, ProtocolRoutePolicy {}

export const PROTOCOL_ROUTE_POLICIES = [
  {
    id: 'health',
    auth: {
      decision: 'public',
      reason: 'Health exposes only process/schema status.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only status route.',
    },
    notes: 'Intentional public health and schema revision surface.',
  },
  {
    id: 'auth-status',
    auth: {
      decision: 'public',
      reason: 'Clients need to discover whether setup or login is required.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only auth status route.',
    },
    notes: 'Intentional public auth-bootstrap probe.',
  },
  {
    id: 'auth-setup',
    auth: {
      decision: 'public',
      reason: 'First-run password setup happens before an authenticated browser exists.',
    },
    activeWriter: {
      decision: 'auth-session',
      reason: 'Writes auth metadata, not Risu domain state.',
    },
    notes: 'Intentional public exception; self-refuses once a password exists.',
  },
  {
    id: 'auth-login',
    auth: {
      decision: 'public',
      reason: 'Login exchanges the password for a registered browser public key.',
    },
    activeWriter: {
      decision: 'auth-session',
      reason: 'Writes trusted public-key auth metadata, not Risu domain state.',
    },
    notes: 'Intentional public login endpoint.',
  },
  {
    id: 'auth-crypto',
    auth: {
      decision: 'public',
      reason: 'Stateless compatibility hashing helper.',
    },
    activeWriter: {
      decision: 'stateless-helper',
      reason: 'Does not persist state.',
    },
    notes: 'Intentional public helper; request body is transformed only in memory.',
  },
  {
    id: 'bootstrap',
    auth: {
      decision: 'required',
      reason: 'Bootstrap returns authenticated runtime and session metadata.',
    },
    activeWriter: {
      decision: 'writer-registration',
      reason: 'Writer-intent bootstrap can latch the latest session after any live-writer confirmation handshake.',
    },
  },
  {
    id: 'diagnostics-read',
    auth: {
      decision: 'required',
      reason: 'Recent diagnostics are available only to authenticated clients.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only bounded diagnostic metadata.',
    },
  },
  {
    id: 'support-diagnostics-read',
    auth: {
      decision: 'diagnostics-read',
      reason: 'Independent support credential authorizes only sanitized diagnostics reads.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Support access grants no application or writer authority.',
    },
  },
  {
    id: 'startup-telemetry',
    auth: {
      decision: 'required',
      reason: 'Startup diagnostics describe an authenticated browser session.',
    },
    activeWriter: {
      decision: 'stateless-helper',
      reason: 'Emits bounded diagnostic metadata without mutating authoritative user state.',
    },
  },
  {
    id: 'settings-read',
    auth: {
      decision: 'required',
      reason: 'Settings contain private user configuration and masked provider credentials.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only settings route.',
    },
  },
  {
    id: 'shell-resource-read',
    auth: {
      decision: 'required',
      reason: 'The coherent shell contains private settings and character navigation metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only versioned shell projection.',
    },
  },
  {
    id: 'standalone-setting-resource-read',
    auth: {
      decision: 'required',
      reason: 'Focused legacy settings projections contain private user configuration.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only focused settings projection.',
    },
  },
  {
    id: 'inlay-catalog-read',
    auth: {
      decision: 'required',
      reason: 'The inlay catalog contains private user asset metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only inlay catalog route.',
    },
  },
  {
    id: 'settings-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware settings reads contain private user configuration and masked provider credentials.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware settings reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'settings-group-read',
    auth: {
      decision: 'required',
      reason: 'Targeted settings groups contain private user configuration and masked provider credentials.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only targeted settings route.',
    },
  },
  {
    id: 'settings-group-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware settings-group reads contain private user configuration and masked provider credentials.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware settings-group reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'collections-read',
    auth: {
      decision: 'required',
      reason: 'Collections contain private user presets, modules, plugins, and storage.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only collection route.',
    },
  },
  {
    id: 'collections-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware collection reads contain private user presets, modules, plugins, and storage.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware collection reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'collection-read',
    auth: {
      decision: 'required',
      reason: 'Targeted collections contain private user presets, modules, plugins, or storage.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only targeted collection route.',
    },
  },
  {
    id: 'collection-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware targeted collection reads contain private user presets, modules, plugins, or storage.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware targeted collection reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'character-aggregate-read',
    auth: {
      decision: 'required',
      reason: 'The compatibility aggregate returns private character and chat metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only compatibility aggregate route.',
    },
  },
  {
    id: 'character-aggregate-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware compatibility aggregate reads return private character and chat metadata.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware compatibility aggregate reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'characters-read',
    auth: {
      decision: 'required',
      reason: 'Character summaries contain private character presentation and navigation metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only versioned character summary route.',
    },
  },
  {
    id: 'characters-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware character summary reads return private presentation and navigation metadata.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware character summary reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'character-order-read',
    auth: {
      decision: 'required',
      reason: 'Character order is private user presentation state.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only character order route.',
    },
  },
  {
    id: 'character-selection-read',
    auth: {
      decision: 'required',
      reason: 'Character selection returns private selection and interaction state.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only character selection route.',
    },
  },
  {
    id: 'character-read',
    auth: {
      decision: 'required',
      reason: 'Character detail returns private character and chat metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only character detail route.',
    },
  },
  {
    id: 'character-greeting-translations-read',
    auth: {
      decision: 'required',
      reason: 'Greeting translations contain private character-derived provider output.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only greeting translation projection.',
    },
  },
  {
    id: 'chat-messages-read',
    auth: {
      decision: 'required',
      reason: 'Chat message reads return private conversation history.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only chat message route.',
    },
  },
  {
    id: 'chat-messages-bulk-read',
    auth: {
      decision: 'required',
      reason: 'Bulk chat reads return private conversation histories.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Bulk chat reading is read-only; POST carries a potentially large id list.',
    },
  },
  {
    id: 'chat-lore-token-counts',
    auth: { decision: 'required', reason: 'Lore token counts describe private chat context.' },
    activeWriter: { decision: 'not-applicable', reason: 'Read-only evaluation on an isolated chat copy.' },
  },
  {
    id: 'chat-display-sources',
    auth: {
      decision: 'required',
      reason: 'Intermediate display text can contain private transcript and script output.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Display transforms use isolated per-target scriptstate and never persist their deltas.',
    },
    notes:
      'Returns disposable intermediate displaySource text; raw messages and chat scriptstate remain authoritative.',
  },
  {
    id: 'character-lorebook-read',
    auth: {
      decision: 'required',
      reason: 'Character lorebook reads return private prompt context.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only character lorebook route.',
    },
  },
  {
    id: 'character-lorebook-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware character lorebook reads return private prompt context.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware character lorebook reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'character-lorebooks-bulk-read',
    auth: {
      decision: 'required',
      reason: 'Bulk character lorebook reads return private prompt context.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Bulk lorebook reading is read-only; POST carries a potentially large id list.',
    },
  },
  {
    id: 'legacy-preset-read',
    auth: {
      decision: 'required',
      reason: 'Legacy preset detail can contain private provider configuration.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only legacy preset route.',
    },
  },
  {
    id: 'legacy-preset-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware legacy preset reads can contain private provider configuration.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware legacy preset reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'prompt-preset-template-read',
    auth: {
      decision: 'required',
      reason: 'Prompt preset templates contain private user prompt content.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only prompt preset template route.',
    },
  },
  {
    id: 'prompt-preset-template-cache-read',
    auth: {
      decision: 'required',
      reason: 'Hash-aware prompt preset template reads contain private user prompt content.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Hash-aware prompt template reading is read-only; POST carries the client cache inventory.',
    },
  },
  {
    id: 'risusave-import',
    auth: {
      decision: 'required',
      reason: 'Risu save import replaces repository state.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Import commits server-owned database and asset metadata.',
    },
  },
  {
    id: 'risusave-bundle-import',
    auth: {
      decision: 'required',
      reason: 'Bundle import replaces repository state and registers bundled assets.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Bundle import commits server-owned database and asset metadata.',
    },
  },
  {
    id: 'risusave-export',
    auth: {
      decision: 'required',
      reason: 'Export returns the persisted user database.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only repository export.',
    },
  },
  {
    id: 'risusave-bundle-export',
    auth: {
      decision: 'required',
      reason: 'Bundle export returns the persisted user database and assets.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only repository export.',
    },
  },
  {
    id: 'risusave-local-backup-export',
    auth: {
      decision: 'required',
      reason: 'Local backup export returns the persisted user database and assets.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only repository export.',
    },
  },
  {
    id: 'realm-character-import',
    auth: {
      decision: 'required',
      reason: 'Realm import creates characters and stores fetched assets.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Realm import commits asset metadata and character state.',
    },
  },
  {
    id: 'local-character-card-import',
    auth: {
      decision: 'required',
      reason: 'Local character-card imports contain private card data and embedded assets.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Character-card import registers assets and creates a character.',
    },
  },
  {
    id: 'local-module-import',
    auth: {
      decision: 'required',
      reason: 'Local module imports contain private module definitions and embedded assets.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Module import registers assets and creates a module.',
    },
  },
  {
    id: 'command-mutation-receipt-ack',
    auth: {
      decision: 'required',
      reason: 'Receipt acknowledgement deletes authenticated durable command replay metadata.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Only the current writer may acknowledge durable mutation intents after local outbox deletion.',
    },
    notes: 'Operational idempotency metadata only; does not bump the user-data revision or emit a command event.',
  },
  {
    id: 'commands',
    auth: {
      decision: 'required',
      reason: 'Command routes mutate revision-tracked user state.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Commands commit server-owned JSON/SQLite state.',
    },
  },
  {
    id: 'bardwiki-vault-export',
    auth: {
      decision: 'required',
      reason: 'BardWiki vault exports contain private Markdown memory documents.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only deterministic BardWiki vault export.',
    },
  },
  {
    id: 'bardwiki-chat-read',
    auth: {
      decision: 'required',
      reason: 'BardWiki chat resources contain private memory documents and job provenance.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only targeted BardWiki chat resource.',
    },
  },
  {
    id: 'bardwiki-document-read',
    auth: {
      decision: 'required',
      reason: 'BardWiki document reads return private Markdown memory content.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only targeted BardWiki document resource.',
    },
  },
  {
    id: 'bardwiki-document-versions-read',
    auth: {
      decision: 'required',
      reason: 'BardWiki version reads return private historical Markdown memory content.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only cursor-paged BardWiki version resource.',
    },
  },
  {
    id: 'bardwiki-receipts-read',
    auth: {
      decision: 'required',
      reason: 'BardWiki receipts expose private transcript provenance and status.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only cursor-bounded BardWiki receipt resource.',
    },
  },
  {
    id: 'bardwiki-job-retry',
    auth: {
      decision: 'required',
      reason: 'BardWiki job status contains private memory activity.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Retry changes operational durable job state without changing the domain revision.',
    },
  },
  {
    id: 'bardwiki-job-cancel',
    auth: {
      decision: 'required',
      reason: 'BardWiki job status contains private memory activity.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Cancellation changes operational durable job state without changing the domain revision.',
    },
  },
  {
    id: 'events',
    auth: {
      decision: 'required',
      reason: 'Events reveal command and memory activity for the user database.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Authenticated observe-only SSE route.',
    },
    notes: 'Authenticated streaming route; intentionally not writer-gated.',
  },
  {
    id: 'asset-upload',
    auth: {
      decision: 'required',
      reason: 'Asset upload writes repository asset metadata and blobs.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Asset upload can bump the repository revision.',
    },
  },
  {
    id: 'asset-bulk-upload',
    auth: {
      decision: 'required',
      reason: 'Bulk asset upload writes repository asset metadata and blobs.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Bulk asset upload can bump the repository revision.',
    },
  },
  {
    id: 'asset-read',
    auth: {
      decision: 'public',
      reason: 'Content-addressed asset ids are immutable and safe to serve directly.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only immutable asset bytes.',
    },
    notes: 'Intentional public asset read/head exception.',
  },
  {
    id: 'asset-exists',
    auth: {
      decision: 'public',
      reason: 'Existence probe reveals only missing content-addressed asset ids.',
    },
    activeWriter: {
      decision: 'read-only-post',
      reason: 'Read-only probe uses POST to carry a potentially large id list.',
    },
    notes: 'Intentional public read-only POST exception.',
  },
  {
    id: 'backup-mutations',
    auth: {
      decision: 'required',
      reason: 'Backup mutations create, restore, or delete persisted snapshots.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Backup mutations affect server-owned backup or repository state.',
    },
  },
  {
    id: 'storage-usage',
    auth: {
      decision: 'required',
      reason: 'Storage totals describe private server data.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only file sizes and filesystem capacity.',
    },
  },
  {
    id: 'backup-list',
    auth: {
      decision: 'required',
      reason: 'Backup listing exposes persisted snapshot metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only backup listing.',
    },
  },
  {
    id: 'request-history-list',
    auth: {
      decision: 'required',
      reason: 'Request history contains private prompts, responses, and chat metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only request-history listing.',
    },
  },
  {
    id: 'request-history-detail',
    auth: {
      decision: 'required',
      reason: 'Request history records contain private prompts and responses.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only request-history detail.',
    },
  },
  {
    id: 'request-history-delete',
    auth: {
      decision: 'required',
      reason: 'Deleting a request-history record mutates private persisted history.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Only the current writer may delete persisted request-history records.',
    },
  },
  {
    id: 'push-vapid-public-key',
    auth: {
      decision: 'public',
      reason: 'The VAPID public key is intentionally public browser subscription metadata.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only push configuration route.',
    },
  },
  {
    id: 'push-subscription-create',
    auth: {
      decision: 'required',
      reason: 'Push subscriptions register an authenticated browser device.',
    },
    activeWriter: {
      decision: 'auth-session',
      reason: 'Writes browser notification credentials, not revision-tracked user state.',
    },
  },
  {
    id: 'push-subscription-delete',
    auth: {
      decision: 'required',
      reason: 'Push subscription removal unregisters an authenticated browser device.',
    },
    activeWriter: {
      decision: 'auth-session',
      reason: 'Writes browser notification credentials, not revision-tracked user state.',
    },
  },
  {
    id: 'mcp-oauth-refresh',
    auth: {
      decision: 'required',
      reason: 'MCP OAuth refresh uses a server-owned stored refresh credential selected by stable MCP identity.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Refreshes an upstream access token without mutating local durable state.',
    },
  },
  {
    id: 'embedding-operations',
    auth: {
      decision: 'required',
      reason: 'Remote embeddings can use server-owned provider credentials.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Embedding dispatch does not mutate local durable state.',
    },
  },
  {
    id: 'provider-operations',
    auth: {
      decision: 'required',
      reason: 'Provider operations can use server-owned provider credentials for fixed upstream reads.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Fixed provider catalog and account reads do not mutate local durable state.',
    },
  },
  {
    id: 'openai-transcription',
    auth: {
      decision: 'required',
      reason: 'Transcription uploads use a server-owned OpenAI credential and contain private media.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Transcription forwards media without mutating local durable state.',
    },
  },
  {
    id: 'tts-synthesis',
    auth: {
      decision: 'required',
      reason: 'TTS synthesis can use server-owned provider credentials and private character settings.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'TTS synthesis forwards a bounded request without mutating durable state.',
    },
  },
  {
    id: 'image-generation',
    auth: {
      decision: 'required',
      reason: 'Image generation can use server-owned provider credentials and incur upstream cost.',
    },
    activeWriter: {
      decision: 'runtime-generation',
      reason: 'Generates an image without mutating local durable state.',
    },
  },
  {
    id: 'proxy-fetch',
    auth: {
      decision: 'required',
      reason: 'Generic proxy can access caller-selected upstream URLs.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Forwards a request without local durable writes.',
    },
  },
  {
    id: 'proxy-plugin-fetch',
    auth: {
      decision: 'required',
      reason: 'Plugin-scoped proxy requests carry user-approved data to caller-selected public URLs.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason:
        'Forwards bounded DNS-pinned public request hops, revalidating each redirect, without local durable writes.',
    },
  },
  {
    id: 'proxy-stream-job-create',
    auth: {
      decision: 'required',
      reason: 'Proxy stream jobs can access caller-selected local/private URLs.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Creates only process-local proxy job state.',
    },
  },
  {
    id: 'proxy-stream-job-cancel',
    auth: {
      decision: 'required',
      reason: 'Proxy stream job cancellation controls an authenticated runtime job.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Deletes only process-local proxy job state.',
    },
  },
  {
    id: 'proxy-stream-job-websocket',
    auth: {
      decision: 'required',
      reason: 'WebSocket attachment observes an authenticated proxy stream job.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Observe-only attachment to process-local proxy job state.',
    },
  },
  {
    id: 'hub-proxy',
    auth: {
      decision: 'conditional',
      reason: 'Public GET/HEAD/OPTIONS without override mirror legacy hub reads; all other hub requests require auth.',
    },
    activeWriter: {
      decision: 'runtime-proxy',
      reason: 'Hub routes forward upstream and do not mutate local durable state.',
    },
    notes: 'GET/HEAD/OPTIONS are public only when x-risu-node-path is absent.',
  },
  {
    id: 'legacy-storage-list',
    auth: {
      decision: 'required',
      reason: 'Legacy storage list exposes server-owned compatibility files.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only legacy storage list.',
    },
  },
  {
    id: 'legacy-storage-read',
    auth: {
      decision: 'required',
      reason: 'Legacy storage read returns server-owned compatibility file bytes.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only legacy storage read.',
    },
  },
  {
    id: 'legacy-storage-exists',
    auth: {
      decision: 'required',
      reason: 'Legacy storage existence check reveals server-owned compatibility filenames.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only legacy storage existence check.',
    },
  },
  {
    id: 'legacy-storage-write',
    auth: {
      decision: 'required',
      reason: 'Legacy storage write updates server-owned compatibility files.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Legacy storage write mutates server-owned compatibility files.',
    },
  },
  {
    id: 'legacy-storage-remove',
    auth: {
      decision: 'required',
      reason: 'Legacy storage remove deletes server-owned compatibility files.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Legacy storage remove mutates server-owned compatibility files.',
    },
  },
  {
    id: 'generation-completion',
    auth: {
      decision: 'required',
      reason: 'Completion dispatch can use server-side provider secrets.',
    },
    activeWriter: {
      decision: 'runtime-generation',
      reason: 'Provider completion is a runtime request without local durable writes.',
    },
  },
  {
    id: 'generation-operation-submit',
    auth: {
      decision: 'required',
      reason: 'Atomic generation acceptance reads and mutates the private transcript.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Atomic generation acceptance appends and owns durable generation intent.',
    },
  },
  {
    id: 'generation-operation-status',
    auth: {
      decision: 'required',
      reason: 'Operation status exposes private accepted-send lifecycle state.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only exact operation authority probe.',
    },
  },
  {
    id: 'generation-operation-stream',
    auth: {
      decision: 'required',
      reason: 'Exact-attempt reattach observes an authenticated generation stream.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only observe path for an exact operation attempt.',
    },
  },
  {
    id: 'generation-operation-cancel',
    auth: {
      decision: 'required',
      reason: 'Operation cancellation controls private durable generation work.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Cancellation records a durable lifecycle fence.',
    },
  },
  {
    id: 'generation-operation-retry',
    auth: {
      decision: 'required',
      reason: 'Operation retry launches an exact retained generation intent.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Retry reserves and launches a new durable attempt.',
    },
  },
  {
    id: 'generation-effect-status',
    auth: {
      decision: 'required',
      reason: 'Effect receipts expose private generation automation state.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only exact generation effect probe.',
    },
  },
  {
    id: 'generation-effect-claim',
    auth: {
      decision: 'required',
      reason: 'Claiming grants the exact browser generation effect delivery authority.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Only the active writer may claim durable or observable generation effects.',
    },
  },
  {
    id: 'generation-effect-lease',
    auth: {
      decision: 'required',
      reason: 'Lease renewal extends the exact browser generation effect delivery authority.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Only the active writer may renew its generation effect claim lease.',
    },
  },
  {
    id: 'generation-effect-receipt',
    auth: {
      decision: 'required',
      reason: 'Effect completion receipts are private durable operation metadata.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Only the active writer may settle its generation effect claim.',
    },
  },
  {
    id: 'generation-chat',
    auth: {
      decision: 'required',
      reason: 'Chat generation assembles prompts from the user database.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Chat generation can persist results and generation-time side effects.',
    },
  },
  {
    id: 'generation-chat-reattach',
    auth: {
      decision: 'required',
      reason: 'Reattach observes an authenticated durable chat-generation job.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only observe path for durable generation.',
    },
    notes: 'Authenticated observe-only special case; intentionally not writer-gated.',
  },
  {
    id: 'generation-chat-terminal-snapshot',
    auth: {
      decision: 'required',
      reason: 'Terminal snapshot fetch observes retained authenticated durable generation output.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only retained terminal snapshot for durable reattach.',
    },
    notes: 'Authenticated observe-only side channel; retained only for the generation job grace window.',
  },
  {
    id: 'generation-chat-cancel',
    auth: {
      decision: 'required',
      reason: 'Generation cancel controls an authenticated durable generation job.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Cancel is authorized by the current active writer during writer handoff.',
    },
  },
  {
    id: 'generation-preview-prompt',
    auth: {
      decision: 'required',
      reason: 'Prompt preview assembles from the user database and provider settings.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Prompt preview can run generation-time memory planning side effects.',
    },
  },
  {
    id: 'memory-job-create',
    auth: {
      decision: 'required',
      reason: 'Memory job creation writes durable SQLite job state.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Memory job creation mutates server-owned job state.',
    },
  },
  {
    id: 'memory-job-list',
    auth: {
      decision: 'required',
      reason: 'Memory job list exposes user chat memory job state.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only memory job listing.',
    },
  },
  {
    id: 'memory-job-cancel',
    auth: {
      decision: 'required',
      reason: 'Memory job cancellation writes durable SQLite job state.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Memory job cancellation mutates server-owned job state.',
    },
  },
  {
    id: 'memory-chunks',
    auth: {
      decision: 'required',
      reason: 'Memory chunks expose user chat memory content.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only memory chunk route.',
    },
  },
  {
    id: 'memory-summaries',
    auth: {
      decision: 'required',
      reason: 'Memory summaries expose user chat memory content.',
    },
    activeWriter: {
      decision: 'not-applicable',
      reason: 'Read-only memory summary route.',
    },
  },
  {
    id: 'memory-summary-update',
    auth: {
      decision: 'required',
      reason: 'Memory summary editing changes user chat memory content and metadata.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Memory summary editing mutates server-owned memory state.',
    },
  },
  {
    id: 'memory-summary-delete',
    auth: {
      decision: 'required',
      reason: 'Memory summary deletion changes user chat memory content.',
    },
    activeWriter: {
      decision: 'active-writer',
      reason: 'Memory summary deletion mutates server-owned memory state.',
    },
  },
] as const satisfies readonly ProtocolRoutePolicy[]

const policyById = new Map<ProtocolRouteOperationId, ProtocolRoutePolicy>()
for (const policy of PROTOCOL_ROUTE_POLICIES) {
  if (policyById.has(policy.id)) throw new Error(`Duplicate protocol route policy id: ${policy.id}`)
  policyById.set(policy.id, policy)
}

export const PROTOCOL_ROUTE_MANIFEST: readonly ProtocolRouteManifestEntry[] = PROTOCOL_ROUTE_OPERATION_CATALOG.map(
  (operation) => {
    const policy = policyById.get(operation.id)
    if (!policy) throw new Error(`Missing protocol route policy for operation: ${operation.id}`)
    return { ...operation, ...policy }
  },
)

if (policyById.size !== PROTOCOL_ROUTE_OPERATION_CATALOG.length) {
  throw new Error('Protocol route policy and operation catalogs must have exact id parity')
}

export function protocolRouteMatches(entry: ProtocolRouteManifestEntry, method: string, path: string): boolean {
  return protocolRouteOperationMatches(entry, method, path)
}

export function findProtocolRouteDecisions(method: string, path: string): ProtocolRouteManifestEntry[] {
  const matches = PROTOCOL_ROUTE_MANIFEST.filter((entry) => protocolRouteMatches(entry, method, path))
  const bestRank = Math.max(-1, ...matches.map((entry) => routeMatchRank(entry.match)))
  return matches.filter((entry) => routeMatchRank(entry.match) === bestRank)
}

export function findProtocolRouteDecision(method: string, path: string): ProtocolRouteManifestEntry | undefined {
  return findProtocolRouteDecisions(method, path)[0]
}

export function routeRequiresActiveWriter(method: string, path: string): boolean {
  return findProtocolRouteDecision(method, path)?.activeWriter.decision === 'active-writer'
}

function routeMatchRank(match: ProtocolRoutePathMatch): number {
  if (match === 'exact') return 2
  if (match === 'pattern') return 1
  return 0
}
