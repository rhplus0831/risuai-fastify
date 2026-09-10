# Agents And Presets

Last audited: 2026-08-09.
Targeted source check: 2026-09-10 (authoring diagnostics, presentation state, and certified deletion impact).

This guide owns reusable Agents, Agent Preset records and selection, model
resolution, module/reference inputs, lorebook inputs, dependency execution,
output composition, and the command/compatibility surface. Start from the
[architecture index](README.md) for cross-cutting ownership.

## Related Guides

- [Providers And Models](providers-and-models.md) owns durable profiles,
  credentials, provider adapters, runtime precedence, and request history.
- [Prompt Assembly And Scripting](prompt-assembly-and-scripting.md) owns the
  surrounding chat assembly and post-generation order.
- [Svelte Settings UI](../../src/docs/svelte-settings-ui.md) owns Agent and Agent
  Preset editors, diagnostics, status presentation, and selection controls.
- [Svelte Chat UI](../../src/docs/svelte-chat-ui.md) owns progress and sidebar
  interaction while an Agent Preset is effective.

## Record Model

`packages/shared-core/src/agentPresetRecords.ts` is the schema and validation
owner. Its reader/validator inputs accept the deep readonly Agent, preset, use,
step and toggle views exported alongside the mutable record types. Callers
retain ownership of those records and nested arrays. Resolvers return the
borrowed preset as readonly; normalized records and resolved execution steps
are separately owned mutable outputs.

An `AgentRecord` is reusable behavior: id/name/description/version,
instruction, optional role-tagged ChatML mode, default model and runtime limits,
prepared-input scopes, configurable toggles, named lorebook inputs, and output
format. Editing one Agent affects every preset that uses it.

An `AgentPresetRecord` composes Agents through ordered
`AgentPresetUseRecord` rows. A use owns enabled state, before/after-main phase,
same-phase dependency ids, output key, destination, failure policy, and optional
model/runtime overrides. The preset owns enabled state, optional concurrency
limit, module integration, and optional final-output template. Duplicating a
preset duplicates its wiring but retains references to the same Agents.

| Contract | Bound |
| --- | --- |
| Phases | `beforeMain`, `afterMain` |
| Destinations | `promptOutput`, `intermediate`, `userInput`, `finalOutput` |
| Output formats | Text or JSON object |
| Prepared scopes | Nine named opt-in scopes described below |
| Preset concurrency | 1-16 when explicitly set |
| Per-use timeout | 250-300,000 ms after Agent defaults/use overrides resolve |
| Agent toggles / lore inputs | At most 32 toggles and 16 lorebook inputs per Agent |

Deleting an Agent is blocked while any preset use refers to it. Output keys and
Agent-local keys use bounded identifier syntax; enabled output keys are unique
within a phase. Validation also rejects cycles, invalid dependencies, multiple
phase modifiers, missing Agents, and unavailable named-output references.

## Selection And Readiness

`packages/shared-core/src/agentPresetResolver.ts` and
`packages/shared-core/src/chatGenerationSettings.ts` own the selection semantics
shared by browser preflight and server assembly. An own-property
`chat.generationSettings.agentPresetId` wins over
`Database.agentPresetDefaultId`. An explicit blank chat value opts out rather
than falling back to the global default.

Resolution states are:

| State | Generation effect |
| --- | --- |
| `none` | No Agent Preset is selected; generation is ready. |
| `disabled` | The selected preset resolves as a ready no-op. |
| `missing` / `invalid` / `incomplete` | Generation is blocked with structured diagnostics. |
| `model_not_ready` | At least one enabled use cannot resolve a ready model/profile. |
| `ready` | The validated dependency plan can execute. |

Planning normalizes reusable Agent defaults plus per-use overrides, validates
phase-local dependency graphs, resolves every model, assigns stable dependency
levels, registers named outputs, and checks references before any Agent step or
main prompt is run. The same summary helpers drive settings diagnostics; the UI
does not maintain a second readiness model.

## Authoring And Safety Projections

`src/ts/agentPresetPresentation.ts` maps the canonical planner to visible
Ready, Empty, Disabled, Incomplete, Invalid, and Model not ready states. Empty
is a legal no-op presentation state, not a new resolver failure.
`src/ts/agentAuthoringIssues.ts` and the shared-core input/output-reference
analyzers produce field-linked authoring warnings and blocking errors without
changing runtime validation. The Svelte editor owns insertion, autocomplete,
compiled ChatML rows, sample-value output preview, and repair focus.

`src/ts/agentPresetDeletionImpact.ts` projects deletion consequences over the
ready settings, character/chat metadata, and loadout owners. It reports the
global default, explicit chat selections, loadouts, and post-delete effective
selection with stable-ID name fallbacks. Missing, loading, malformed, or
ambiguous owners return unavailable rather than a partial count. The dialog
rechecks this projection before submitting the existing server command; server
validation and cleanup remain authoritative.

## Module Overlay

An Agent Preset can own the compatibility-spelled `moduleIntergration` string,
using the same comma-separated module id or namespace contract as Prompt
Presets. `packages/shared-core/src/moduleIntegration.ts` and
`packages/shared-core/src/chatGenerationSettings.ts` union the effective Agent
integration with global `enabledModules`, character/chat module ids, and Prompt
Preset integration. Namespace matches are allowed and final rows are
deduplicated by module id.

The union is an effective generation overlay. Selecting a preset does not
mutate `enabledModules`. A disabled or absent preset contributes no Agent module
integration.

## Agent Preset Model Flow

Each resolved use selects one of two modes:

- `inheritMain` reuses the already-resolved chat-main profile, including its
  credential, request model, provider options, and effective runtime baseline.
- `modelProfile` resolves the named durable profile independently and blocks
  readiness when the id is absent, incomplete, unsupported, or credential
  incomplete.

Agent defaults resolve first; `modelOverride` and `runtimeOverride` on the use
then replace the corresponding Agent-owned selection and bounded runtime fields.
`server/fastify/src/prompt/agentPresetExecution.ts` applies the resulting
temperature, input/output character limits, timeout, and strict JSON-object
requirement before calling the normal provider dispatch boundary.

This model does not define context-binding ports or arbitrary provider request
objects. Credentials remain server-resolved, and profile/provider changes
follow [Providers And Models](providers-and-models.md#model-profiles-and-role-resolution).

## Prepared Inputs

An Agent can opt into nine inputs:

| Scope | Meaning |
| --- | --- |
| `recentChatTail` | Bounded recent transcript text. |
| `chatSearchSnippets` | Bounded quick-search matches from the active chat. |
| `lorebookContext` | Ordinary activated lorebook context. |
| `memoryContext` | Already-selected memory summary context. |
| `characterSummary` | Bounded character identity/description summary. |
| `personaSummary` | Bounded selected-persona summary. |
| `currentUserMessage` | Latest effective user message. |
| `previousAgentOutputs` | Aggregate successful outputs available to this level. |
| `mainDraft` | Edited main-model output; available only after main generation. |

A scope is collected and inserted only when both selected and referenced by its
exact `{{scopeName}}` token. It is not an implicit prompt appendix.
`server/fastify/src/prompt/agentPresetExecution.ts` bounds each collected source
and then enforces the resolved aggregate input limit.

## Instruction Expansion And CBS

ChatML Agents parse the instruction into role-tagged messages first. Each row
then receives normal CBS, including `{{history::N}}`, followed by prepared-input,
Agent-toggle, named lorebook-input, and named-output substitution. This fixes
wire roles before expansion and does not recursively interpret CBS-like text
introduced by a prepared input.

Non-ChatML Agents use the helper system prefill plus `Author instruction:`
wrapper. They receive only Agent-specific prepared-input, toggle, lorebook, and
named-output substitution, not the full standard CBS pass. The distinction is
covered by the ChatML/history cases in
`server/fastify/__tests__/agentPresetExecution.test.ts`.

An Agent toggle is boolean, select, text, or textarea. Active uses project their
definitions into the chat sidebar, while values are stored under
`agent:<agentId>:<localKey>` so two Agents can reuse a local key. Instructions
read `{{agentToggle::localKey}}`; authors do not use the storage namespace.

## Agent Lorebook Inputs

Named inputs use `{{agentInput::localKey}}`. Resolution matches the configured
entry display name, searches the active chat before the selected character, and
does not fall back when a chat-level name exists but is invalid.

A valid match is a regular nonempty lorebook entry marked `agentOnly` or
`extensions.risu_agent_only`, with Always Active disabled and both activation
key fields blank. Agent-only entries are excluded from normal lorebook
activation. All required inputs across both phases are checked before any
enabled Agent step or main prompt assembly begins.

`packages/shared-core/src/agentPresetRecords.ts` validates declarations;
`server/fastify/src/prompt/agentPresetExecution.ts` owns lookup, precedence,
bounding, and substitution. Ordinary lorebook activation is documented in
[Prompt Assembly And Scripting](prompt-assembly-and-scripting.md#lorebook-activation-and-injection).

## Dependencies And Named Outputs

Dependencies are acyclic and stay within one phase. The planner assigns levels;
runtime executes each level with the preset concurrency cap, preserving stable
result order even when calls finish out of order. A step runs only after its
dependencies have completed according to their failure policy.

`{{agent::outputKey}}` reads a successful named output independently of the
aggregate `previousAgentOutputs` scope. A before-main consumer can reference an
earlier before-main level. An after-main consumer can reference any successful
before-main output plus earlier after-main levels. Missing/disabled producers,
self references, same-level references, and future phase/level references make
the preset incomplete during planning.

Failure policies are optional, required, fixed fallback text, or stop
generation. Successful and fallback outputs can continue to later levels;
blocking failures stop the phase and return structured preset/phase/use
diagnostics. JSON-object steps parse and validate the final cleaned text before
publishing it.

## Destinations And Output Composition

`promptOutput` is available to main prompt rendering;
`intermediate` remains a named auxiliary result. At most one enabled before-main
`userInput` modifier is allowed; it must be last in that phase and replaces the
latest user message before main assembly, including durable submit
persistence. At most one after-main `finalOutput` modifier is allowed and must
be last in its phase.

After `editoutput` and all enabled uses complete, an optional
`finalOutputTemplate` runs through CBS. `{{slot::mainOutput}}` is the edited main
response and `{{agent::outputKey}}` can read a successful output from either
phase. The template takes precedence over direct `finalOutput`, but that
modifier's named result remains addressable. Missing required references are a
planning error; an optional failed output expands empty at runtime.

Post-generation placement and persistence are owned by
[Prompt Assembly And Scripting](prompt-assembly-and-scripting.md#post-generation-order-and-effects).
Resolver coverage is in `src/ts/agentPresetResolver.test.ts`; execution,
concurrency, failure, and composition coverage is in
`server/fastify/__tests__/agentPresetExecution.test.ts` and
`server/fastify/__tests__/assemble.test.ts`.

## Provider Dispatch And History

Agent steps use the normal `dispatchChatProvider()` boundary, so profile
credentials, capability routing, provider metadata, Strip CoT, and one
request-history row per attempt remain shared. Agent-specific cleanup always
strips reasoning before an output is bounded, parsed, chained, inserted, or
persisted. With profile `stripCoT` disabled, request history still retains the
provider response; enabling it moves cleanup to the shared frame boundary.

`prepareDatabaseForStep()` explicitly sets `halfStreaming = false`,
`useStreaming = false`, and `modelTools = []`. Agent steps are buffered and do
not expose provider tool calling. Progress is reported as
`agent_preset_progress` on the surrounding chat stream, not as provider token
frames.

## Commands And Compatibility

| Responsibility | Owner |
| --- | --- |
| Browser Agent Preset reads, optimistic edits, rollback, and reference reconciliation | `src/ts/agentPresets.ts`; canonical browser projection is the `agents` settings group in `src/ts/server/resourceState.svelte.ts` |
| Command transport | `src/ts/server/commands.ts` |
| Route registration | `server/fastify/src/routes/commands.ts` |
| Server mutation/validation | `server/fastify/src/commands/agentPresets.ts` |

Agent Preset owner reads/writes require a ready, non-error settings group and
valid unique stable ids; a missing owner is not an empty editable collection.
Command families own
Agent create/update/duplicate/delete/reorder, preset metadata/default/order,
and preset-use create/update/delete/reorder. They validate the complete Agent
and preset collections before committing one revision/event.

Deleting an Agent Preset updates settings and only the chat/loadout rows that
select that preset. It preserves character/chat row identities and their
BardWiki dependents, while clearing the matching default and selection labels.
The complete loadout collection is still validated; unrelated chat bodies are
not materialized. Legacy embedded selections remain in their settings-owned
representation until explicit import/recovery extracts them.

`/agent-presets/:id/uses` is the canonical modular wiring surface. Older
`/agent-presets/:id/steps` commands are compatibility adapters over the same
records. Legacy embedded steps normalize into one standalone Agent and one use
per step, preserving dependency ids rather than deduplicating similar behavior;
canonical records retain an empty `steps` array only for storage/wire
compatibility.

Imported `agentContext*` fields are inert compatibility data. They are not
model-selection inputs, command-patchable live settings, or prompt triggers.
Do not infer editor behavior from them; use the Svelte Settings UI guide for the
current authoring surface.
