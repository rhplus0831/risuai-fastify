# Providers And Models

Last audited: 2026-08-27.
Targeted source check: 2026-09-12 (`localStopStrings` precedence, validation, and narrow repair).

This guide owns browser model metadata, durable model profiles and credentials,
server-owned provider operations, provider dispatch, runtime options, capability
routing, and LLM request history. Start from the
[architecture index](README.md) when a change crosses domain boundaries.

## Related Guides

- [Prompt Assembly And Scripting](prompt-assembly-and-scripting.md) owns prompt
  construction, generation surfaces, budgeting, memory injection, Lua, and V2
  triggers.
- [Translation And Input Hooks](translation-and-input-hooks.md) owns translator
  pipelines, caches, detached translation jobs, and draft/BTW hooks.
- [Agents And Presets](agents-and-presets.md) owns reusable Agents, Agent Preset
  planning, model resolution, lorebook inputs, and output composition.
- [Plugins And MCP](plugins-and-mcp.md) owns MCP discovery, execution, and OAuth
  behavior. This guide covers only the provider transport boundary used by tool
  requests.

## Model Registry And Shared Contracts

| Path | Role |
| --- | --- |
| `packages/shared-core/src/modelTypes.ts` | `LLMProvider`, `LLMFormat`, tokenizers, flags, parameter capability tiers, and `LLMModel`. |
| `src/ts/model/modellist.ts` | Static, generated, dynamic, custom, and Plugin V3 registry merging plus `getModelInfo()`. |
| `packages/shared-core/src/openaiModels.ts`, `anthropicModels.ts`, `googleModels.ts` | Shared static provider-model rows; matching files under `src/ts/model/providers/` are compatibility re-exports. |
| `packages/shared-core/src/modelRoles.ts` | The exact roles `chatMain`, `chatAux`, `memory`, `emotion`, `translate`, `otherAx`, `scriptMain`, and `scriptAux`; legacy fallback references are a separate map. |
| `packages/shared-core/src/modelProfileRecords.ts` | Durable profile, runtime-option, role-binding, fallback, and order schemas. |
| `packages/shared-core/src/modelProfileResolver.ts` | Compatibility resolution, provider capability, credential resolution, and readiness status. |
| `packages/shared-core/src/providerCredentialRecords.ts` | Reusable API-key and Vertex service-account records. |
| `src/ts/model/tokenizerOptions.ts` | Portable tokenizer choices shared by settings, profiles, Custom API, and playground code. |
| `src/ts/model/modelGrid.ts` | Model-grid normalization and filtering helpers. |
| `src/ts/model/keyedRequestCache.ts` | Complete-context in-flight dedupe and bounded successful-result reuse. |
| `src/ts/model/openrouter.ts`, `src/ts/model/nanogpt.ts`, `src/ts/model/llmgateway.ts`, `src/ts/model/neuralwatt.ts`, `src/ts/model/ollama.ts`, `src/ts/model/ooba.ts`, `src/ts/horde/getModels.ts` | Browser provider catalog/account helpers. |

The static registry is capability metadata, not only a picker list. Dispatch
materializes a sampler or reasoning control only when the selected row declares
the corresponding parameter. Shared-core owns the OpenAI, Anthropic, and Google
catalog rows; `src/ts/model/modellist.ts` owns the remaining static rows and
registry merge, while `packages/shared-core/src/modelTypes.ts` owns the reusable
capability tiers. Update the owning row and its focused model-registry/request
tests together when capabilities change.

`src/ts/model/modellist.ts` also synthesizes Responses variants for compatible
OpenAI rows and Vertex variants for Google rows. Dynamic Google and Anthropic
catalogs are credential-dependent and therefore are not a stable model
inventory. Prefixes
such as `xcustom:::`, `horde:::`, `hf:::`, and `pluginmodel:::` synthesize
metadata for compatibility paths. The server does not import this whole UI
registry; it reconstructs the narrow dispatch context from stored settings,
the resolved profile, prefixes, and managed-provider allowlists.

Static and legacy fallback ids still resolve from flat settings through the
`staticModel` path; that selection bypasses role resolution and carries no
recursive fallback refs. A persisted `xcustom:::` model is server-routable only
when its stored URL, key, and format satisfy
`packages/shared-core/src/providerCapability.ts`; dynamic registry presence alone
does not make it routable.

## Model Profiles And Role Resolution

`Database.modelProfiles` stores reusable profiles,
`Database.modelProfileOrder` stores the mixed profile/divider presentation
order, and `Database.modelRoleProfiles` binds runtime roles. Dividers are UX
only: normalization removes invalid or duplicate entries, appends missing
profiles, and never feeds a divider to resolution. Strict command validation
requires every profile exactly once in the order.

A durable profile owns a provider id, selected model id, request model,
provider options, a credential reference, runtime overrides, and ordered
fallback references. Bindings use `profile`, `legacy`, or supported `inherit`
mode. The resolver prefers a valid durable binding and falls back to legacy
flat fields for copied data, old presets, static-model bypasses, and remaining
compatibility surfaces. Resolution reports `ready`, `incomplete`,
`compatibility`, or `unsupported`; incomplete or unsupported active profiles
are blocked before browser dispatch, server-intent completion, chat job
acceptance, and final provider dispatch.

Character and module `scriptModelOverrides` may locally bind Lua `LLM` and
`axLLM` calls to durable profile ids. Owner-local bindings take precedence over
the `scriptMain` or `scriptAux` role only for calls owned by that character or
module. Missing references remain visible for repair and fail that script call;
they never silently fall back to a different profile. These bindings are local
installation state and are omitted from individual character-card and `.risum`
exports, while whole-database saves retain them.

Normalization/defaults run in `src/ts/storage/database.svelte.ts` and
`server/fastify/src/databaseDefaults.ts`. Canonical row-oriented wrappers and
handlers in `src/ts/server/commands.ts`,
`server/fastify/src/routes/commands.ts`, and
`server/fastify/src/commands/modelProfiles.ts` own profile and credential CRUD,
ordering, role binding, create-and-bind, runtime-default, and legacy-conversion
mutations. Whole-array settings patches remain compatibility paths for imports,
presets, loadouts, and older callers. Preservation runs through
`src/ts/model/modelPresetSnapshots.ts`,
`src/ts/promptPresetModelOverrides.svelte.ts`,
`packages/shared-core/src/presetSplit.ts`, and
`server/fastify/src/commands/splitPresets.ts` plus `src/ts/loadout.ts`.
Applying model or prompt presets operates on a masked browser projection, so
`applyModelPresetFieldsToDatabase()` and `applyPromptPresetFieldsToDatabase()`
must use `normalizeProjectedProviderCredentials()` rather than persisted-secret
normalization. This preserves credential row identity and masked values instead
of treating the projection as a raw credential replacement.
Model-profile UI ownership is in the
[Svelte Settings UI guide](../../src/docs/svelte-settings-ui.md).

First-class authored providers are `openai`, `llmgateway`, `neuralwatt`,
`anthropic`, `google`, `vertex`, `ollama`, `custom-api`, and `debug-echo`.
Compatibility records can still normalize other legacy shapes without gaining
a first-class editor. Custom API profiles represent OpenAI-compatible Chat
Completions and store a base URL; dispatch appends the chat-completions suffix.
LLM Gateway uses public `https://api.llmgateway.io/v1/models` discovery and the
fixed `https://api.llmgateway.io/v1/chat/completions` endpoint. Its optional
request enums are `reasoning_effort`
(`none` through `max`), `verbosity` (`low`, `medium`, or `high`),
`service_tier` (`auto`, `default`, `flex`, or `priority`), and `routing`
(`auto`, `price`, `throughput`, or `latency`). Neuralwatt likewise has public
fixed catalog discovery and fixed
`https://api.neuralwatt.com/v1/chat/completions` generation; catalog rows retain
display/provider, context-limit, and per-million-token price metadata. Both use
reusable credentials for generation and ignore profile-local endpoint
substitution. Contracts are pinned by `src/ts/model/neuralwatt.test.ts`,
`server/fastify/__tests__/providerOperations.test.ts`,
`src/ts/model/modelProfileResolver.test.ts`, and
`server/fastify/__tests__/chatDispatchProfileOptions.test.ts`.

Legacy selector compatibility is narrower than first-class profile support.
DeepSeek and DeepInfra model ids still resolve to fixed OpenAI-compatible
Fastify endpoints. NovelAI, NovelList, Plugin, and local WebLLM selections remain
live browser/local compatibility surfaces but are explicitly rejected by
server chat dispatch; they do not become Fastify-routable merely because the
shared model registry can describe them.

## Provider Credentials

`Database.providerCredentials` stores `apiKey` or `vertexServiceAccount`
records. Profiles refer to them by `providerOptions.credentialId`; inline API
keys and Vertex private-key material are rejected in profile records. Resource
projections mask secrets, resolution dereferences them only on the server, and
`server/fastify/src/commands/providerCredentials.ts` rejects deletion while a
profile still refers to the credential. Legacy-to-profile conversion mints and
deduplicates credential rows.

A one-shot draft credential is allowed only where a typed provider/media
operation explicitly supports `credential.source: "provided"`. Whole-database
exports can still contain raw credentials and must be handled as secrets.

## Runtime Options And Precedence

`Database.modelRuntimeDefaults` and profile `runtimeOptions` use the same
schema. Effective precedence is hard defaults, global runtime defaults, then
the resolved profile override. Legacy flat parameters remain conversion data;
profile-bound generation does not silently borrow them.
`resolveModelRuntimeDefaults()` exposes the canonical built-in/global merge in
stored units for settings displays; profile overrides remain a separate record.

Important runtime contracts include:

- `localStopStrings` has three distinct states: an absent field inherits the
  next runtime layer, explicit `null` disables inherited local stop strings,
  and a string array replaces them. Shared validation rejects other shapes.
  Import/migration repair removes only the known serialized-undefined markers;
  it preserves `null`, valid arrays, and unrelated malformed values for strict
  validation rather than repairing data during generation. The canonical
  normalizer is `packages/shared-core/src/localStopStrings.ts`.

- `stripCoT` incrementally removes recognized `<Thoughts>`/`<think>` blocks
  before downstream consumers and request-history capture. It retains possible
  split tags and pending whitespace while suppressing nested reasoning bodies.
  Buffered requests retain whole-string trimming; streaming preserves any
  leading whitespace already emitted before a later reasoning block.
  Half-streaming counts upstream text before stripping, including reasoning,
  and sends progress-only token events while visible content is unavailable.
  Empty progress events do not cross the visible-answer retry boundary.
  `server/fastify/__tests__/stripCoTFrames.test.ts` pins chunk-split handling and
  interrupted output; `server/fastify/__tests__/llmgatewayStreaming.test.ts`
  verifies incremental delivery, half-streaming counts, and filtered history.
  The Strip CoT cases in
  `server/fastify/__tests__/chatDispatchProfileOptions.test.ts` pin dispatch
  inheritance and override behavior.
- `halfStreaming` is a profile/runtime option alongside `useStreaming`.
  `server/fastify/src/routes/generationChat.ts` advertises it in the initial
  `info` frame. `server/fastify/src/prompt/sseEvents.ts` declares the
  `TokenEvent` fields, while
  `server/fastify/src/prompt/providerTransport.ts` accumulates per-delta token
  counts and emits `generatedTokens`/`elapsedMs`, including on empty-content
  progress events for stripped reasoning. Browser
  `src/ts/process/request/serverChat.ts` buffers visible text while
  `src/ts/process/halfStreamingProgress.ts` computes throughput. Agent Preset
  steps deliberately disable both streaming modes; see
  [Agents And Presets](agents-and-presets.md#provider-dispatch-and-history).
  Stop retains a non-empty buffered partial: server-backed streams reconcile the
  processed persisted snapshot, while local-provider streams apply the partial
  through client editoutput before cleanup.
- Provider stream failures before any token keep the current no-row behavior.
  Once tokens have arrived, the accumulated partial runs through the
  editoutput-only interrupted-result pipeline and is retained as a failed
  assistant row; the pre-generation transcript is not restored over it.
- `FASTIFY_TOKENIZER_OPTIONS` in `src/ts/model/tokenizerOptions.ts` is the
  portable tokenizer catalog. Runtime override wins over runtime default, then
  the Custom API provider choice. Fastify loads the matching implementation
  through `server/fastify/src/prompt/webTokenizers.cjs`.
  `server/fastify/__tests__/tokenizerGoldenCounts.test.ts` pins client-engine
  golden counts, while `src/ts/tokenizer.test.ts` keeps the exposed browser and
  server tokenizer families aligned.
- The legacy `additionalParams` table applies to ordinary providers only when
  `applyAdditionalParamsToAll` is literally true. Reverse proxy continues to
  use its flat rows and `xcustom:::` continues to use its own rows regardless.
  Global rows apply before profile-owned rows, so profile values and explicit
  profile headers win. Browser/server parity lives in
  `src/ts/process/request/shared.ts` and
  `server/fastify/src/generation/additionalParams.ts`.

## Server-Owned Provider And Media Operations

Provider catalogs, translation utilities, embeddings, TTS, images, and
transcription use authenticated, no-store Fastify operations so stored secrets
do not enter browser provider code. Dynamic NanoGPT account/model fetching
lives in `src/ts/model/nanogpt.ts`. The catalog/account allowlist covers
NanoGPT, OpenRouter, LLM Gateway, Neuralwatt, Ollama Cloud, WaveSpeed, Google,
Anthropic, ElevenLabs, and Fish Speech; it also owns Google token counting and
DeepL/DeepLX translation. Use
`packages/protocol/src/providerOperation.ts`, not a picker list, as the
operation name/type source of truth;
`server/fastify/src/providerOperations.ts` owns the executable upstream
allowlist. These operations do not require the active writer; MCP OAuth refresh
is the documented persistence exception.

Each contract accepts a fixed discriminator and bounded typed input. Custom
endpoints are validated by the operation that permits them; there is no generic
URL/method/header proxy. Response size, timeout, error detail, and disconnect
cancellation are bounded.

| Route / browser adapter | Fixed boundary | Result / rate limit |
| --- | --- | --- |
| `POST /api/v1/provider-operations` / `src/ts/server/providerOperations.ts` | The fixed provider-operation allowlist above. | Typed JSON data, `60/min` |
| `POST /api/v1/embedding-operations` / `src/ts/server/embeddingOperations.ts` | `ada`, OpenAI v3, Voyage Context 3/4, or custom embeddings. A stored secret cannot accompany a changed one-shot custom endpoint. | JSON vectors/groups, `60/min` |
| `POST /api/v1/tts/synthesize` / `src/ts/server/tts.ts` | ElevenLabs, Fish, Hugging Face, NovelAI, or OpenAI-compatible synthesis. Stored-character OpenAI credential, endpoint, and options resolve atomically by character id. | Audio bytes, `60/min` |
| `POST /api/v1/image-generation` / `src/ts/server/imageGeneration.ts` | NovelAI, DALL-E, Stability, Fal, Imagen, OpenAI-compatible, WaveSpeed, or Kei generation. | JPEG/PNG/WebP bytes, `10/min` |
| `POST /api/v1/media/openai/transcriptions` / `src/ts/server/openAITranscription.ts` | One bounded OpenAI `whisper-1` upload with fixed VTT output. | VTT text, `10/min` |
| `POST /api/v1/mcp/oauth/refresh` / `src/ts/server/mcpOAuthRefresh.ts` | Exact stored MCP identity selects its credential; a rotated refresh token may persist. See the MCP guide. | JSON access token, `30/min` |

Shared request/result types live in the matching modules under
`packages/protocol/src/`; browser request adapters live under `src/ts/server/`,
implementations are the matching files under `server/fastify/src/`, and route
registration lives under `server/fastify/src/routes/`. Catalog helpers use
`src/ts/model/keyedRequestCache.ts`: OpenRouter, NanoGPT, and public LLM
Gateway/Neuralwatt catalogs cache safe successes for 30 seconds;
credential-keyed Ollama Cloud tags use 15 seconds; local Ollama discovery is
uncached. NanoGPT balance/subscription calls dedupe concurrent work only.
Stored-credential refs bypass completed reuse so key rotation is visible, and
the legacy model settings surface debounces draft catalog credentials for
400 ms in `src/lib/Setting/Pages/BotSettings.svelte`.

## Capability Table And Dispatch Boundary

`packages/shared-core/src/providerCapability.ts` is the shared pure routing
decision table. Given resolved metadata and narrow configuration, it returns a
server provider or a stable unsupported reason. Do not fork this logic for chat
or completion: browser preflight and Fastify dispatch use the same decision.

The live provider core is `server/fastify/src/prompt/chatDispatch.ts`; adapters
are under `server/fastify/src/generation/`.

| Adapter family | Current transport contract |
| --- | --- |
| OpenAI | Chat Completions, Responses, OpenAI-compatible variants, and legacy instruct. OpenRouter and NanoGPT select compatible variants from stored format settings. |
| Anthropic | Native Messages dispatch, including supported thinking, cache-point, and tool conversion. |
| Gemini / Vertex | Native content conversion, thinking controls, media inputs/outputs, and optional tool translation. |
| Managed/legacy | Mistral, Cohere, Ollama, Bedrock/SigV4, Kobold, Horde, Ooba legacy, and Echo. |
| Shared | Provider-safe message conversion, additional parameters, JSON controls, response frames, reasoning envelopes, and API metadata. |

Kobold and Ooba legacy use the fixed `## Instruction` / `## User` /
`## Assistant` / `## Response` flattening. Horde uses ChatML for its `chatml`
and `gpt2` choices and otherwise a generic `role: content` form. Fastify does
not run the browser's other instruct templates or custom Jinja engine; the
OpenRouter Use Instruction Prompt toggle remains unsupported server-side.
Kobold replaces only a root/one-character URL path with `/api/v1/generate`;
longer user-supplied paths are posted verbatim. OpenAI-family adapters normalize
legacy selector aliases such as `gpt4o` to their provider IDs only at the wire
boundary, while stored selections retain their legacy IDs.

Provider adapters remove prompt-only metadata and convert supported media.
OpenAI/Anthropic conversion is centralized in
`server/fastify/src/generation/providerMessages.ts`; Gemini and Responses use
native converters. The shared converter also preserves supported reasoning
continuation and applies Anthropic cache points. Provider reasoning is
normalized into the shared `<Thoughts>` envelope.
`server/fastify/src/generation/jsonControls.ts` parses retained JSON-schema or
TypeScript-interface syntax and performs configured dot-path extraction on
buffered results.

Dispatch materializes only fields declared by selected model capabilities:
top-p/top-k/min-p/top-a and penalty samplers, reasoning/thinking/verbosity,
seed, JSON schema/extraction, prediction, cache/privacy headers, additional
parameters, and provider-specific options. Incremental and buffered adapters
both become chat SSE token/done frames.

Routing remains data-driven. Vanilla OpenAI ids use the server allowlist;
unknown compatible ids require custom/provider configuration. `risu::` reverse
proxy URLs derive their endpoint/key behavior from stored proxy settings and
add the Risu identification header. OpenRouter requires routable persisted
settings. NanoGPT message, legacy, and Responses formats select Anthropic,
legacy-instruct, and Responses adapters respectively. Ollama Cloud remaps by
`ollamaRequestFormat`; Bedrock resolves its wire-model prefix; Horde requires an
instruct template and stays buffered. Direct `/api/v1/generate/completion`
therefore rejects streaming for Cohere, legacy instruct, Responses, Kobold,
Ooba legacy, Bedrock, and Horde rather than simulating it.

## Provider-Specific Runtime Contracts

### OpenAI Chat And Flex Processing

The opt-in `openAIFlexProcessing` compatibility setting maps to
`service_tier: "flex"` only when the resolved endpoint host is the official
`api.openai.com`. An explicit supported service tier still takes precedence.
The restriction and mapping live in `server/fastify/src/prompt/chatDispatch.ts`
and `server/fastify/src/generation/openai.ts`.

OpenAI Chat-family dispatch also tokenizes assembled prompt-bias rows into
`logit_bias`. Main send/regenerate can ask OpenAI/OpenRouter/NanoGPT for up to
20 choices; extra results become reroll alternates.

### OpenAI Responses

`server/fastify/src/generation/openaiResponses.ts` sends
`input: ResponseItem[]`, not Chat Completions `messages`. User/system rows
become input-content items; an enabled developer-role capability maps system
rows to `developer`; image data becomes `input_image`; audio/video data becomes
`input_file`. Assistant rows become output-message items, and a trailing
assistant row is marked `incomplete` to continue that response.

The adapter requests an automatic reasoning summary when reasoning is enabled,
normalizes returned reasoning into the shared envelope, and translates only
validated bounded tool definitions, function calls, and prior tool rounds.
`server/fastify/src/generation/serverTools.ts` is the common validation and
wire-translation owner.

### Gemini Thinking And Generated Media

`server/fastify/src/prompt/chatDispatch.ts` maps the effective reasoning tier to
Gemini `thinkingLevel` (`minimal`, `low`, `medium`, or `high`). An explicit
thinking-token budget wins; tools suppress thinking configuration; models with
the no-minimal flag map `minimal` to `low`.

Image or audio output selects `responseModalities` with text plus the requested
media and forces buffered `generateContent` dispatch. The Gemini adapter
validates returned inline data, persists it through
`server/fastify/src/inlayAssetPersistence.ts`, and inserts
`{{inlay::assetId}}` into the generated text. Invalid base64, unsupported MIME,
or persistence failures produce bounded warning frames and skip only that media
part. Text-only requests may continue to use native streaming.

## Chat Dispatch And Tool Transport

Browser preflight uses `effectiveModelDatabaseForChat()` for route and image
gates. Fastify then builds the full chat-scoped config in
`server/fastify/src/prompt/effectiveGenerationConfig.ts`, resolves the profile
and secrets again, and calls `server/fastify/src/prompt/chatDispatch.ts`. Prompt
and Agent Preset precedence is owned by the linked prompt and Agent guides.

Normal server-intent completion sends shaped messages plus role/static/fallback
intent but no provider, endpoint, options, or secret. Fastify rejects those
fields in the envelope and resolves them from persisted settings. The lower
level protocol accepts bounded `tools` and completed `toolRounds`; tool-bearing
requests are buffered. `@risuai/protocol/server-tool` validates definition and
call names, schemas/arguments, prior results, round counts, and total payload
sizes, while `server/fastify/src/generation/serverTools.ts` translates supported
OpenAI, OpenRouter, NanoGPT, Anthropic, or Gemini wires.
Provider-returned `toolCalls` are validated before the browser receives them.
`server/fastify/src/prompt/effectiveGenerationConfig.ts` copies profile
`modelTools` into the effective database, and OpenAI Responses adds
`web_search_preview` when `search` is enabled.

Transport support is not MCP execution. The browser maps a returned call to an
available tool and sends the result in a later round. Chat generation and Agent
Preset execution do not run arbitrary browser MCP tools. Ollama's tool loop is
also browser-owned; `server/fastify/src/ollamaCloudToolProxy.ts` only protects
the stored cloud credential.

## LLM Request History

With nonzero `requestHistoryLimit`, the shared dispatch boundary starts one
SQLite row per actual provider attempt. Retries and fallback profiles therefore
produce separate rows. Chat, Agent Preset, translation, script, and
server-intent calls pass source/context metadata through
`server/fastify/src/prompt/chatDispatch.ts`;
memory summarization and legacy completion wrap their separate adapters.

`server/fastify/src/requestHistory.ts` stores the handle's provider-attempt
`startedAt`, completes it on the terminal provider frame/error/cancellation,
and computes `durationMs` as `completedAt - startedAt`. Completion is persisted
before the terminal frame is yielded, so UI time reflects the finished attempt
rather than a later history read. History writes are best-effort and cannot
turn a valid provider response into a generation failure.

A detail row contains a credential-free profile snapshot, finalized prompt,
optional chat/toggle context, accumulated response, terminal metadata, and
provider API metadata. Provider option objects and secrets are not stored.
Tool rounds stay with the prompt; returned tool calls and alternates are
terminal metadata. `server/fastify/src/generation/apiMetadata.ts` removes each
adapter's main content/error fields from the separate API metadata object.

List reads expose at most a 240-character response preview and no prompt;
authenticated, no-store detail reads expose private prompt/context data.
Deletion additionally requires the active writer through the
`request-history-delete` entry in `server/fastify/src/routeManifest.ts`.
Retention defaults to 20, clamps at 10,000, and zero disables recording and
clears rows; lowering the value prunes immediately in the same settings command.
Server ownership is `server/fastify/src/requestHistory.ts` and
`server/fastify/src/routes/requestHistory.ts`; browser validation/detail and
retention controls live in `src/ts/server/requestHistory.ts` and
`src/lib/Setting/Pages/RequestHistorySettings.svelte`.

Repository/route contracts are covered by
`server/fastify/__tests__/requestHistory.test.ts` and
`server/fastify/__tests__/requestHistoryRoutes.test.ts`. Credential privacy and
visible retention behavior are additionally pinned by
`server/fastify/__tests__/generation.completion.test.ts`,
`server/fastify/__tests__/agentPresetExecution.test.ts`, and
`src/lib/Setting/Pages/RequestHistorySettings.svelte.test.ts`.

## Compatibility Boundaries

- Legacy `aiModel`, `subModel`, `modelRoles`, `seperateModels`, fallback rows,
  separate parameters, and provider globals remain conversion/compatibility
  data, not the preferred profile workflow.
- Compatibility profiles without `providerId` can run when inference plus the
  capability table is sufficient. Unsupported explicit provider ids remain
  preserved placeholders and block active generation.
- Memory-role profile and preset resolution is canonical in
  [Prompt Assembly And Scripting](prompt-assembly-and-scripting.md#hypa-v3-and-bardwiki-memory-phase).
  Embeddings remain on the separate Hypa/Voyage/custom contract; provider
  deadlines are bounded by `server/fastify/src/memoryProviderDeadline.ts`.
- `customModels` / `xcustom:::` remains separate from first-class Custom API
  profiles.
- Retained retired settings must not be mistaken for live controls. See
  [Generated Files And Legacy Caveats](generated-and-legacy.md#stale-or-no-port-surfaces).

## Adding Provider Behavior

Update the browser model/settings metadata, the shared capability table,
profile/provider-id resolution, `server/fastify/src/prompt/chatDispatch.ts`, the
selected adapter, credential groups, and chat/completion tests. A managed
provider with a catalog also needs a fixed discriminator in
`packages/protocol/src/providerOperation.ts`, an allowlisted
`server/fastify/src/providerOperations.ts` implementation, and operation tests.
Keep prompt assembly, translation, and Agent-specific behavior in their related
guides rather than duplicating it here.
