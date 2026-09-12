# Intermediate Display

Consolidated from targeted source checks on 2026-09-12 covering the shared wire
contract, scoped server transform, cache and queue, browser bridge, render
fences, and bounded diagnostics.

This guide owns the cross-runtime `editdisplay` pipeline. Prompt-generation
semantics remain in
[Prompt Assembly And Scripting](prompt-assembly-and-scripting.md); transcript
presentation, hydration skeletons, and final DOM behavior remain in
[Svelte Chat UI](../../src/docs/svelte-chat-ui.md); Markdown, styling, and
sanitization remain browser-owned in
[Client Runtime](../../src/docs/client-runtime.md#rendered-markup-sanitization).

## Transform Boundary

Fastify owns the expensive intermediate transform for supported mounted chat
rows through `POST /api/v1/chats/:chatId/display-sources`. The browser supplies
the exact string after its first additional-asset pass. For each target the
server clones authoritative script state, applies Lua `editDisplay`, then the
declarative V2 display trigger, then bounded regex/CBS processing across global,
active-preset, character, and module definitions. A `finally` cleanup restores
the target's script-state snapshot before the next target. The browser resumes
with the optional second asset pass, inlays, thought/tool
markup, Markdown, style handling, sanitization, and DOM behavior.

The wire `displaySource` and process-local caches are never persisted as message
content. The POST is read-only. Every target starts from an isolated copy of
authoritative chat script state. Lua and V2 display-variable writes may affect
the rest of that target's pipeline, then are discarded before another target.
Rendering order, retries, viewport mounting, and cache reuse therefore cannot
mutate SQLite, sibling targets, or authoritative chat state.

`packages/protocol/src/displaySource.ts` owns the request, result, SSE event,
limits, and compatibility schemas. `server/fastify/src/routes/displaySources.ts`
owns route policy and orchestration. The route requires application auth but is
available to connected readers without acquiring writer ownership.

## Scoped Preparation And Isolation

The route loads and strictly validates only the selected character, chat and
transcript, selected prompt/persona dependencies, module activation identities,
and the activation-winning module bodies. It does not scan inactive modules,
unrelated prompt/persona rows, unrelated character/chat payloads, or asset
metadata. A generation-input shape outside the narrow decoder is a handled
compatibility boundary: HTTP 200 returns one
`client_fallback` / `scope_input_incompatible` result per target. Malformed
stored JSON, storage faults, invariant failures, and unexpected exceptions
remain server errors. Fallback never normalizes or rewrites the rejected row.

`server/fastify/src/displayModuleCache.ts` reuses selected parsed module bodies
per SQLite handle and content token. A position-only lookup avoids
materializing cached JSON. The LRU retains at most 256 bodies and 64 MiB of
charged size; that charge includes JSON UTF-16/property allowance and
object/array overhead and is not a heap measurement. Oversized bodies bypass
reuse. Cached module definitions are deeply frozen. Module writes retire the
whole body cache; chat-only changes retain it. Legacy embedded bodies use the
uncached path.

Immutable active modules also retain weakly held digests of display dependency
fields. The `editdisplay-v3-module-digests` fingerprint combines ordered module
digests with current character/chat/settings dependencies. A compatible batch
canonicalizes and hashes shared transcript and scripting dependencies once,
then combines that digest with each target's identity and source digest.
Unchanged warm module assets are neither parsed nor serialized again.

## Browser Batching And Streaming

`src/ts/server/displaySources.ts` batches mounted rows from the same chat,
reports an ephemeral page ID plus language and viewport, and fences each result
by request key, source hash, context fingerprint, target identity, and
projection epoch. `ChatBodyParseMemo` sits above the bridge, so a memo hit makes
no request and a pending replacement leaves the last good body visible.

Same-namespace work is registered before source and context hashing completes;
the zero-delay flush waits for all registered preparations. Digest completion
order therefore cannot split concurrently requested rows into separate
revision-lane operations. Requests split on target count and aggregate UTF-8
source bytes. Work admitted while a response is active collects for a later
batch instead of reserving one revision-lane operation per row.

The client may send `priorityKeys` for foreground targets and negotiate a
finite SSE stream with `Accept: text/event-stream`. At final dispatch it chooses
the nearest three distinct ranked logical rows, including all display layers.
Viewport ranks refresh on layout/scroll and are consulted
after command-lane/auth waits. SSE emits one `result` per target and a terminal
`done`, `invalidated`, or `error`; it bounds writes and aborts on disconnect or
buffer overflow. Auth/validation failures before the first frame remain HTTP
errors. JSON remains the compatibility response for older clients.

`server/fastify/src/displaySourceQueue.ts` keeps exclusive execution through a
complete target and its cleanup, then yields for I/O and newly queued foreground
work. Prepared scope and budgets survive scheduling turns. Request async context
is rebound to each queued operation. Revision, lineage, writer, and module-token
postconditions run around targets and at completion. A late change emits
terminal invalidation even after earlier results were delivered.

Writer batches keep the shared command revision lane until the bridge validates
the terminal SSE event and ingests every response revision; reader batches run
independently. Invalidation retires
the bridge result, changes the finalized-HTML memo epoch, and advances the
affected render owner's reload token. EOF or errors settle unfinished targets
through existing fallbacks; malformed or duplicate events retire partial
projections. Chat, session, or namespace changes abort both fetch and body
consumption.

## Fallback And Reader Behavior

With current writer access, the browser `processScriptFull` path is the complete
fallback for browser `editdisplay` plugins, unsupported fuzzy dynamic assets,
an old server, stale identity/revision/context, and transport failure. Readers
use the isolated server bridge but fall back to readable source with localized
limited-display feedback. They never run general client scripts, plugin hooks,
or provider effects.

Growing generation prefixes are marked streaming. Matching pending prefixes
coalesce, while completed server results bypass the stable-row LRU. Stable
completed rows may reuse server and browser caches. Final Markdown, CSS scoping,
DOMPurify, blob URLs, metadata, and DOM activation remain browser-owned.

## Activation And Cache Namespaces

`src/ts/process/regexDisplayActivation.ts` owns the three-second regex-display
activation debounce; `src/ts/process/regexDisplayReload.ts` selects scoped
reload dependencies. Character, module, prompt-preset/root, and global edits
have independent timers. Consumers derive a reload token only from regex owners
active for their character/chat, so unrelated edits do not reparse mounted
rows.

Character-sidebar definitions first use a 300 ms trailing draft debounce in
`src/ts/server/scriptDefinitionOwner.svelte.ts`. Display activation flushes the
draft and waits for final durable settlement before advancing the owner token;
a failed save leaves the old display active. Send, continue, and regenerate
flush the draft but wait only for immediate dispatch, so queued or failed
persistence blocks generation instead of assembling against unsaved changes.

The server `DisplaySourceCache` retains at most four recently active namespaces
keyed by database lineage, writer epoch, ephemeral page session, language, both
viewport dimensions, and protocol version. Returning to an exact context may
reuse its entries; different contexts cannot cross-hit. Its default aggregate
limits are 512 entries and 16 MiB, with a 512 KiB per-entry ceiling. Namespace
and entry eviction are LRU-bounded, and late completion from an evicted
namespace cannot repopulate it. Target keys use SHA-256 over canonical display
dependencies and include the transform version.

The browser separately keeps an entry-count-bounded LRU of 512 completed stable
results plus in-flight deduplication. It clears both on display namespace
changes; streaming results bypass completed-result reuse.

## UI Integration

Chat entry readiness, the cold-mount newest-three skeleton, later last-good-body
presentation, history loading, anchor preservation, and DOM activation belong
to [Svelte Chat UI](../../src/docs/svelte-chat-ui.md#intermediate-display-and-cold-hydration).
This guide owns only the shared transform and the server/browser handoff.

## Diagnostic Events

A failed display-source batch or handled scope incompatibility emits one
request-correlated v2-only `display` event. Its finite fields distinguish
revision, namespace, scoped-load, strict-decode, scope-resolution,
shared-dependency, target-preparation, and postcondition failures. A handled
HTTP-200 browser fallback uses `handled-fallback` and does not also emit a
generic runtime error. Strict decoder failures add only a finite owner,
validation rule, rejected value kind, and a 16-hex schema-field reference; they
never include field names, JSON paths, indexes, values, or domain IDs.

Each accepted batch also emits one server-only v2 `display-performance` event
under its request UID when diagnostics collection is enabled. This is
independent of `RISU_PROTOCOL_METRICS`. It records requested, visited, executed,
and result counts; transcript message count when known; cache outcomes and
streaming bypasses; and reached timing stages. Failed, stale, handled-fallback,
and aborted work retains measurements reached so far. Cache hits omit skipped
conversion stages; a failed miss still counts an attempted conversion. No text,
IDs, page-session IDs, hashes, or raw metrics enter the summary.

## Measurement Boundaries

`durationMs` begins at service enqueue and includes `queueWaitMs`, SSE result
callback/encoding, and conversion work. It excludes route auth/body validation
and final JSON serialization. `queueDepth` counts earlier unfinished batches at
enqueue. First-transform/result/priority-result timings also start at enqueue
and precede browser rendering. Browser HTTP duration ends when `fetch` receives
headers and can therefore exclude later SSE, Markdown, and DOM work.

The closed `timings` object reports reached stage totals for revision and
namespace checks, scoped persistence load, decode/resolution, module loading,
shared dependency hashing, source/target hashing, setup, Lua, triggers,
regex/CBS, cleanup, and postconditions. They are nested elapsed measurements,
not additive partitions of service duration. Here `scopeLoadMs` excludes decode;
the older raw `display_source_batch` metric includes both.

Optional `preparation` fields have these boundaries; older records without the
object remain valid:

| Field | Boundary |
| --- | --- |
| `loadPath` | `selected` row loading or `legacy` compatibility fallback. |
| `loads.<owner>.readMs` | SQLite bind/execute/materialization for settings, target, messages, memory, prompt presets, personas, or modules; excludes JSON parsing. |
| `loads.<owner>.parseMs` | Existing `JSON.parse` attempts, including failures; excludes later repair/selection. |
| `loads.<owner>.jsonValues` / `jsonSize` | Attempted JSON strings and cumulative UTF-8 size bucket; these are not row counts. |
| `configurationMs` | Prompt/persona/module selection and scoped configuration, including nested owner measurements. |
| `legacyLoadMs` | Complete broad compatibility load; its internals are not attributed to selected owners. |
| `dependencyBuildMs` | Selected shared dependency construction, including transcript projection. |
| `dependencyNormalizeMs` / `dependencySerializeMs` / `dependencyHashMs` | Canonical-order copy, one serialization, and SHA-256 of the serialized graph. |
| `dependencyJsonSize` | UTF-8 size bucket of that serialization; v3 uses module digests in place of module bodies. |
| `moduleBodyCacheHitCount` / `moduleBodyCacheMissCount` / `moduleBodyCacheBypassCount` | Reused, loaded, or oversized selected module rows; bypasses are a subset of misses. |
| `moduleDigestCacheHitCount` / `moduleDigestCacheMissCount` | Reused or computed immutable module fingerprints. |
| `moduleFreezeMs` | Admission/freezing on body misses, including cache accounting/eviction. |
| `moduleNormalizeMs` / `moduleSerializeMs` / `moduleHashMs` | Digest-miss module canonicalization, serialization, and hashing nested in shared-dependency work. |
| `measurementMs` | Extra size/count accounting; excludes general timer/callback overhead. |

Size buckets have upper bounds of 4 KiB, 64 KiB, 1 MiB, 4 MiB, 16 MiB, and
64 MiB, plus `none` and `over-64MiB`. Counts cover loaded module, asset, regex,
trigger, and character definitions rather than executed scripts. Content,
owner IDs, paths, and hashes are excluded. Without diagnostic context, extra
timers, size scans, and input-count loops are bypassed.

Warm module-body hits retain indexed read timing but omit JSON parsing, counts,
and size measurement. Warm digest hits omit module normalization,
serialization, and hashing. Compare cold and warm requests separately. For a
production sample, collect one initial chat load, repeated same-chat loads, and
a history expansion. Use each request UID to retrieve the corresponding
`display-performance` record, and use cache counters to classify samples before
attributing time to a stage. See [Diagnostics](diagnostics.md#remote-queries-and-investigation)
for the bounded query helper.

## Owners And Focused Tests

Server owners include `server/fastify/src/routes/displaySources.ts`,
`server/fastify/src/displaySourceQueue.ts`,
`server/fastify/src/displayModuleCache.ts`, and the display preparation modules
under `server/fastify/src/prompt/`. Browser owners include
`src/ts/server/displaySources.ts`, `src/ts/process/regexDisplayActivation.ts`,
`src/ts/process/regexDisplayReload.ts`, `src/ts/parser/parser.svelte.ts`, and the
`ChatBody`/`Chats` components named in the UI guide.

Focused coverage includes `packages/protocol/src/displaySource.test.ts`,
`src/ts/server/displaySources.test.ts`,
`server/fastify/__tests__/displaySourceQueue.test.ts`,
`server/fastify/__tests__/displaySourceCache.test.ts`,
`server/fastify/__tests__/displaySourceDiagnostics.test.ts`,
`server/fastify/__tests__/displaySources.test.ts`, and
`server/fastify/browser-smoke/chatDisplayScrollStability.spec.ts`.
