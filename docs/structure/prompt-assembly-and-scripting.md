# Prompt Assembly And Scripting

Last audited: 2026-08-30.
Targeted source check: 2026-09-09 (display-scope validation and persisted trigger compatibility).

This guide owns server prompt construction, CBS and history variables,
lorebook and memory injection, prompt-template precedence, generation
surfaces, final budgeting, post-generation effects, Lua, and V2 triggers. Start
from the [architecture index](README.md) for cross-cutting ownership.

## Related Guides

- [Providers And Models](providers-and-models.md) owns model/profile resolution,
  provider adapters, runtime options, capability routing, and request history.
- [Translation And Input Hooks](translation-and-input-hooks.md) owns translator
  history slots, draft/BTW input hooks, and generated-message translation.
- [Agents And Presets](agents-and-presets.md) owns Agent Preset planning and the
  before-main/after-main auxiliary model phases.
- [Backend Map](backend.md) owns Fastify composition, route registration, and
  worker lifecycle rather than the behaviors described here.

## Generation Surfaces

Normal send, continue, and regenerate start at
`/api/v1/generation-operations`. The operation route accepts the durable intent
and applicable user row atomically, then launches the lower-level
`/api/v1/generate/chat` runner. That runner resolves effective settings and
profiles, assembles the prompt, runs provider policy, streams chat frames,
derives the final message, and persists it. The browser bridge is
`src/ts/process/serverBackedSendChat.ts`; route and provider owners are
`server/fastify/src/routes/generationOperations.ts`, `generationChat.ts`, and
`server/fastify/src/prompt/chatDispatch.ts`.

SQLite operation/attempt state survives process loss and records honest startup
recovery. `server/fastify/src/generationJobs.ts` owns each process-local runner,
emits `job_accepted`, buffers replayable frames, and supports stream attachment
and cancellation while that runner exists. SQLite-backed finalization retries
protect idempotency and reject stale chat/message/script-state targets. Inline
non-durable chat SSE remains for tests and tool-style callers; operation, job,
and effect lifecycles are canonical in
[Backend Generation](backend.md#generation-and-background-work).

Protocol-v1 send assembly carries the accepted user-message id through prompt
construction. An explicit operation retry recognizes that exact transcript row
and reuses its committed submit transforms, so changed `editinput` text cannot
cause the row or input-trigger effects to be applied a second time.

`/api/v1/generate/preview-prompt` performs the same assembly and readiness
checks without provider dispatch. It can return ordinary HTTP errors because
SSE headers are not committed. Chat assembly errors become terminal SSE error
frames. Message mutation/restoration envelopes preserve stored nullable
`name`, `time`, and `translation` metadata; protocol validation accepts those
nulls without coercing them or dropping full-history fields. `/api/v1/generate/completion` is the lower-level shaped-message surface;
its provider contract belongs to
[Providers And Models](providers-and-models.md#chat-dispatch-and-tool-transport).

The browser and server consume the shared, schema-derived chat frame contract in
`packages/protocol/src/generationSse.ts`. The Fastify-only formatter and response
writer remain in `server/fastify/src/prompt/sseEvents.ts`; they do not redefine
the wire types. Additive frame changes update the shared schema once. Negotiated inline streams use
`clientCapabilities.compactPromptEvent` and `promptMetadataOnly` for compact
prompt metadata, `firstChangedIndex` for delta-trimmed message patches, and
`omitDuplicateDoneResult` to omit a repeated `done.result`; durable replay
retains a self-contained result. Normal lower-level completion identifies its
secret-free envelope with `kind: "server-intent"`. Chat rendering and
loading-state ownership is in the
[Svelte Chat UI guide](../../src/docs/svelte-chat-ui.md).

Operation-protocol regenerate clients additionally advertise
`regenerateTargetProjection: 1`. For that path, regenerate truncation and any
later replacement captured against the truncated working transcript remain
prompt-only. The route emits an assembly `message_patch` only from an accepted
assembly persistence result; ordinary working mutations remain available only
to legacy viewers. `info.generationDisplayProjection` fences transient display
text by operation, attempt, target message, generation, and projection epoch.

## Generation Input Ownership

`server/fastify/src/repository.ts` gives preflight selected configuration plus
character/chat readiness metadata; it reads no transcript or Hypa body. Assembly
separately reloads the selected owners and complete target history. Selected
model/prompt/persona/Hypa IDs and module IDs/namespaces use indexed collection
lookups. The route's `createGenerationAssemblyResources()` memoizes only within
that preparation; accepted sends, operation retries, and subsequent preparations
read current authoritative inputs again.

Repository query preparation retains at most 16 fixed SQLite programs per
database in a weakly keyed map; it never caches query results. Selectors exceeding
4,096 bound bytes bypass retention because prepared statements retain their
last parameter values. Every invocation still reads authoritative rows.

The settings document remains one JSON row, including profile credentials and
embedded Agent records. Its parsing cost scales with configuration size. The
selected result excludes unused extracted collections, unrelated character/chat
bodies, and asset metadata. Legacy embedded-character storage has an explicit
`embedded-characters` compatibility path. Required assets resolve on demand.

`server/fastify/src/prompt/serverTypes.ts` owns finite generation, provider,
memory, preflight, and nested record views. `generationInputDecoder.ts` validates
unknown persisted inputs without validator coercion, defaults, field stripping,
or graph cloning. One compatibility adapter preserves established Hypa selection
behavior: a present, non-null, non-string `selectedHypaV3PresetId` becomes `null`
in a shallow root overlay (and a preflight envelope when needed). Nested objects
and the caller's input remain unchanged; valid input retains identity.
Its checked-in schema and standalone validators are generated from those types
by `util/generation-input-schema.ts`; the decoder regression checks schema,
JavaScript and finite declaration synchronization plus runtime-Ajv parity.
Production does not compile the schema during startup.
Imported extension data survives but is absent from ordinary consumer types.
Invalid known fields identify the domain/path without echoing values. Sparse
supported legacy fields and nullable message metadata remain supported. Unfiled
chats retain `folderId: null`; plain prompt cards may omit `type2`, passing an
undefined location through the existing position parser without a new default.
Custom models may omit `params`, preserving the existing behavior of sending no
extra request parameters.
Legacy preset snapshots may explicitly store `null` for `dynamicOutput`,
`thinkingTokens`, `promptSettings`, `reverseProxyOobaArgs`, and `seperateModels`.
The generation contracts preserve those values in settings and selected presets,
including nullable dynamic output and reverse-proxy arguments in durable profiles.
Profile resolution preserves an explicit dynamic-output clear instead of dropping
it and leaving a conflicting flat setting enabled. Other downstream consumers
retain their existing absence/default behavior. Imported
lorebooks likewise retain nullable `loreCache` and migrated `activationPercent`
markers. Non-null values still receive finite member validation. Decoder and
durable-generation regressions cover these values across import, preset
composition, provider dispatch, display, and greeting translation reads.
Character-card asset-prompt toggles retain both legacy strings and booleans;
the importer preserves an enabled boolean rather than dropping it during string
conversion, and generation keeps the established truthiness check.

Resolved configuration is deeply readonly by type. Effective request settings
use a writable scalar overlay and owned global variables; selected nested
configuration stays borrowed and readonly. Mutable character state excludes
sibling chats, while working and authoritative target transcripts are separate
owned snapshots. Provider-policy fallback changes only its settings overlay.
Module lore child activation uses local envelopes instead of editing borrowed
configuration. No runtime freeze is applied to a caller-owned graph.

Supported CBS/Lua history APIs inspect the current working character/chat;
their character-id argument is not a sibling-chat selector. Referenced speaker
names and misses are captured synchronously when assembly starts. Lua full-chat
replacement keeps role/data and cannot introduce a new speaker ID, so subsequent
name resolution needs neither sibling bodies nor a later database query.
Working-character names remain primary. The finite CBS adapter supplies its
required scalar defaults, and Lua JSON/history and edit-trigger results have
named shape checks before they enter typed execution state.

## Effective Configuration And Assembly Order

Browser preflight in `src/ts/process/request/serverPromptAssembly.ts` decides
whether Fastify can faithfully own the request. Server generation then calls
`server/fastify/src/prompt/effectiveGenerationConfig.ts` before
`server/fastify/src/prompt/assemble.ts`.

The effective-config order is selected model preset, prompt-preset generation
fields, prompt-preset model overrides, profile-bound runtime fields, then a
final reapplication of prompt-preset model overrides. Chat-scoped persona,
Persona-linked modules, Agent Preset, jailbreak, sidebar-toggle, and Prompt/Agent module integration
are materialized before assembly. This is an effective request overlay; it does
not rewrite global settings.

`assemblePrompt()` runs these stages in order:

| Stage | Contract |
| --- | --- |
| Scope resolution | Resolve database, character, chat, generation settings, prompt owner, active modules, model profile, and Agent Preset readiness. |
| Submit transforms | Prepare regenerate state, run the input trigger, append the new user row, apply `editinput`, snapshot the submit transcript, and apply run-variable CBS. |
| Agent before-main | Execute the planned before-main Agent dependency graph and apply any single `userInput` modifier. See the Agent guide. |
| Static/plain slots | Build main, character, persona, author-note, jailbreak, and configured plain rows. |
| Lorebook preflight | Activate ordinary lore, distribute positions, expand CBS for token accounting, build depth rows, and preflight the template. |
| History and bias | Format the bounded transcript, per-message scripts/CBS, continuation markers, and logit-bias rows. |
| Memory bridge | Select already-produced Hypa V3 summaries and committed BardWiki references, insert independently removable memory rows, and enqueue only Hypa follow-up work. |
| Render and budget | Render the owned prompt template, execute remaining request-time script hooks, retokenize, trim removable history to reserve the configured response budget, and clamp that budget only when pinned rows consume its headroom. |

The stage order is explicit in `server/fastify/src/prompt/assemble.ts` and is
covered broadly by `server/fastify/__tests__/assemble.test.ts`.

Assembly maintains separate working and authoritative submit transcripts. The
working transcript is what CBS, triggers, Agent Presets, history, and prompt
rendering observe. Regenerate removes its target only there. Route-owned input
trigger, `editinput`, Agent Preset user-input, and history-inject changes update
an identity-addressed authoritative snapshot. This prevents a later durable
submit transform from persisting the regenerate truncation or prompt-only
run-variable rewrites as an incidental full-transcript replacement.

## CBS Variables And History

| Responsibility | Canonical owner |
| --- | --- |
| Shared parser and function registry | `packages/shared-core/src/risuChatParserCore.ts`, `packages/shared-core/src/cbsRegistry.ts`; callback contracts in `packages/shared-core/src/cbsContracts.ts` |
| Browser registration defaults/compatibility export and runtime binding | `src/ts/cbs.ts`, `src/ts/parser/risuChatParser.ts` |
| Fastify runtime binding | `server/fastify/src/prompt/variables.ts`, `server/fastify/src/prompt/promptVariablesBoot.ts`, `server/fastify/src/prompt/cbsAdapter.ts` |

Fastify supplies the active database, character, chat, message index, prompt
slot, variable engine, and available Agent outputs to the shared implementation.
Change shared CBS semantics in shared-core; keep environment-specific callbacks
in the runtime bindings.

Standard history variables have two distinct shapes:

- Unnumbered `{{history}}` serializes complete message objects and includes the
  greeting.
- Numeric `{{history::N}}` and `{{messages::N}}` return raw text from the newest
  positive-safe-integer count of stored rows, restored to chronological order.
  `::role` adds role prefixes.

These are not translator `{{slot::history::N}}` variables. The latter filter
disabled/comment rows, use a 1-50 bound, and share a separate token budget; see
[Translation And Input Hooks](translation-and-input-hooks.md#translation-history-slots).

Per-message expansion preserves the row being processed. History formatting
passes its stored row index to `expandVariables()`; `editinput` uses the newly
appended user index; `editoutput` uses the target assistant index. Regex pattern
and replacement CBS receive the same `chatID`, so `{{chat_index}}` is current
while `{{lastmessageid}}` still means the transcript tail. Regression coverage
is the exact cases "runs editinput CBS with the appended user row as the current
message" in `server/fastify/__tests__/assemble.test.ts`, "expands per-message
data with its current chat index" in
`server/fastify/__tests__/history.test.ts`, and "expands replacement CBS with
the supplied current-message index" in
`server/fastify/__tests__/scripts.test.ts`.

The canonical CBS fixes apply server-side too: `{{reverse::...}}` treats a
missing value as empty before Unicode-aware reversal, and `setdefaultvar`
considers absent, empty, or the compatibility string `"null"` unset. Run-var
mutations are removed from rendered text and emitted as targeted chat-variable
mutations.

For a malformed legacy chat without a numeric first-message index,
`{{firstmsgindex}}` follows the parser's callback-error contract and remains
literal instead of fabricating `-1`.

Fresh generation and prompt-preview requests report a bounded browser-context
snapshot. Fastify resolves `{{screenwidth}}`, `{{screenheight}}`, and
`{{metadata::browserlanguage}}` from that request-local snapshot rather than
reading browser globals. Each dimension uses the browser's `window.innerWidth`
or `window.innerHeight` value captured when the operation is accepted. Missing
context from older clients or intents is non-fatal and emits a structured
warning.

## Intermediate Display Processing

Fastify owns the expensive intermediate `editdisplay` transform for supported
mounted chat rows through
`POST /api/v1/chats/:chatId/display-sources`. The browser supplies the exact
string after its first additional-asset pass; the server applies Lua
`editDisplay`, the declarative V2 display trigger, non-mutating CBS expansion,
and bounded global/active-preset/character/module regex scripts. The browser
then resumes with the optional second asset pass, inlays, thought/tool markup,
Markdown, style handling, sanitization, and DOM behavior. Neither the wire
`displaySource` nor the process-local cache is persisted as message content.

The route is a read-only POST. Every target starts from an isolated copy of the
authoritative chat scriptstate. Lua chat-variable writes remain visible within
that target's own Lua/trigger/regex pipeline, then the server discards the delta
before processing another target. Display-time writes therefore never reach
SQLite, affect a sibling target, or make rendering order, retries, viewport
mounting, and cache reuse mutate chat state. V2 display variables follow the
same ephemeral principle. Browser `editdisplay` plugins, dynamic fuzzy-asset
matching, an old server, stale identity/context, and transport failures select
the complete browser transform instead of reordering stages.

The display route hydrates and validates only the selected character, selected
chat and transcript, selected prompt/persona dependencies, module activation
identities, and the activation-winning module bodies required by the transform.
Inactive modules, unrelated prompt/persona rows, and later duplicate module
bodies stay outside the display decoder. Unrelated character/chat payloads and
asset metadata are not scanned. `server/fastify/src/displayModuleCache.ts` reuses
selected parsed module bodies per SQLite handle and module-content token. A
position-only indexed lookup avoids materializing cached JSON. The LRU retains
at most 256 bodies and 64 MiB of charged size (JSON UTF-16/property allowance plus
object/array overhead, not a measured heap limit). Oversized bodies bypass reuse.
Module definitions are deeply frozen; generation loads and mutable execution
state remain private. Module writes retire the whole module-body cache, while
chat-only changes retain it. Legacy embedded bodies use the uncached path.

Each immutable active module also carries a weakly held digest of its display
dependency fields. The `editdisplay-v3-module-digests` fingerprint combines those
ordered digests with current character/chat/settings dependencies; it never
re-serializes an unchanged asset catalog on a warm hit. A compatible batch
canonicalizes and hashes the
shared transcript and scripting dependencies once, then combines that digest
with each target's small identity and source digest. Opt-in
`display_source_batch` metrics expose queue wait, scoped-load,
shared-dependency, per-target fingerprint, transcript-size, and per-batch cache
outcome fields so regressions can be separated from actual script execution
time.

When remote/browser diagnostic collection is enabled, a content-free
`display-performance` v2 event additionally exports per-batch queue, preparation,
conversion and cache measurements under the request UID without raw metrics.
Persistence loading and strict decoding have separate timings. Cache hits omit
unexecuted conversion stages, and failed/stale/aborted batches retain reached
stages. Optional preparation detail separates selected-owner SQLite reads from
JSON parsing and shared dependency construction, canonical normalization,
serialization, and hashing. Bucketed JSON sizes and loaded-definition counts
identify large inputs without exporting content. Measurement does not change
the canonical fingerprint or repeat serialization. See [remote diagnostics](development-and-observability.md) for measurement
boundaries and the helper query.

A generation-input shape that the narrow display decoder cannot support is a
handled compatibility boundary: the route returns HTTP 200 with one
`client_fallback` / `scope_input_incompatible` entry per target, so the browser
runs its complete legacy transform. Malformed stored JSON, storage faults,
invariant failures, and unexpected exceptions remain server errors. The
fallback is read-only and does not normalize or rewrite the rejected record.

The display POST accepts optional `priorityKeys` identifying targets in foreground
order and negotiates a finite SSE response with `Accept: text/event-stream`.
The browser chooses at most three distinct message rows at the final coalesced
HTTP boundary, including all their display layers. Viewport ranks are refreshed
on layout/scroll and consulted after waiting for the command lane and auth, so
paging waves cannot each add another three rows to the same priority group.
JSON remains the default for older clients. Both groups share one scoped load and
dependency fingerprint. SSE emits `result` per target and a terminal `done`,
`invalidated`, or `error`; it uses bounded writes and aborts on disconnect or
buffer overflow. Validation/auth failures before the first frame remain HTTP
errors. No event contains final HTML: browser Markdown/sanitization still follows.

`displaySourceQueue.ts` retains exclusive execution through each complete target
and its state cleanup, then yields for I/O and newly queued foreground work.
The batch generator retains its prepared scope and budgets across these turns;
request async context is bound to each queued operation. Revision/lineage/writer/module-token
postconditions run before and after targets, and once at completion. A late
change emits terminal invalidation, including for already delivered results.
The browser reparses affected projections after invalidation and keeps fetch
cancellation active through body consumption. Writer reads retain the shared
command revision lane until stream completion; reader requests remain independent.

### Display Activation And Persistence

`src/ts/process/regexDisplayActivation.ts` owns the three-second regex display
activation debounce; `src/ts/process/regexDisplayReload.ts` selects scoped
reload dependencies. Character,
module, prompt-preset/root, and global edits keep independent timers, and a
component unmount does not shorten the three-second delay. Consumers derive a
reload token from only the regex owners active for their character/chat, so an
unrelated owner does not reparse mounted rows. The browser also deduplicates
identical non-streaming targets by namespace, server revision, browser context,
target/source identity, priority, and the scoped activation token; completed
results use a bounded LRU and namespace changes clear both in-flight and
completed deduplication state.

Character-sidebar script and trigger edits have an earlier 300 ms trailing
draft debounce in `src/ts/server/scriptDefinitionOwner.svelte.ts`, before cloning, diffing,
outbox staging, or network dispatch. Display activation flushes that draft and
waits for final durable settlement before advancing its owner token; a failed
save leaves the old display active. Send/continue/regenerate also flush the
draft, but waits only for the immediate dispatch outcome so offline/queued or
failed persistence blocks generation instead of hanging or assembling against
unsaved definitions. Module, prompt-preset, and global display activation keep
their existing owner-specific persistence paths.

The cache retains up to four recently active namespaces keyed exactly by
database lineage, writer epoch, ephemeral page session, language, both viewport
dimensions, and protocol version. Returning to one of those exact contexts can
reuse its entries, while different contexts never cross-hit. Entry count and
UTF-8 byte limits apply across all retained namespaces; namespace and entry
eviction are LRU-bounded, and completion from an evicted in-flight namespace
cannot repopulate it. Entries use SHA-256 over canonical display dependencies
rather than a global revision. Growing generation prefixes are coalesced and
explicitly bypass reusable storage. The transform version is part of each
dependency key, so the per-target ephemeral-state contract cannot reuse entries
from the former durable-display-state behavior.

## Lorebook Activation And Injection

Normal activation excludes entries marked `agentOnly` or
`extensions.risu_agent_only`; those are reserved for named Agent inputs.
`server/fastify/src/prompt/lorebook.ts` activates regular character, chat,
global, and module lore, while `server/fastify/src/prompt/assemble.ts`
distributes the result into prompt slots.

One position parser owns `{{position::...}}` and non-lore `@@inject_at`
append/prepend/replace behavior during both token preflight and final rendering.
Global Note replacement composes `{{original}}` before its location injection,
and stable-card cache reads reuse that result. Depth and reverse-depth rows are
derived from the same activation report.

CBS is evaluated before lorebook token counting unless the prompt is already a
parser fixed point. This keeps activation budgets aligned with the text sent to
the model, including `reverse`, variables, and repaired `setdefaultvar` null
semantics. The contract is implemented by `countLorebookTokens()` in
`server/fastify/src/prompt/lorebook.ts` and the lorebook-preflight stage in
`server/fastify/src/prompt/assemble.ts`.
`server/fastify/__tests__/lorebook.test.ts`, the "Fastify lorebook template
injection" cases in `server/fastify/__tests__/assemble.test.ts`, and stable-card
cases in `server/fastify/__tests__/templates.test.ts` pin the ordering.

`Character.additionalText` remains import/export compatibility data. Fastify
does not implement the old browser embedding-based additional-information
retrieval and does not include this field in the static description.

The advanced Tokens menu uses the authenticated, read-only
`GET /api/v1/chats/:chatId/lore-token-counts` diagnostics route. It resolves the
selected generation inputs, then `countActiveLoreTokens()` evaluates a copied
chat without a persistent variable writer. Diagnostic source categories are
optional on activation results so normal generation reports retain their shape.
Character, module, and chat totals share one budget and recursive evaluation;
lore-to-lore injected text belongs to the receiving entry. The warning for
probability decorators inspects applicable entries before random selection.

## Prompt Template Ownership And Roles

A chat-scoped `generationSettings.promptPresetId` wins; otherwise the selected
modern prompt preset owns generation. The top-level `promptTemplate` is only a
compatibility fallback when no modern owner resolves. A resolved modern prompt
preset with no template intentionally disables template rendering instead of
borrowing stale top-level data. Loadout and duplication code must preserve this
owner boundary; see `src/ts/promptPresetModelOverrides.svelte.ts`,
`server/fastify/src/commands/splitPresets.ts`, and
`src/lib/Setting/pickerGenerationSettings.test.ts`.

Persona, description, author-note, and memory template blocks can select their
wire role through `role2`.
`packages/shared-core/src/promptTemplateNormalization.ts` normalizes
`assistant`/`char` to `bot`, accepts `user`, `bot`, or `system`, and defaults
invalid or absent roles to `system`; `src/ts/process/promptTemplateNormalization.ts`
retains the browser `PromptItem` return type. The browser editor lives in
`src/lib/UI/PromptDataItem.svelte`; server rendering parity is in
`server/fastify/src/prompt/templates.ts`.

Providers without full system-role support pass through the role replacement
step in `server/fastify/src/prompt/chatDispatch.ts`. An empty or invalid
`systemRoleReplacement` falls back to `user`; it never produces an empty wire
role.

## Hypa V3 And BardWiki Memory Phase

For Hypa V3, during assembly,
`server/fastify/src/prompt/memory.ts` and
`server/fastify/src/prompt/memoryAdapter.ts` snapshot existing summaries, plan
chunks, select model-compatible rows, and inject nonempty summaries as system
prompt rows. This hot path does not call embedding or summary providers.
`server/fastify/src/prompt/memoryFollowups.ts` enqueues idempotent
summarize/embed jobs for the worker after planning.

Provider-backed work runs through `server/fastify/src/memoryWorker.ts` and its
embed/summarize handlers. Legacy backfill remains in
`server/fastify/src/memoryLegacyImport.ts`; `legacy-hypav3` summaries are
compatible with every selected summary model and outrank an automatic duplicate
for the same chunk. Deletion tombstones prevent startup import from restoring a
removed legacy row.

Memory summaries use the memory-role profile and profile-owned provider
options after applying the originating chat's current model preset and any
prompt-preset model-role overrides. Existing queued jobs remain compatible
because the worker resolves those durable chat bindings by `chatId` at
execution time. Embeddings remain outside chat profiles on the separate
Hypa/Voyage/custom model contract in
`server/fastify/src/memoryEmbeddingModel.ts`. Detailed memory storage/routes
remain backend/data ownership; this section owns only prompt-facing behavior.

BardWiki uses the same memory bridge but a separate, deterministic selector.
It builds a bounded lexical query from the current input and recent active
transcript, selects committed active Markdown documents, expands resolved
wikilinks within configured limits, and emits whole bounded
`<bardwiki-reference>` system rows. Retrieval performs no provider work, does
not wait for background jobs, and fails explicitly when pinned references do
not fit. `hypa`, `bardwiki`, and `hybrid` modes define which selectors run and
how their independent caps share the total memory budget. Preview, prompt SSE,
request-history diagnostics, and provider dispatch use the same selected rows.
See [BardWiki Memory](bardwiki.md) for settings, jobs, document lifecycle, and
the complete selection contract.

## Final Budget And Confirmation Gate

`server/fastify/src/prompt/tokens.ts` uses tiktoken's ordinary encoder for
cl100k/o200k text without `<|`, the prefix shared by every special token in the
installed encoder manifests. Text containing that prefix retains the standard
encoder and its special-token rejection behavior. Exact token IDs/counts,
special-token errors and the manifest-prefix invariant have focused coverage;
no token-result cache or budget check is skipped.

`server/fastify/src/prompt/budgetFinalize.ts` independently retokenizes the
fully rendered `OpenAIChat[]`; it does not trust template preflight totals.
When the prompt exceeds the input target (`maxContext - maxResponse`), it removes
rows marked `removable` from the front to preserve the configured response
budget. It preserves multimodal-only rows, fails if pinned rows alone overflow
the full context, and clamps response tokens only when pinned rows prevent the
full reservation. It also reports when a durable history message was dropped.

For persisted send/continue/regenerate outside enabled character Hypa V3,
history trimming requires a one-time chat-scoped confirmation. The server emits
`hypa_context_truncation_confirmation_required` only when trimming actually
occurred and `chat.hypaContextTruncationAcknowledged` is not true. The browser
confirmation flow in `src/ts/process/serverBackedSendChat.ts` persists that
field through a targeted chat command, verifies current chat ownership, and
retries once. The protocol constant lives in
`packages/protocol/src/hypaContextTruncation.ts`; the browser path is a
compatibility re-export.

## Assembly Gates

Fastify rejects request shapes it cannot represent without silent loss:

| Gate | Reason |
| --- | --- |
| Send tail is not a text user row | Server send assembly owns a newly appended text user message. |
| Unsupported non-text tail | Browser-only content is not silently discarded. |
| Group chat | Removed/no-port behavior. |
| Plugin, WebLLM, or unroutable provider | No supported Fastify provider adapter. |
| Non-vision caption fallback | The browser image-caption path has no server equivalent. |
| Interactive Lua | Fastify cannot drive mid-request browser dialogs. |
| Deprecated Plugin V3 edit/replacer hooks | Browser plugin execution is no-port. |

Supported images, audio, video, assets, and inlays use server asset ids where
possible and only when selected model metadata permits the input. Assembly
loads bytes from the server asset store for adapters that require inline media.

## Post-Generation Order And Effects

For each primary or alternate provider result, finalization runs in this order:

1. Reformat the completion and apply `editoutput` once to the complete text.
2. Optionally trim an incomplete trailing sentence.
3. Execute Agent Preset after-main uses and its final-output composition.
4. Append or update the assistant row, then evaluate run-variable CBS.
5. Run the output trigger and capture message, variable, character, and local
   lorebook mutations.
6. Persist the authoritative result; only then start eligible automatic
   translation.

This order lives in `runServerPostGeneration()` in
`server/fastify/src/prompt/assemble.ts`. Blank-response fallback, banned-script
retry, character Escape Output, ordered provider/profile retry, and buffered
multi-generation derivation happen before a frame is authoritative. Automatic
translation is owned by the
[translation guide](translation-and-input-hooks.md#generated-message-auto-translation).
The SQLite generation-effect ledger does not change this logical order. It
records which server/client completion effects may run, be receipted, or be
recovered after persistence; that delivery contract is canonical in
[Backend Generation And Background Work](backend.md#generation-and-background-work).

Interrupted streams take a narrower branch. Cancellation and post-token failure
apply steps 1–2 once to the accumulated partial and persist that exact text, but
do not run Agent Preset after-main, run-variable, output-trigger, translation,
or other completion-only effects. Incremental display remains raw on
server-backed streams.

`dispatchProviderWithPolicies()` in
`server/fastify/src/routes/generationChat.ts` runs the request trigger for every
actual attempt. Failures before the first token can use same-profile retries and
then ordered profile/legacy fallbacks; retry count is clamped to 20. Persisted
`generationInfo.model` retains the legacy provider-prefixed display label, while
`generationInfo.outputTokens` remains the assembler's context-headroom-clamped
budget even when a fallback profile has a different `maxResponse`. The cases
"applies request triggers, retries, blank fallback, banned-script retry, and
Escape Output" and "clamps request retries to the UI maximum of 20 (OR-5)" in
`server/fastify/__tests__/generation.chat.test.ts` pin the policy.

Generation metadata keeps stage 2 for Fastify prompt/memory work. Browser stage
4 remains UI finalization; server persistence deliberately records zero there
rather than issuing a telemetry-only message mutation.

## Lua Runtime

`server/fastify/src/prompt/luaRuntime.ts` runs non-interactive Lua in isolated,
prewarmed, one-use VMs. Each run and the aggregate generation have wall-clock
budgets; sleep, network requests, returned sizes, and instruction work are
bounded. `server/fastify/src/prompt/boundedRegex.ts` screens regex complexity
and owns the optional worker-thread compatibility path. V2 trigger execution
uses `DEFAULT_TRIGGER_WALL_CLOCK_BUDGET_MS` from
`server/fastify/src/prompt/triggers.ts` alongside effect, loop, and recursion
budgets.

Regex replacement templates and generated results default to a 16 MiB limit.
The durable `regexOutputSizeLimitMiB` Advanced Setting can select 1-64 MiB;
Fastify direct/worker execution and the browser fallback use the same value.
Pattern and source-text caps remain fixed independently of this compatibility
setting. Oversized results are rejected rather than truncated.

Low-level `LLM`/`simpleLLM` calls use `scriptMain` and `axLLM` uses
`scriptAux`. A character- or module-owned `scriptModelOverrides` profile id
wins for that owner's call. Server trigger-source attribution and the browser's
non-enumerable module-trigger owner metadata preserve the owner per run; a
module without an override therefore falls back to the global script role, not
the active character's local override.

Lua participates in submit/input, editinput, request, editoutput, and output
phases through `server/fastify/src/prompt/assemble.ts`,
`server/fastify/src/prompt/triggers.ts`, and the route retry policy. Browser
display/reload calls are safe no-ops. Interactive alert input/select/confirm
calls fail explicitly. Privileged multimodal LLM/image APIs remain unsupported.

Lightweight chat access is deliberately bounded: `getChatMain` returns only
role/data/time JSON for one index, while `getChatData` and `getChatRole` return
one field. Missing indexes return null/empty results. `getRecentChatsMain`
returns the requested bounded tail rather than exposing a mutable database.
Unchanged `setChatVarChanged`/`setStateChanged` writes return nil and do not mark
assembly dirty, so no-op scripts do not force persistence.

## Durable Lua Setters

Lua character and lorebook setters are no longer compatibility no-ops.
`setName`, `setCharacterFirstMessage`, and `setBackgroundEmbedding` mutate the
working character; `upsertLocalLoreBook` replaces or appends a chat-local entry
by display comment and makes it visible within the same Lua run.

`server/fastify/src/prompt/assemble.ts` diffs the working character and local
lore against their initial snapshots. The result carries targeted
`characterFieldMutations` and `localLoreMutation`; both assembly-time and
post-generation persistence in
`server/fastify/src/routes/generationChat.ts` validate freshness before writing
them. No diff means no state write. Coverage lives in
`server/fastify/__tests__/luaRuntime.test.ts` and
`server/fastify/__tests__/assemble.test.ts`.

## V2 Triggers And Unsupported Effects

`server/fastify/src/prompt/triggers.ts` supports deterministic control flow,
variables/local variables, comparisons, loops, safe data helpers, message
reads/writes, additional system prompts, and server Lua effects under effect,
loop, recursion, and wall-clock budgets.

Persisted server inputs accept either a canonical scalar trigger mode or an
exact one-element tuple containing one of the six valid modes. The tuple is a
finite compatibility shape for legacy/foreign rows, not a new authoring format:
ordinary automatic selection remains scalar-only and never coerces the tuple.
The historical first-effect `triggercode`/`triggerlua` and manual-name bypasses
remain unchanged, while string-only trigger attribution omits tuple values.
Browser editors, imports, and command writes continue to require scalars, and a
read/display operation never rewrites a tuple row.

Retained legacy guards can end the whole trigger before later effects. This
applies to malformed literal-container variable names and display/request-state
effects used outside display mode. Earlier durable variable writes remain
eligible for persistence, while transient chat/output changes from the aborted
run are discarded.

Unsupported V2 effects are preserved for round-trip compatibility and skipped,
not partially executed. `packages/shared-core/src/triggerCompatibility.ts`,
exported as `@risuai/shared-core/trigger-compatibility`, owns the neutral catalog
and diagnostic traversal. `src/ts/process/triggerServerSupport.ts` and
`server/fastify/src/prompt/triggerCompatibility.ts` only forward its exports.
Execution, privileged actions, and per-run warning collection remain in
`server/fastify/src/prompt/triggers.ts` and `server/fastify/src/prompt/scripts.ts`.
Categories include commands, alerts, privileged LLM/image/similarity work,
legacy browser JavaScript, GUI/update/wait operations, and the V2
character/persona/note/lorebook state arms. Generation emits one warning per
distinct unsupported effect type, even when recursion or a loop encounters it
multiple times. The trigger editors mark configured unsupported definitions,
dedicated V2 JSON import reports them without changing the imported rows, and
the browser presents runtime compatibility warnings visibly as well as retaining
them in the generation result.

The shared diagnostic traversal inspects nested objects and arrays, tolerates
cycles, and returns sorted, deduplicated effect names without changing imported
definitions. The unsupported CBS callback set remains empty. The same catalog
includes regex-script `@@emo` output, classified only when the string starts
with `@@emo` followed by a literal space. Matching scripts preserve their rows
and leave text unchanged, add one `@@emo` warning per generation, and show an
annotation beside the regex output editor. Shared behavior and facade identity
are covered by `packages/shared-core/src/triggerCompatibility.test.ts`;
`packages/shared-core/src/ownership.test.ts` verifies the package export and
forwarding boundaries, and
`server/fastify/__tests__/triggerCompatibilityOwnership.test.ts` verifies the
Fastify consumer imports and diagnostic parity.

This boundary is specific to V2 trigger effects. It does not make the durable
Lua setters above unsupported. Keep the two compatibility surfaces distinct in
tests and documentation. Safety regressions are covered by
`server/fastify/__tests__/triggers.test.ts`,
`server/fastify/__tests__/luaRuntime.test.ts`, and
`server/fastify/__tests__/boundedRegex.test.ts`.
