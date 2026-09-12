# Plugins And MCP

Last audited: 2026-09-04.
Targeted source checks: 2026-09-12 (module organization, reader/writer runtime authority, and output-listener diagnostics).

Plugins and MCP tooling are browser runtime features with server-backed records.
Fastify stores plugin records, plugin storage, settings, and module state, but it
does not execute browser plugin code.

## Plugin Runtime

| Path | Purpose |
| --- | --- |
| `src/ts/plugins/plugins.svelte.ts` | V3-only plugin import/update/load, custom providers, command-backed state dispatch. |
| `src/ts/plugins/apiV3/v3.svelte.ts` | Plugin API V3 surface exposed to sandboxed plugins. |
| `src/ts/plugins/apiV3/factory.ts` | `SandboxHost` iframe/RPC bridge between app and plugin guest code. |
| `src/ts/plugins/apiV3/transpiler.ts`, `developMode.ts` | Plugin V3 transpilation and development-mode loading. |
| `src/ts/plugins/apiV3/risuai.d.ts` | Plugin V3 TypeScript declarations for plugin authors. |
| `src/ts/plugins/pluginPermissions.ts`, `pluginNetworkAccess.ts` | Exact-script capability grants and the public-only plugin network adapters. |
| `src/ts/plugins/pluginUpdates.ts`, `pluginIconSafety.ts` | Bounded explicit update flow and network-dead HTML/CSS/registered-icon sanitization. |
| `src/ts/plugins/pluginSafeClass.ts` | Safe wrappers and device-local storage gates. |
| `src/ts/plugins/unsupportedServerWriteGuard.ts` | Blocks Plugin API direct writes to fields unsupported in server-backed mode. |
| `src/ts/pluginCommands.ts` | Browser command wrappers for plugin records, provider selection, plugin storage, and settings-adjacent compatibility writes. |
| `src/ts/server/pluginImport.ts` | Server-backed plugin import/update helper with stale import guards. |
| `server/fastify/src/commands/plugins.ts`, `pluginStorage.ts` | Server validation for plugin records and plugin key/value JSON storage. |
| `server/fastify/src/pluginNetwork.ts`, `routes/proxy.ts` | DNS-pinned public-target validation and the dedicated plugin fetch proxy. |
| `src/ts/plugins/migrationGuide.md` | Plugin-author V3 migration and compatibility reference. |

Plugin startup is an explicit readiness step, not part of the minimal shell
load. `src/ts/bootstrap.ts` loads the plugin runtime resource, enabled plugins,
and synchronization after writer/resource startup. Runtime state in
`plugins.svelte.ts` moves through `idle`, `loading`, `error`, and `ready`.
V3 readiness waits for each guest's awaited top-level initialization to finish,
including display-hook registration. The host accepts only the current run's
initialization acknowledgement and rejects guest errors, teardown, or a
30-second initialization timeout. This also gates the first chat display parse.
A load
failure records the `plugins-ready` capability failure and blocks generation
recovery without discarding the coherent shell. The localized startup Retry
reruns plugin initialization and then generation recovery rather than replaying
already-completed writer/resource steps.

Plugin readiness is writer-dependent. Connected readers do not start the plugin
runtime, and a writer-to-reader transition stops it immediately. Active V3
instances capture client-session generation and writer authority, so callbacks
and mutations from a former writer fail their fence even if guest code settles
later. Reader mode keeps server-backed plugin/module records readable but does
not grant browser plugin execution or mutation authority.

Plugin records live in `Database.plugins` and use the plugin `name` as the
stable id. `currentPluginProvider` selects a plugin-defined provider when one is
active. Plugin providers remain browser compatibility surfaces; Fastify
chat/completion does not execute plugin provider code. Plugin V3 provider
registration also updates browser compatibility maps such as
`pluginV2.providers` / `providerOptions` and provider stores; unload cleanup is
guarded by provider ownership and active generation state. V3 selections use
the `pluginmodel:::<name>` model id. Success, failure, and streaming responses
preserve that full id, and an exhausted V3 plugin attempt returns its failure
instead of advancing to another fallback.

`getCurrentLorebookEntries` returns detached raw entries from the current
character, chat, and active client modules without exposing the server's
request-scoped activation or token-budget state. The fork hydrates a stubbed
current-character lorebook before returning the snapshot and fails closed when
that authoritative read is unavailable.

`readInlay` resolves an inlay asset id or legacy alias through the browser's
server-backed inlay catalog adapter, reads immutable bytes from
`/api/v1/assets/:id`, and returns the Plugin V3 data-string/metadata shape.

`addRisuChatListener('output', ...)` remains browser-local. The common
`applyServerBackedTerminal` client path fires it after the durable terminal
patch and final inlay projection are applied, so send, continue, regenerate,
and reattached job completion share the same detached-snapshot event; owner
unload removes the listener.

Output-listener execution requires current writer authority, runtime readiness,
and a current abort/session fence. When diagnostics collection is enabled it
emits only bounded run count, failure count, and duration metadata; comparison
and content-change facts remain unavailable. Late evidence is suppressed after
authority loss, and recorder failure cannot fail the listener flow. See
[Diagnostics](diagnostics.md#protocol-versions-and-provenance) for the safe
export boundary.

Plugin V3 code runs through an opaque-origin iframe RPC boundary nested inside
a trusted guard iframe. The outer guard contains only the RPC relay and uses
`frame-src 'none'` / `child-src 'none'`; that parent policy governs later
navigations of the nested guest, including navigation of the guest's own frame.
The inner guest sandbox grants scripts and modals, but not same-origin,
downloads, popups, or top-navigation privileges. Its own CSP also denies direct
connections, remote executable scripts, child frames, workers, objects, forms,
and base URLs. Inline guest scripts and styles remain available, while image,
font, and media sources are limited to local `data:` or `blob:` URLs. The guest
bootstrap uses inline-only script authorization instead of a readable nonce
that could be copied onto a remote script element. `navigate-to 'none'` remains
best-effort defense in depth for browsers that recognize it, while the outer
guard blocks nested-frame navigation. These controls reduce common egress paths
but are not a hostile-code network sandbox: DOM-compatible browser APIs such as
WebRTC can still contact public, private, local, metadata, or RisuAI targets.
Before any V3 code runs, the exact installed script must therefore receive the
script-bound `v3Runtime` trust grant. Denial skips execution. Only fully trusted
V3 plugins should receive it. A future Worker-only guest with a constrained,
declarative UI surface is the durable untrusted-plugin design. API functions
must accept and return serializable data, callback functions, marked remote
class instances, or abort signals.

V3 permission grants are bound to the plugin name, the exact running script
hash, and the requested capability. A source change therefore cannot reuse an
older grant. After the runtime trust gate, `risuFetch` and `nativeFetch` also
require the granular `network` capability and route only through authenticated
`/api/v1/proxy/plugin-fetch`; plugin input cannot select the ordinary generic or
local-network route or attach RisuAI service credentials. The browser rejects
obviously disallowed URLs before prompting. Fastify then parses the URL again,
resolves every address, rejects private, loopback, link-local, metadata, and
RisuAI service targets, and pins the approved public DNS result for the request.
Redirects are bounded; every `Location` target is parsed, resolved, revalidated,
and pinned as a new hop before it is followed, with sensitive credentials
removed when the origin changes. The ordinary first-party proxy path remains
available to app/provider integrations that intentionally need local services,
but it is not exposed by the plugin network adapters. This public-only rule
applies to those helper methods, not to every browser API available to trusted
DOM-compatible plugin code.

The capability catalog is `fetchLogs`, `db`, `mainDom`, `network`,
`pluginUpdate`, `replacer`, `provider`, `sendChat`, and `v3Runtime`. Grants are
device-local localforage state, not Fastify-backed or backed-up data; `db`,
`provider`, and `replacer` require periodic three-day reconfirmation. Import
also parses `allowedIPC`, but plugin-to-plugin delivery succeeds only when
sender and receiver mutually list each other.

The `mainDom` bridge additionally removes network-loading HTML/SVG elements
and attributes, rejects existing `<style>` content mutation, and accepts only a
layout/color/text CSS allowlist with network-valued CSS disabled. Its explicit
anchor helper creates user-clicked links in a new `noopener noreferrer` tab;
ordinary HTML insertion cannot create an automatic network load. These are
defense-in-depth controls after the V3 runtime trust decision.

Only API `3.0` plugin records are accepted. Source import throws
`UnsupportedPluginApiVersionError` for API `2.0`, `2.1`, or a missing
`//@api` declaration; server plugin commands independently reject every version
other than `3.0`. Runtime reconciliation validates the complete projected plugin
collection before loading enabled V3 instances, so an unsupported record fails
the load instead of being skipped. There is no V2-record import, migration, or
execution path. V3 still exposes deprecated V2-named compatibility shims and
maps. Server Lua scripting is separate from browser plugins.
[Prompt Assembly And Scripting](prompt-assembly-and-scripting.md) owns the
supported server Lua surface and its durable scripting effects.

Plugin update checks start only from an explicit user action. They require an
HTTPS, public-only URL and a `pluginUpdate` grant bound to the exact installed
script and declared update source. The consent prompt names both the plugin and
source. This capability permits only RisuAI's update check/download flow and is
distinct from the plugin runtime's `network` capability. Both operations use the
dedicated plugin proxy and per-redirect-hop validation. `checkPluginUpdate()`
reads at most a 4 KiB range probe, deduplicates concurrent requests, and keeps a
bounded 128-entry, five-minute LRU cache keyed by plugin name, exact script hash,
update URL, and installed version. Successful no-update checks are cached as
well as available updates; HTTP/network failures are not retained and can be
retried immediately. The explicit download action streams through the same
authorization path and rejects scripts larger than 8 MiB even when a server
ignores the requested range.

## Plugin Storage

- Server-backed plugin custom storage is `Database.pluginCustomStorage`, with
  client mutation adapters in `src/ts/pluginCommands.ts` and Fastify mutation
  ownership in `server/fastify/src/commands/pluginStorage.ts`.
- Device-local plugin storage wraps `localStorage`, IndexedDB, and localforage
  through safe prefixes. In Fastify mode it is disabled unless
  `pluginCompatibilityMode` is enabled, and remains plugin sandbox
  compatibility/cache storage rather than app database or backup persistence.

Plugin storage persists in the SQLite `plugin_custom_storage` table.
It is one shared global key map, so plugins must namespace their keys.
Plugin-record events use precise resource scopes: `pluginCollection` reads
only the plugin collection, `pluginProvider` reads only the `providers` settings
group, and deleting the active provider uses `pluginCollectionWithProvider` to
read both affected slices. Response-confirmed optimistic record/provider writes
advance those resource fences without a read, retaining any newer queued edit.
`pluginStorage` maps to the complete `pluginCustomStorage` collection so key
deletion, clear, and bulk replacement remove absent values without refreshing
unrelated app state. Pending per-key put/delete/bulk intents stay registered
through resource reconciliation and overlay both targeted and full refreshes,
so an older response cannot erase a newer optimistic storage edit. Plugin and
module records arrive through the collection resources; bootstrap contains no
durable record bodies. Those collection reads participate in the generic
authenticated SHA-256/IndexedDB resource cache, rather than a plugin-specific
bootstrap body cache.

Plugin API calls that patch settings, modules, characters, chats, lorebooks, or
scripts should use command-backed helpers. Unsupported direct resource keys stay
blocked in server-backed mode so plugin code cannot silently mutate projection
state. Deprecated database-bridge calls retained on the V3 API that write
unknown `setDatabaseLite` keys become plugin storage writes, while recognized
unsupported resource families such as `characters`, `botPresets`, `loreBook`,
and `pluginV2` are blocked instead of being shadowed into plugin storage.

## Fastify Command Boundary

Plugin commands are covered by the `commands` prefix entry in
`server/fastify/src/routeManifest.ts` and use the same auth, active-writer,
base-revision, and command-event contract as other command routes. Client
wrappers live in `src/ts/server/commands.ts`; route registration and validation
live in `server/fastify/src/routes/commands.ts`, with mutation logic in
`server/fastify/src/commands/plugins.ts` and `pluginStorage.ts`. The route and
storage contracts are guarded by
`server/fastify/__tests__/routeProtection.test.ts`,
`server/fastify/__tests__/commands.test.ts`, and
`server/fastify/__tests__/commandSettingsAndPluginStorageRange.test.ts`.

Plugin record `PATCH` requests contain only changed fields. Because JSON omits
`undefined`, `null` is reserved as a deletion sentinel for optional plugin
metadata; it is rejected for required fields, including the required `3.0`
API version, and full plugin creation records.
Module record patches use the same compact contract for optional module
metadata, including CJS and asset references. `POST /api/v1/commands/modules`
independently applies the shared MCP import predicate at creation. Stored MCP
rows can be globally enabled or durably deleted, but cannot be patched or
linked to character, chat, Persona, or loadout scopes.

### Module Organization

| Responsibility | Owner |
| --- | --- |
| Folder schema, payload validation, and folder normalization | `packages/protocol/src/moduleOrganization.ts` |
| Browser grouping, folder moves, and reordering projection | `src/ts/moduleOrganization.ts` |
| Optimistic mutations, rollback, and durable dependency ordering | `src/ts/moduleCommands.ts`, `src/ts/server/resourceOwnerMutationKeys.ts` |
| Server validation and revisioned transactions | `server/fastify/src/commands/modules.ts`, `server/fastify/src/routes/commands.ts` |
| Event catalog and resource read planning | `server/fastify/src/commands/events.ts`, `src/ts/server/resourceInvalidation.ts` |

Module library organization is a durable, presentation-only flat folder layer.
`moduleFolders` lives in the `modules` settings group, while an optional
`folderId` lives on each module collection row. Folder CRUD and ordering use
dedicated `/api/v1/commands/module-folders` commands; module order and folder
assignments are committed together through `/api/v1/commands/modules/reorder`.
Deleting a folder atomically removes the settings row and clears matching
module assignments without deleting modules. Folder-only events refresh the
modules settings group, while deletion refreshes that group plus the modules
collection (`moduleFolders` versus `moduleOrganization` event resources).
Standalone module import/export strips `folderId`; full `.risu`
snapshots retain folders and assignments. Activation, prompt assembly, and MCP
selection do not read folder metadata.

Focused guards: `src/ts/moduleOrganization.test.ts`,
`src/ts/moduleCommands.test.ts`, `server/fastify/__tests__/commands.test.ts`,
and `src/ts/server/resourceInvalidation.test.ts`.

### Plugin Storage And Collection Sequences

Single-key plugin-storage `PUT`/`DELETE` commands skip full database load and
touch only `plugin_custom_storage`; bulk storage reads and merges current
storage. Plugin collection commands are similarly scoped, and deleting the
active provider co-writes the provider selection settings.

Plugin and module collection diffs can fan out into several create/update/delete,
enable, and reorder commands. Those fan-outs run through
`runServerCommandSequence()` as one unit in the browser's global revision queue:
each accepted step supplies the next base revision, unrelated commands cannot
interleave, and the accumulated response events reconcile once after the
sequence. A retryable durable step remains staged for replay; terminal rejection
rolls back the still-owned optimistic remainder before earlier accepted events
are released.

## MCP Runtime

MCP and tool orchestration mostly lives under `src/ts/process/mcp/`. MCP
initialization reads MCP URLs from currently active modules via
`getModuleMcps()` in `src/ts/process/modules.ts`: global enabled modules,
current chat modules, current character modules, modules linked to the Persona
effective for the current chat, the selected Prompt Preset's
`moduleIntergration` (or the global fallback when no prompt preset is selected),
and the effective enabled Agent Preset's `moduleIntergration`.
The pure `resolveActiveModuleStates()` helper in `src/ts/moduleActivation.ts`
matches module ids or namespaces, deduplicates module rows, and preserves the
activation sources for runtime and UI consumers. This resolution is guarded by
`src/ts/moduleActivation.test.ts`,
`packages/shared-core/src/moduleIntegration.test.ts`, and
`src/ts/process/modules.test.ts`.
Initialization dedupes concurrent construction, removes stale clients when the
active URL inputs change, indexes tools with the first MCP URL winning duplicate
tool names, and isolates failed internal handshakes so other MCP clients remain
usable.

MCP/tool orchestration is browser-side and separate from model-hosted
function/tool dispatch. Fastify stores plugin/MCP-adjacent records and supports
command-backed Risu access writes, but normal Fastify chat/completion provider
dispatch does not execute MCP tools; see the server provider boundary in
[Providers And Models](providers-and-models.md#capability-table-and-dispatch-boundary).

| Path | Purpose |
| --- | --- |
| `src/ts/process/mcp/mcp.ts` | Runtime registry, URL parsing, tool discovery/calls, OAuth refresh persistence, module import helper. |
| `packages/shared-core/src/mcpIdentifier.ts` | Shared stored-MCP creation predicate; the browser path is a compatibility re-export. |
| `src/ts/process/mcp/mcplib.ts` | Remote Streamable HTTP MCP client with legacy SSE fallback. |
| `src/ts/server/mcpOAuthRefresh.ts`, `server/fastify/src/routes/mcpOAuthRefresh.ts` | Authenticated stable-identity bridge for server-owned persisted OAuth refresh credentials. |
| `server/fastify/src/mcpOAuthRefreshEgress.ts` | DNS-pinned, redirect-free, bounded token-endpoint validation and connection. |
| `src/ts/process/mcp/internalmcp.ts` | Base class for internal MCP-like clients. |
| `src/ts/process/mcp/pluginmcp.ts` | Plugin-registered MCP modules using `plugin:` identifiers. |
| `src/ts/process/mcp/risuaccess/` | Internal Risu access tools for characters, read-only chat history, and modules. |
| `src/ts/process/mcp/aiaccess.ts`, `googlesearchclient.ts`, `graphmem.ts`, `dice.ts`, `filesystemclient.ts` | Internal tool clients. |

Runtime MCP identifier forms:

- `internal:*` for bundled clients such as Risu access, AI access, filesystem,
  Google search, graph memory, and dice. The parser still recognizes
  `internal:googlesearch`, but the direct import picker does not offer it
  because Google Search credentials are unsupported in server-backed web mode.
- `plugin:*` for MCP modules registered by Plugin V3 code.
- Raw `http://` or `https://` identifiers for remote MCP servers using
  Streamable HTTP first and legacy SSE fallback.
- `stdio:{...}` wrappers. Runtime parsing requires a JSON `url`; command/args
  process launch is not supported. The wrapped URL is then handled like any
  other HTTP(S) runtime URL.

Bundled specialized tools fail closed at their local authority boundary. Dice
notation must be fully consumed, rolls at most 100 dice with at most 1,000,000
sides each, and returns an MCP-shaped error for invalid input. Graph memory
validates every stored entry before reading or appending, rejects malformed
state without overwriting it, and limits search depth to an integer from 1 to 8.
The File System client cannot revive a lost directory handle from a tool call;
its recovery response tells the user to reinitialize the MCP and select a
directory again.

Creation validation is intentionally shallower than runtime parsing.
`isImportableMCPIdentifier()` accepts raw HTTPS and loopback HTTP, plus any
non-whitespace `internal:`, `plugin:`, or `stdio:` payload. It does not parse a
`stdio:` wrapper. The direct import UI performs a handshake before creation, but
`.risum` and the server create route use only that shared syntactic predicate;
they can therefore persist a malformed/command-based wrapper or a wrapper whose
URL is remote plaintext HTTP. Runtime initialization may reject such a row. Do
not treat the import predicate as a complete transport or egress policy.

Plugin V3 exposes `risuai.registerMCP` and `risuai.unregisterMCP`, which add or
remove `plugin:` MCP clients in the browser registry. Registration alone does
not create a persisted MCP module row; activation still depends on active module
MCP URLs or additional runtime MCP lists. Registrations are owner/lifecycle
tracked and are removed automatically when the plugin unloads or reloads.

`internal:risuai` is always available as a call-only client. Risu access write
tools ask for user confirmation and dispatch command-backed writes where
Fastify mode supports them. Current Fastify-backed writes cover character info,
character lorebooks, character regex scripts, character Lua triggers, module
info, module lorebooks, module regex scripts, and module Lua triggers. Chat
Risu access is read-only today through `risu-get-chat-history`; character
additional asset reference edits still return an unsupported Fastify-mode
response.

These MCP tools write the durable character or module definitions; they do not
define how those records execute during server prompt assembly. Runtime
semantics for V2 conditions/effects, non-interactive Lua APIs, durable Lua and
script lore mutations, preserved script message indexes, and module CBS
visibility belong to
[Prompt Assembly And Scripting](prompt-assembly-and-scripting.md).

## Fastify-Mode Limits

Fastify-backed mode supports MCP module creation through both the direct MCP
import UI and `.risum` files. Direct import applies the shared predicate,
performs the MCP handshake/metadata lookup, creates the module metadata and info
lorebook, and dispatches command-backed module creation. Local `.risum` import
uploads one file to `POST /api/v1/import/module`; Fastify decodes it, normalizes
`mcp.url`, applies the same syntactic predicate, stores embedded assets, and
creates the module. Low-level-access confirmation uses a short-lived server
token, so the retry contains no file bytes. The `stdio:` limitation above still
applies.

Stored MCP rows remain a special module kind, not generally editable modules.
Normal module patch, script/lorebook/trigger definition, and
character/chat/loadout link operations target non-MCP rows. Global enable and
generic delete explicitly admit MCP ids: enable updates `enabledModules`, and
delete removes the stored row plus enabled/character/chat/loadout id references
through the ordinary revisioned module commands. It does not rewrite
`moduleIntergration` text. The module UI displays imported MCP rows, supports
those two global lifecycle actions, hides edit/export, and hides unsupported
scoped-link controls. Server behavior is guarded by
`server/fastify/__tests__/commands.test.ts`; UI restrictions are guarded by
`src/lib/Setting/Pages/Module/ModuleSettings.svelte.test.ts` and
`src/lib/Setting/Pages/Module/ModuleChatMenu.svelte.test.ts`. The import-picker
exclusion is guarded by `src/ts/process/mcp/mcp.test.ts`.
Command-based stdio MCPs remain unsupported by the browser runtime; only a
parseable URL-wrapped `stdio:{...}` row can initialize.

For both MCP and non-MCP `.risum` imports, supported source filename extensions
are retained for upload. Non-empty unsupported legacy filename tokens are
normalized by sniffing PNG/JPEG/WebP/GIF/AVIF signatures, with PNG as fallback,
while the original module asset tuple filename remains unchanged. Blank
filenames pass through and default to PNG in the asset saver.

OAuth refresh credentials for remote MCP servers persist in
`Database.authRefreshes` as `url`, `tokenUrl`, `refreshToken`, `clientId`, and
`clientSecret`. Optimistic patches write the `providers` settings group through
`/api/v1/commands/settings/providers`, upserting by exact MCP identifier (a raw
HTTP(S) URL or URL-wrapped `stdio` identifier).
Retryable failures retain the durable intent; terminal rejection rolls back the
attempted row only when it still owns that URL. Server projections mask the
refresh token and client secret. A masked row is refreshed through authenticated
`POST /api/v1/mcp/oauth/refresh` using only that stable MCP identity; Fastify
loads the matching raw row and never returns refresh credentials to the
browser. The `mcp-oauth-refresh` entry in `routeManifest.ts` requires
authentication without an active-writer lease; rotated-token persistence is a
server-owned targeted mutation. Refresh egress is bounded, DNS-pinned, and
redirect-free. Public endpoints require HTTPS, while local HTTP is allowed only
for a local MCP identity. If the upstream rotates the refresh token, Fastify
persists it through a targeted settings mutation and returns only the access
token. Newly
authorized, not-yet-projected raw rows retain a bounded direct refresh path, and
those credential-bearing requests are omitted from browser fetch diagnostics.
That direct path uses browser `fetchNative`; Fastify's DNS pinning and
redirect-free policy do not govern it.
Google Search MCP credentials are currently unsupported in server-backed web
mode. Remote MCP tool results may contain text, image/audio base64, or resource
payloads, but they are not server-persisted unless a later command stores them.

## UI Surfaces

Plugin V3 registers five visible surface families through
`src/ts/stores.svelte.ts`: `additionalSettingsMenu`,
`additionalFloatingActionButtons`, `additionalHamburgerMenu`, and
`additionalChatMenu`, plus sanitized chat-body panels through `chatPanelStore`
and `setChatPanel`. `src/ts/plugins/apiV3/v3.svelte.ts` replaces an existing
entry from the same plugin owner and removes owned entries on unload/reset;
`src/lib/Setting/Settings.svelte`, `src/lib/SideBars/Sidebar.svelte`, and
`src/lib/ChatScreens/DefaultChatScreen.svelte` consume the stores.
`src/ts/plugins/apiV3/v3.svelte.test.ts` guards registration, replacement, and
cleanup. UI placement is mapped in the
[Svelte Settings UI](../../src/docs/svelte-settings-ui.md),
[Svelte Navigation UI](../../src/docs/svelte-navigation-ui.md), and
[Svelte Chat UI](../../src/docs/svelte-chat-ui.md) guides.

V3 unload also releases owner-scoped document listeners, mutation observers,
plugin-channel listeners, pending sandbox work, and active stream ports. RPC
`ReadableStream` results cross the sandbox through pull-controlled
`MessagePort` bridges so plugin fetch/provider streaming keeps backpressure and
terminates promptly with its sandbox.

- `src/lib/Setting/Pages/PluginSettings.svelte` manages import, enable/delete,
  arguments, explicit update checks/install, and V3 development/hot reload.
- `src/lib/Playground/PlaygroundMCP.svelte` lists MCP metadata/tools and can run
  tool calls for debugging.
- `src/lib/Setting/Pages/Module/ModuleSettings.svelte` exposes validated direct
  MCP import and displays stored MCP rows. Global enable/delete works for MCP
  rows; edit/export and scoped linking remain unavailable.
