# Translation And Input Hooks

Last audited: 2026-08-09.
Targeted source check: 2026-09-12 (translation deadlines, refresh retirement, and input-hook writer/session fencing).

This guide owns translation pipelines, translator model routing, history slots,
cache identity, detached message and greeting jobs, generated-message automatic
translation, and draft/BTW input-hook execution. Start from the
[architecture index](README.md) for cross-cutting ownership.

## Related Guides

- [Providers And Models](providers-and-models.md) owns model profiles,
  provider adapters, credentials, and request-history capture used by LLM
  translation.
- [Prompt Assembly And Scripting](prompt-assembly-and-scripting.md) owns normal
  CBS/history variables and starts automatic translation only after generation
  persistence.
- [Svelte Chat UI](../../src/docs/svelte-chat-ui.md) owns composer, draft/BTW,
  loading, translation-status, and greeting controls.
- [Svelte Settings UI](../../src/docs/svelte-settings-ui.md) owns translator and
  input-hook editors rather than the runtime contracts below.

## Runtime Map

| Path | Role |
| --- | --- |
| `packages/shared-core/src/translatorPresets.ts` | Translator preset normalization and selection shared by browser and Fastify. |
| `src/ts/translator/presets.ts` | Browser import/export codec and compatibility re-exports. |
| `packages/shared-core/src/translatorPipeline.ts` | Ordered step resolution, prompt slots, ChatML parsing, named outputs, and reasoning cleanup. |
| `packages/shared-core/src/historySlots.ts` | Shared source/translated history filtering and token-bounded rendering. |
| `src/ts/translator/translator.ts` | Browser HTML/plain translation, provider-operation calls, LLM dispatch, and browser caches. |
| `server/fastify/src/translation/rawMessageTranslation.ts` | Server Google/DeepL/DeepLX/LLM translation and settings/source identity. |
| `server/fastify/src/translation/serverMessageTranslation.ts` | Detached message work and source/job-fenced targeted persistence. |
| `server/fastify/src/translation/serverGreetingTranslation.ts` | Detached manual greeting work with source/settings/previous-value fences. |
| `server/fastify/src/translation/generationCompletionTranslation.ts` | Generated-message eligibility, wait cap, terminal result, and notification coordination. |
| `src/ts/process/inputHooks.ts` | Non-streaming draft/BTW execution with optional profile override. |
| `src/ts/process/draftHookTranslation.ts` | Source-bound original-text translation metadata for Draft Translation mode. |

## Translator Preset Pipeline

Translator presets contain at most five ordered steps. Runtime executes enabled
steps in order and uses the first step when all are disabled. Each step can
inherit the `translate` model role or name a durable model profile, take the
original source, previous output, or a named prior output, and publish an
optional output key. The first step remains mirrored into legacy
`translatorPrompt` and `translatorMaxResponse` for compatibility.

Selection is collection-owned: translator-preset commands in
`server/fastify/src/routes/commands.ts` normalize `translatorPresetId` and keep
the selected first-step legacy mirrors synchronized. Translator defaults and
language settings are normalized by
`server/fastify/src/databaseDefaults.ts`; `packages/shared-core/src/settingsGroups.ts`
exposes the selection pointer through the language read projection while
reserving writes to the preset command family.

Schema migration v37 converts legacy numeric or unavailable global selections
to a stable ID in an existing canonical translator-preset collection. Backup
restore applies the same repair. Preset bodies and valid stable selections are
preserved; ordinary resource reads never repair stored settings. If translator
ownership remains unavailable, the optional greeting-translation read returns
`settingsHash: null` and no translations instead of an internal server error.

Each chat can override that global selection with its optional stable
`translatorPresetId` string. `src/ts/translator/presets.ts` resolves a valid
chat binding first and falls back to the global stable selection when the
binding is absent or unavailable; bound presets never replace the global
legacy mirrors. The guarded chat-metadata PATCH owns selection and clearing.
Deleting a preset clears matching chat bindings in the same transaction and
uses state invalidation so preset and chat projections refresh together.
Standalone-chat and full-save imports retain only bindings backed by their
destination/imported preset collection.

`packages/shared-core/src/translatorPipeline.ts` expands language, source, previous-output,
named-output, translator-note, and history slots before parsing optional
role-tagged ChatML. Without ChatML, a prompt containing an embedded input slot
becomes one system row; otherwise the current pipeline value is added as the
user row.

Every LLM step strips recognized `<Thoughts>` and `<think>` wrappers before its
result is chained, cached, or persisted. If profile `stripCoT` is enabled, the
shared provider-frame wrapper removes them earlier and request history sees the
clean output. If it is disabled, request history retains the provider response
and only the translation consumer is cleaned.

In Send Text As-Is plus Exclude Chain-of-Thought mode, the same cleanup
also applies to source text and translation-history slots before dispatch.
Outside Send Text As-Is, translation preserves blank separators and complete
raw media-marker lines beginning `{{img`, `{{raw`, `{{video`, or `{{audio`;
only the surrounding text chunks are translated.

Google, DeepL, and DeepLX use the fixed provider-operation boundary described
in [Providers And Models](providers-and-models.md#server-owned-provider-and-media-operations).
LLM steps resolve profiles and call the shared Fastify provider dispatcher with
streaming and multi-generation disabled.

## Translation History Slots

`{{slot::history::N}}` renders source text and
`{{slot::historytrans::N}}` renders stored translations. `N` must be 1-50.
These slots are shared by server LLM Send Text As-Is translation and browser
draft/BTW hooks; they are separate from normal CBS `{{history::N}}`.

The renderer in `packages/shared-core/src/historySlots.ts` walks backward from the
target row, skips disabled/comment rows, stops at `disabled: "allBefore"`, and
adds the owned greeting only when the requested window exhausts stored history.
It restores chronological order, formats `user`/`char` blocks, and drops the
oldest entries until the combined source plus translated representation fits
`translatorHistoryMaxTokens` (2,048 by default).

The server uses synchronous tokenization for message translation. Input hooks
use the async browser tokenizer and ask the chat screen to hydrate enough pages
for the largest referenced count. The chat target and composer operation are
checked again after hydration and hook completion so a navigation change cannot
apply stale output. That UI coordination is documented in the Svelte Chat UI
guide. Shared browser/server slot behavior and bounded hydration are pinned by
`src/ts/process/inputHooks.test.ts`,
`src/lib/ChatScreens/DefaultChatScreen.loadPages.test.ts`, and
`server/fastify/__tests__/rawMessageTranslation.test.ts`.

## Browser Translation Caches

`src/ts/translator/translator.ts` has distinct bounded caches:

- The 256-entry plain/provider cache is keyed by direction, exact text, and the
  translator-settings signature. It deduplicates in-flight work, refreshes hits,
  and clears when the active character/chat scope changes.
- The 64-entry translated-HTML memo avoids repeating DOM segmentation and
  edit-translation regex work for an identical rendering context.
- The 256-entry LLM cache is persistent through localForage with a bounded
  in-memory fallback when quota writes fail. Its signature includes source,
  direction/languages, full pipeline structure, Send Text As-Is and
  thought-exclusion modes, translator note, character context, and the resolved
  translate-profile signature. Obvious provider secrets are excluded.

Pipeline edits, selected profile changes, and relevant runtime options therefore
invalidate LLM hits; unrelated settings do not. Forward and reverse keys remain
separate. Browser translation captures the effective chat binding before
asynchronous work and threads it through pipeline execution and every cache
signature; explicitly no-chat surfaces such as Playground stay global, while
inactive-chat export passes the exported chat's binding. `src/ts/translator/translator.cache.svelte-node.test.ts`
pins signatures, deterministic eviction, chat-scope clearing, quota fallback,
and secret exclusion.

These browser caches are not an authority for server message persistence.
`autoTranslateCachedOnly` disables generated-message LLM auto-translation
because the server path does not read the browser LLM cache.

## Server Translation Identity And Fences

`server/fastify/src/translation/rawMessageTranslation.ts` hashes the exact
source into `sourceHash` and a stable translator configuration into
`settingsHash`. The settings hash includes translator type and languages,
pipeline signature, Send Text As-Is/thought options, history budget, translator
note, translate-model/profile/runtime identity, and relevant provider settings.
The stored translation carries both hashes plus language/type metadata.

Manual message translation starts provider work outside the mutation
transaction. Before persistence,
`server/fastify/src/translation/serverMessageTranslation.ts` verifies the active
job handle, captured database lineage, exact source text, previous translation,
and current row. Greeting translation uses the same lineage fence. It then
rebases a targeted write on the current revision. A stale job can finish but
cannot overwrite newer source or translation state. The raw translation owner
settles its deadline independently of provider abort handling, checks cancellation
before subsequent chunks/steps and before returning, and discards late provider
success or failure. Message and greeting callers then retain the failed terminal
and permit an explicit new request without waiting for that provider.

`server/fastify/src/messageTranslationJobs.ts` keeps running jobs plus recent
succeeded/failed terminals for ten minutes, capped at 128. Errors are bounded
and redacted. Bootstrap exposes these entries as
`activeMessageTranslations`, allowing the browser state in
`src/ts/server/messageTranslationJobs.ts` to recover after navigation or
disconnect. Message and greeting refreshes allow one read per lifecycle, reject
responses after intervening projection changes or stop/restart, and remove the
scheduled timer when no running jobs remain.

Both registries retire active and terminal projections when database lineage
changes, including when imported/restored targets retain identical IDs/text.
These registries are process-local, not durable work queues. Committed translation
rows survive a server restart; an unfinished request and its job history do not
resume from a durable translation job. Storage failure exposes a failed terminal
and supports an explicit new translation request. Generated automatic translation
shares this execution boundary: a still-running translation after its notification
wait cap is not a promise of durable provider resumption.

## Greeting Translation

Greeting translation is manual-only and has a separate process-local job
registry. `server/fastify/src/translation/greetingTranslationStore.ts` stores
normalized rows keyed by character, greeting index, and settings hash, with the
source hash guarding edits.
`server/fastify/src/translation/serverGreetingTranslation.ts` snapshots the
source, chat-resolved settings, and previous row, performs detached work, and
rechecks all three plus the current job before persistence. Greeting reads and
translate commands carry the owning `chatId`; the store can safely reuse a row
when source and effective settings hashes match, while client projections and
job identities remain chat-scoped.

`server/fastify/src/greetingTranslationJobs.ts` uses the same ten-minute
terminal retention and 128-entry cap as message jobs. Bootstrap publishes
`activeGreetingTranslations`; `src/ts/server/greetingTranslations.svelte.ts`
refreshes the character/chat projection and rejects settings/source-mismatched
rows.
Greeting store and recovery contracts are covered by
`server/fastify/__tests__/greetingTranslationStore.test.ts` and
`src/ts/server/greetingTranslations.test.ts`.

## Generated-Message Auto-Translation

Automatic translation begins only after the generated assistant row is durably
persisted.
`server/fastify/src/translation/generationCompletionTranslation.ts` rechecks
chat and translator settings, then uses the same message-job registry and fenced
persistence path as manual translation.

While waiting, the chat stream emits `post_generation_progress`. Terminal
`done.postGeneration` includes the persisted message id and a `succeeded`,
`failed`, or still-`running` outcome. The route waits until settlement or
`autoTranslateNotificationDeferCapSeconds` (180 seconds by default). A capped
job continues in the background, remains recoverable through bootstrap, and
delivers the completion notification once when it settles or the cap expires.

`src/ts/process/serverGeneratedMessageTranslation.ts` applies embedded success
immediately and maps running/failure outcomes into the shared job state.
`src/ts/process/generatedMessageTranslationEligibility.ts` prevents the older
rendered-message compatibility trigger from starting a duplicate job. Guards
live in
`server/fastify/__tests__/generationChatCompletionTranslation.test.ts` and
`src/ts/process/serverGeneratedMessageTranslation.test.ts`.

## Draft And BTW Input Hooks

`InputHook` records in `src/ts/storage/database.svelte.ts` are `draft` or `btw`
hooks with a prompt, optional Draft Translation flag, and model selection:
`inheritOtherAx` or a durable `modelProfile` id. Missing legacy `model` data
inherits the `otherAx` role and its normal fallback behavior.

`src/ts/process/inputHooks.ts` substitutes `{{slot::content}}`,
`{{slot::draft}}`, and the shared history slots. It parses ChatML when present;
otherwise a prompt containing a slot becomes one user row, while a prompt
without slots becomes a system instruction plus the content user row. Dispatch
uses `requestChatData(..., "otherAx")`, forces non-streaming/single-output mode,
and passes `profileIdOverride` only for a valid per-hook selection.
`runInputHook()` rejects failed, streaming, and multiline responses, then
returns `rq.result.trim()`, including an empty successful result. UI callers
perform the empty-text guard before applying it; for example,
`src/lib/ChatScreens/DefaultChatScreen.svelte` reports the empty-text error and
preserves the composer.

Input hooks require current writer authority before parsing/tokenization and
provider dispatch. `src/ts/process/inputHooks.ts` captures the managed session
generation, aborts pending work when authority or session changes, and rechecks
the fence before dispatch and before returning a result. Connected readers are
rejected without starting model work; a late result from an old writer/session
cannot replace composer text.

Before a selected Draft hook runs during send, the chat loading contract uses
stage 5 at progress 20. The constants live in
`src/lib/ChatScreens/chatGenerationLoading.ts`; presentation belongs to the
Svelte Chat UI guide. BTW hooks use the same runtime and model-routing contract
without becoming part of server prompt assembly.

When a Draft hook has Translation enabled, sending the reviewed Draft output
stores that output (including appended inlay markers) as the user message and
stores the original composer text as its source-bound `MessageTranslation`.
`src/ts/process/draftHookTranslation.ts` hashes the exact sent message as
`sourceHash` and the hook id/prompt/model selection as `settingsHash`. Later
message edits invalidate the paired original through the normal source-hash
rule. `src/ts/process/draftHookTranslation.test.ts` and
`src/ts/process/inputHooks.test.ts` pin these behaviors. The chat-level Draft
Translation, exact inlay-inclusive source hash, empty-result, and stale-owner
guards are covered by
`src/lib/ChatScreens/DefaultChatScreen.loadPages.test.ts`; server source-hash
and settings-identity behavior remains covered by
`server/fastify/__tests__/rawMessageTranslation.test.ts`.

## Change Checklist

When changing translator steps or identity, update pipeline normalization,
browser cache signatures, server settings hashes, message/greeting fences, and
their tests together. When changing input-hook slots or model selection, update
the hook schema, history hydration, non-streaming dispatch, draft-translation
signature, and Svelte editor/status documentation without copying UI behavior
into this guide.
