# Prompting, Generation, and Streaming

Last audited: 2026-09-04.

Targeted source checks: 2026-09-12 (reader/recovery boundaries and intermediate-display families).

This area covers the path from chat intent through prompt construction, provider dispatch orchestration, streaming, persistence, post-processing, cancellation, and reroll recovery. Provider wire formats are assessed in [Providers, Models, and Media](providers-models-and-media.md); scripting engines are assessed in [Scripting, Parsing, and Automation](scripting-parsing-and-automation.md); memory retrieval is assessed in [Memory and Embeddings](memory-and-embeddings.md).

Foreground recovery is checked at three boundaries. The obligation registry tests
in `src/ts/process/__tests__/generationRecoveryObligations.test.ts` cover exact
dispatch and terminal authority identities. The real-module lifecycle tests in
`generationRecoveryLifecycle.dom.test.ts` compose submission, durable outbox,
bootstrap acceptance, writer transitions, and strict transcript hydration.
`server/fastify/browser-smoke/acceptedSendProtocol.spec.ts` then exercises lost
and malformed accepted responses, a request still pending before acceptance,
Continue, and Retry against isolated Fastify and SQLite. Its same-page foreground
cases assert a stable page time origin and resource SSE connection; persisted
`pageshow` is also a supported in-place lifecycle trigger, but the dedicated
Pixel case reloads before dispatching synthetic visibility/`pageshow` events and
therefore does not prove a same-document back-forward-cache return.

The content-free diagnostic path is exercised by
`server/fastify/__tests__/diagnosticsGeneration.test.ts`,
`server/fastify/__tests__/providerDiagnostics.test.ts`, and
`server/fastify/__tests__/scriptDiagnostics.test.ts`. They validate prompt shape,
real provider transport timing/outcomes, Lua execution summaries, failed commit
disposition, and restart recovery without prompt/response text. The real HTTPS
helper journey joins a partial stream disconnect and failed commit to recovery
using stable operation/attempt references, and confirms recovery does not resend
the provider request. Privacy/access and artifact-boundary ownership remains in
[Remote Support Diagnostics](api-security-and-runtime.md#remote-support-diagnostics).

## Test groups

| Logical group | Relevant test locations and included cases | Behavior and regression importance |
| --- | --- | --- |
| Prompt sections and history | `src/ts/process/__tests__/{buildDescription,buildHistoryWindow,buildLorebookContext,buildPlainPromptSections,buildStaticPromptSections,formatHistoryMessage}.test.ts`; server `history.test.ts`, `plainSections.test.ts`, `staticSections.test.ts` | Individual cases cover description/personality/scenario ordering and prefixes; first-message, disabled/reset, examples, send-name and new-chat rules; lore placement/depth/position markers; main/jailbreak/global-note/COT/persona/author-note/view instructions; roles, thoughts, names, inlays, video, and multimodal history. Server history also preserves each source message's current alternate index for downstream script execution. These rules directly determine what a model sees. |
| Templates, variables, lore, input hooks, and prompt rendering | Client `normalizeTemplate`, `renderFinalPrompt`, `preflightTemplateTokens`, `promptTokenizeMemo`, `src/ts/process/inputHooks.test.ts`, and `src/ts/tokenizer.test.ts`; server `templates.test.ts`, `promptVariables.test.ts`, `lorebook.test.ts`, `preflight.test.ts`, `tokens.test.ts`, and `boundedRegex.test.ts` | Covers template normalization/order/cards/slices/cache points; variables including chronological `{{history::N}}` windows; conditionals and loops; lore sources/directives/decorators/recursion/budgets/depth plus `@@inject_at` append/prepend/replace ordering and one-time global-note injection; draft/ChatML input-hook substitution with aligned `history`/`historytrans` slots; tokenizer routing and chat overhead; collision-safe cache identity/eviction; regex limits; and final prompt-info capture. |
| Assembly eligibility and preflight | Client `request/tests/serverPromptAssembly.test.ts`, `request/tests/durableGeneration.test.ts`, `request/tests/providerCapability.test.ts`, and `sendChatPromptAssembly.lazyPromptTemplate.test.ts`; server `assemble.test.ts`, `preflight.test.ts`, `budgetFinalize.test.ts`, `generationBodyCap.test.ts` | Parameterized cases accept send/continue/regenerate/preview, compatible profiles, image-capable inlays/assets/multimodals, non-interactive Lua, and image-view instructions; they reject missing/invalid send tails, group chats, unroutable providers, non-vision media, strict interactive Lua, and deprecated plugin edit hooks. Assembly cases cover every stage, hashes, prompt assets, clone/load cost, mutations, and body/token ceilings. |
| Golden prompt and server-parity fixtures | `src/ts/process/__tests__/sendChat.fixtures.test.ts`, `sendChat.fixtures.serverBacked.test.ts`, and server `assemble.test.ts` | The local fixtures pin complete prompt rows for representative characters, templates, lore, scripts, multimodal data, and memory. Server-backed cases compare byte parity, scriptstate/input/output effects, image/view rows, failed-dispatch rollback, TTS side effects, and Hypa memory progress against those goldens. |
| Send setup, context maintenance, and error rollback | `sendChatContext.test.ts`, `sendChat.serverPreview.test.ts`, `sendChatErrors.test.ts`, `serverBackedSendChat.findMessage.test.ts`, `sendChatCompletion.test.ts`, `messageCompletionSound.test.ts`, `inlayFinalization.test.ts`, and `request/tests/serverMessagePatch.test.ts` | Covers preset/context selection, message-id and interaction maintenance, serialized command writes, pending persona/settings flushes, target rechecks, retained/terminal failures, preview and resend paths, successful background/reattached completion sounds, gesture-gated Web Audio unlocking without playback, shared decode and disposable-source cleanup, HTML audio fallback release, compare-and-set inlay finalization with one unrelated revision retry, server patches, in-chat errors, and field-scoped rollback. |
| Generation API, operations, durable jobs, SSE, and cancellation | Client `src/ts/server/generationOperations.test.ts`, `request/tests/{serverChat,serverCompletion,sseParse}.test.ts`, `dispatchRequest`, `nonStreamResponse`, `streamResponse`, `streamCoalescer`, and `reattach`; server `generationOperations.test.ts`, `generationOperationsStartup.test.ts`, `generation.chat.test.ts`, `generation.completion.test.ts`, `durableGeneration.test.ts`, `providerTransport.test.ts`, `terminalFrameAssertions.test.ts`, `stripCoTFrames.test.ts`, `streamBackpressure.test.ts`, `requestAbort.test.ts`, and stream-job tests | Covers atomic operation acceptance/replay, attempt and projection fences, startup recovery, intent headers/bodies, frame taxonomy, fragmented SSE, abort, disconnect/reattach, cancellation, explicit retry, partial persistence, finalization retry, stale targets, buffer caps, and slow consumers. Terminal reconciliation retries only failed strict chat hydrations once when a newer transcript projection invalidates the first response. Strip CoT cases remove nested reasoning tags across chunk boundaries while preserving unaffected frames. |
| Post-generation effects | Client `generationEffectLedger.svelte-node.test.ts`, `recoveredGenerationEffects.svelte-node.test.ts`, `generationPersistenceState.test.ts`, `outputTrigger`, `stage4Finalize`, `runStage4`, `notification`, `charEmotionStore`, `emotionFromResponse`, `emotionFallbackEmbedding`, `emotionFallbackLlm`, `imggenStableDiff`, `igp`, and `prereroll`; server `generationEffects.test.ts` plus post-generation cases in `generation.chat.test.ts`, `scripts.test.ts`, `triggers.test.ts`, and `luaRuntime.test.ts` | Verifies effect claim/lease/receipt and late-recovery classes, the bounded one-shot recovery claim for recent notification and completion sound, retry ownership after unavailable claims, restoration of a hydration-cleared finalization trigger, timing metadata, notifications, emotion extraction/fallback, image-generation routing, output-trigger patches, TTS/side effects, Lua edit-output, abort short-circuits, and resend decisions. |
| Reroll candidates and navigation | `src/ts/process/{rerollNavigation,rerollNavigation.guard,rerollNavigation.rollback}.test.ts`, reroll/alternate groups in server `messageStore.test.ts`, `commands.test.ts`, `generation.chat.test.ts`, and `server/fastify/browser-smoke/rerollSwipePersistence.spec.ts` | Covers next/previous wrap rules, active-index reconstruction, guard-safe writes, target-preserving regenerate admission, stale-target rejection, unchanged authority after failure, alternate-row persistence, reload reconstruction, and swiping back to an older response. |
| Agent and Agent Preset records, planning, mutations, and execution | Client `agentPresetRecords.test.ts` (standalone-Agent migration/sharing/default/override/graph/runtime/modifier and ChatML-mode cases), `agentPresetResolver.test.ts` (selection/dependency/phase/model/input/CBS cases), `agentPresetDiagnostics.test.ts`, `agentPresets.test.ts`, and `agentPresetProgress.test.ts`; settings/UI counterparts; server `agentPresetExecution.test.ts` and Agent Preset groups in `assemble.test.ts`, `generation.chat.test.ts`, and `commands.test.ts` | Protects reusable behavior resolution, preset-use overrides, valid dependency graphs and phases, named outputs, prepared input scopes, direct ChatML role requests without the default prefill, concurrency, profile selection, JSON output, failure policies, progress, timeouts, user-input/final-output destinations, CBS-composed final output, selected enabled module integration, and durable outcomes. |
| Prompt conversion persistence | `src/ts/process/prompt.conversionDurability.test.ts`: empty and unsupported files; applied, queued, and failed durable outcomes | Ensures imported prompt conversion is reported only after persistence settles, uses the correct localized success/queued/failure notice, and rejects inputs with no usable prompt without a false success. |
| Request-budget finalization and response control | `src/ts/process/__tests__/finalizeRequestBudget.test.ts`, `orchestrateResponse.test.ts`, and server `jsonControls.test.ts` | Budget cases report input tokens, clamp response/headroom, remove zero-budget rows while retaining multimodal-only content, and fail explicitly when no resolution is possible. Orchestration selects streaming/non-streaming paths, stops on abort, owns trigger/reroll/server-side-effect decisions, and returns the complete result. JSON controls accept TypeScript-interface/JSON schema forms, extract fenced/reasoned dot paths, and leave non-JSON output unchanged. |
| Generation trace privacy | `server/fastify/__tests__/generationTraceSidecar.test.ts`: consecutive PEM private-key redaction in the generation sidecar and metric fields | Prevents a multiline private key from leaking into opt-in generation diagnostics or their metrics. |
| Performance and communication cost | `src/ts/__tests__/{renderCostHarness,sendCloneCountProbe}.test.ts`, prompt/stream cache tests, server `serverLoadCostHarness.test.ts`, and command metric/range tests | Pins clone counts, maximum cloned object size, parser/render invalidation counts (including both background-generation completion orderings), SQL reads, table writes, prompt asset loads, and large-corpus request shape. |

## Intermediate Display

`packages/protocol/src/displaySource.test.ts` owns the wire and limits.
`src/ts/server/displaySources.test.ts` owns priority selection, JSON/SSE parsing,
same-chat batching, reader/writer lane behavior, fallback, cancellation, and
terminal invalidation. Server families include
`displaySourceQueue.test.ts`, `displaySourceCache.test.ts`,
`displaySourceDiagnostics.test.ts`, `displayModuleCache.test.ts`,
`displaySources.test.ts`, `generationInputDecoder.test.ts`,
`generationInputLoaders.test.ts`, and `generationInputTypes.test.ts` under
`server/fastify/__tests__/`.

The server route cases pin per-target ephemeral script state: one target can
read its temporary writes, the next starts from the authoritative snapshot, and
neither SQLite nor response revision changes. They also protect strict selected
loading, narrow active-module validation, handled compatibility fallback, cold
versus warm module/fingerprint caching, namespace retirement, queue priority,
and bounded content-free diagnostics. Browser cases prove that the final ranked
three distinct logical rows retain all layers, results can settle from a mixed
batch before background work, chat changes abort obsolete body consumption, and
terminal invalidation retires already delivered projections.

`server/fastify/browser-smoke/chatDisplayScrollStability.spec.ts` supplies the
real-browser late-SSE and scroll-anchor evidence; its four-case delayed-success
and handled-fallback matrix is described in
[App Navigation and Chat](app-navigation-and-chat.md#connected-reader-navigation-and-transcript).

## Normal-send browser durability

`server/fastify/browser-smoke/acceptedSendProtocol.spec.ts` drives the visible
composer through a gated real generation operation, incremental output, reload
during streaming, accepted completion, and a second full reload. It compares
visible DOM, hydrated client rows, authoritative messages and bootstrap operation
identity, and requires exactly one provider invocation. The other cases cover
lost acceptance responses, exact Retry, Stop, viewer reconnection, expired replay,
concurrent chats and queued finalization with the same deterministic provider
boundary. Browser lifecycle events and mobile profiles are controlled Chromium
conditions; they do not certify physical devices or a live external provider.

The lifecycle fixture shares a server across separate case pages and chat IDs.
Its isolated server trusts forwarded addresses, and each fresh browser page uses
a distinct documentation-range client IP so independent devices do not exhaust
one loopback login quota. Real authentication and writer checks remain enabled.
Before its direct generation-settings setup write, it waits for the exact ready
route, matching local and persisted SQL selection, and completion of that chat's
native selection intent. It records those read-only observations and leaves
active jobs in other chats alone. Import deliberately resets `configured` to
false, so the later configuration PUT remains necessary. This ordering prevents
fixture writes from creating a revision conflict with real chat navigation;
background readiness and generic composer visibility alone are insufficient.

The reliability audit strengthens this suite with lost Regenerate acceptance,
a retry that completes before its lost response can be reconciled, compatibility
send response loss followed by reload, a committed plugin-effect receipt held
past the browser control deadline, and two restarts before and two after queued
finalization settles. These compare exact transcript/operation identities,
provider invocations, outbox settlement, and durable effect rows. Compatibility
coverage removes only the advertised operation capability and faults the native
initial response; it verifies the real fallback POST and job-stream GET.

The focused effect-ledger suite holds fetch/JSON/auth boundaries through deadline
or writer loss, completes a replacement before releasing an old response, and
checks renewal coalescing and cleanup after a late failure. Recovered-effect tests
use generation-scoped receipt fixtures to prove that Chat B settles while Chat A
hydration or claim fails. The lifecycle DOM suite composes exact retry receipt,
strict terminal hydration, newer obligations, and mixed chat reconciliation.
`server/fastify/__tests__/durableGeneration.test.ts` also reproduces an unreasoned
assembly abort with a real job and verifies immediate follow-up admission; its
abort injection matches registry expiry semantics without waiting for a full
production deadline.

## Connected-reader viewing and writer effects

`src/ts/server/readerGenerationObservation.ts` and `src/ts/server/readerGenerationStream.ts`
provide selected-chat observation independently of the writer's `sendChat` and
recovery stores. Their focused suites cover immutable lineage/operation/attempt/job
identity, incomplete descriptors, bounded status/stream retries and deadlines,
half-stream/Continue replay, exact terminal hydration, auth loss and teardown
without cancellation. Healthy-focus cases cover both idle and active observation:
discovery is not restarted and an active viewer is retained, while suspension
still triggers recovery. Native focus/request evidence is indexed in
[Browser State Sync and Recovery](browser-state-sync-and-recovery.md#resource-hydration-and-navigation-races).
`src/ts/server/chatMessageHydration.test.ts` verifies exact
generation-suffix reads and late-reader fences. Its Reader-to-writer regression
uses actual role changes, retained-body hydration resets and equal-revision
metadata clones to require one authorized alternates read before reroll candidates
become ready. The existing reroll browser case verifies visible candidates after
real reload.
`src/lib/ReaderTranscript.svelte.test.ts` and
`src/lib/ChatScreens/readerGenerationRows.test.ts` cover transient row presentation and handoff.

The writer path remains in `src/ts/process/reattach.ts`. Its focused suite reproduces
the missing-descriptor eligibility loss using real operation helpers and verifies
one bounded authority probe, retained recoverable jobs, metadata arrival, timeout
and stale projection rejection. `src/ts/server/generationOperations.test.ts` also
covers promoted-writer Stop when bootstrap supplies operation authority without a
local cancellation record, preserving the exact chat target and cancellation
request without submitting another generation.

`src/ts/process/generationEffectLedger.svelte-node.test.ts` and
`src/ts/process/recoveredGenerationEffects.svelte-node.test.ts` keep claims, callbacks, lease
renewals and receipts restricted to the current writer generation. The IGP client
tests under `src/ts/process/__tests__/igp.test.ts` and server
`server/fastify/__tests__/generationIgpCommit.test.ts` pair stable-message append
preconditions with atomic append/effect receipt, stale-claim rejection, transaction
rollback and command replay protection.

`server/fastify/browser-smoke/connectedReaderGeneration.spec.ts` supplies five real
browser compositions: visible partial-to-persisted convergence; chat switching and
close/reopen without cancelling the provider job; writer transfer during streaming
and Stop; transfer while a finalization journal is queued; and an accepted IGP
append whose PATCH response is held across writer loss. The last case requires one
provider effect, one append and unchanged completed receipt state through transfer
and refresh. Reader request audits, viewer counts, persisted messages and durable
effect rows are separate oracles. Providers, response holds and journal failures
are deterministic fixtures; physical-device behavior and live external providers
remain outside this evidence.

## Especially critical tests

- The local and server-backed `sendChat.fixtures*` suites are the broadest protection against prompt-content drift.
- Server `durableGeneration.test.ts` and the durable/finalization/cancel groups in `generation.chat.test.ts` protect against lost or duplicated assistant messages after disconnects and restarts.
- Client `serverChat.test.ts` plus server terminal-frame assertions protect the SSE vocabulary on both sides of the API.
- The reroll Playwright journey is the only test proving alternate candidates survive a real page reload and remain visible/swipeable.
- Large-corpus and clone-count gates protect users with large character/chat collections even though the assertions are implementation-aware.

## Primary inventory

The following files are the primary test inventory for this area. Cross-cutting
files are discussed in the linked feature documents rather than listed twice.

| Location | Included test files / parameterized groups |
| --- | --- |
| `src/ts/process/__tests__/` | `buildDescription`, `buildHistoryWindow`, `buildLorebookContext`, `buildPlainPromptSections`, `buildStaticPromptSections`, `charEmotionStore`, `dispatchRequest`, `emotionFallbackEmbedding`, `emotionFallbackLlm`, `emotionFromResponse`, `finalizeRequestBudget`, `formatHistoryMessage`, `igp`, `imggenStableDiff`, `nonStreamResponse`, `normalizeTemplate`, `notification`, `orchestrateResponse`, `outputTrigger`, `preflightTemplateTokens`, `reattach`, `renderFinalPrompt`, `runStage4`, `sendChat.fixtures`, `sendChat.fixtures.serverBacked`, `sendChat.serverPreview`, `sendChatContext`, `sendChatErrors`, `sendChatPromptAssembly.lazyPromptTemplate`, `stage4Finalize`, `streamCoalescer`, `streamResponse`. |
| `src/ts/process/` | `agentPresetProgress.test.ts`; `generationEffectLedger.svelte-node.test.ts`; `generationPersistenceState.test.ts`; `recoveredGenerationEffects.svelte-node.test.ts`; `inlayFinalization.test.ts`; `inputHooks.test.ts`; `messageCompletionSound.test.ts`; `prereroll.test.ts`; `promptTokenizeMemo.test.ts`; `rerollNavigation.test.ts`; `rerollNavigation.owner.test.ts`; `rerollNavigation.rollback.test.ts`; `sendChatCompletion.test.ts`; `serverBackedSendChat.findMessage.test.ts`. |
| Reader generation / operations | `src/ts/server/readerGenerationObservation.test.ts`; `readerGenerationStream.test.ts`; `generationOperations.test.ts`. Mounted transcript and row presentation tests are indexed in [App Navigation and Chat](app-navigation-and-chat.md). |
| Browser tokenizer | `src/ts/tokenizer.test.ts` (Google Cloud bounded-cache cases). |
| Prompt conversion | `src/ts/process/prompt.conversionDurability.test.ts` (expanded input/outcome cases). |
| Agent Preset browser records | `src/ts/agentPresetRecords.test.ts`, `agentPresetResolver.test.ts`, `agentPresetDiagnostics.test.ts`, and `agentPresets.test.ts`. Model/profile record ownership is cross-indexed in [Providers, Models, and Media](providers-models-and-media.md). |
| `src/ts/process/request/tests/` | `durableGeneration`, `providerCapability`, `serverChat`, `serverCompletion`, `serverMessagePatch`, `serverPromptAssembly`, `sseParse`. Provider-specific request tests are inventoried in [Providers, Models, and Media](providers-models-and-media.md). |
| Server prompt/generation | `agentPresetExecution`, `assemble`, `boundedRegex`, `budgetFinalize`, `durableGeneration`, display-source and generation-input families above, `generation.chat`, `generationBodyCap`, `generationEffects`, `generationIgpCommit`, `generationOperations`, `generationOperationsStartup`, `generationTraceSidecar`, `history`, `jsonControls`, `lorebook`, `plainSections`, `preflight`, `promptVariables`, `staticSections`, `stripCoTFrames`, `templates`, `terminalFrameAssertions`, and `tokens` under `server/fastify/__tests__/`. Scripts, triggers, Lua, memory, and provider files are owned by their focused documents. |
| Browser and explicit gates | `server/fastify/browser-smoke/acceptedSendProtocol.spec.ts`; `server/fastify/browser-smoke/connectedReaderGeneration.spec.ts`; `server/fastify/browser-smoke/debugEchoLayoutStability.spec.ts`; `server/fastify/browser-smoke/rerollSwipePersistence.spec.ts`; generation-relevant portions of `fastifyBrowserSmoke.spec.ts`; `src/ts/__tests__/renderCostHarness.test.ts`; `src/ts/__tests__/sendCloneCountProbe.test.ts`. |
