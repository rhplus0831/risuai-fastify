# Generation Rejection Register

Source-checked: 2026-09-25.

This is the lookup for a generation refused or stopped before the main provider
returns tokens. The [JSON register](generation-rejection-register.json) is canonical;
its [schema](generation-rejection-register.schema.json) fixes the row contract.
The table below is generated from that JSON. Source anchors use exported symbols
or unique substrings, never line numbers.

Look up the HTTP `error`, SSE `reason`/`code`, operation `failureCode`, nested
`missing[].code`, or a distinctive part of the error message. Read the matching
row's `condition`, `anchors`, `preFastify.note`, and `notes` in the JSON before
changing a guard. A successful HTTP acceptance does not mean the provider ran.
`post-dispatch` and `out-of-scope` rows prevent confusing observation, background,
and persistence failures with admission refusals.

Two incidents motivated this register. `090b6de11` repaired original-editor
empty-string values and widened types that the old browser could consume.
`8347977ec` made unrecoverable legacy-origin generations terminal instead of
leaving an unretryable operation pin. Their mechanisms are still distinct:
input canonicalization happens before validation; lifecycle settlement decides
whether the next request encounters `chat_occupancy_recovery_blocked`.

## Layers And Transports

| Layer | Boundary |
| --- | --- |
| `envelope` | Request headers/body, protocol version, ids and message/options validators. |
| `admission` | Authentication, general writer, exact chat occupancy, recovery pins and rate limits. |
| `preflight` | Selected persisted configuration decoding and chat-scoped readiness. |
| `acceptance` | Atomic intent/message acceptance, idempotency, revisions, retry/attempt fences and snapshot limits. |
| `profile-capability` | Durable profile status, provider routing and tokenizer support. |
| `assembly` | Target selection, input/start scripts, Agent Presets, history, memory and final prompt budget. |
| `dispatch` | Live credential authority, provider request construction, tools and configured schemas. |
| `post-dispatch` | Output filtering, interrupted provider work, finalization and completion effects. |
| `out-of-scope` | Nonblocking union members, observation/control, background recovery and unrelated whole-tree throws. |

`transport` is an array because one value can cross more than one boundary.
`http:N` is a rejection while the route still owns an unsent response;
`sse-error` is a terminal stream error after the stream opened;
`operation-state` is stored failure/control state (or an internal background
failure without a chat response); `stream-reason` is an assembly stop reason.
Prompt preview can return that stop reason in successful JSON instead of SSE.
The same guard after protocol-v1 acceptance cannot retroactively turn its
201/200 into a 4xx. Completion has a separate lower-level HTTP boundary.

`provider_dispatch_exception`, `provider_failed`, aborts, and several target
fences span phases. Use token receipt, `failurePhase` and `providerMayHaveRun`
together; the code alone cannot prove that no provider work happened. The
register's primary layer does not claim that every occurrence is in that layer.
The [backend lifecycle](backend.md#generation-and-background-work) explains
legacy terminal settlement versus protocol-v1 retryable recovery. In
`listGenerationOccupancyPins`, nonterminal operations, uncommitted finalizations,
pending/claimed IGP or generated-translation effects, and pending/running memory
or BardWiki jobs can block later admission. Runtime/injected occupancy pins have
additional callers; the register anchors the shared admission error and pin query.

## Historical Evidence And Decisions

Every `preFastify.anchor` is pinned to
`71c476e9c86263fe907105b011ca4dde0a619d66` using
`71c476e9c:<path>#<symbol>`. The paths and symbols were read with `git show` when
authoring this register. The standing check never needs that commit, so shallow
CI clones work. Current browser code is not historical proof: the pinned commit
predates durable model profiles and chat-scoped generation readiness. It selected
flat settings in `sendChat` and `requestChatDataMain`.

| Historical behavior | Meaning |
| --- | --- |
| `tolerated` | Browser code proceeds for the described condition; an upstream provider may still fail. |
| `rejected` | The browser already stopped for the comparable condition; exact messages/budgets may differ. |
| `fallback` | A verified browser branch substitutes another supported value or path. |
| `not-applicable` | The server authority/data model or feature did not exist at the pinned boundary. |
| `unknown` | Evidence does not establish one outcome for this predicate/family; the note states the gap. |

`classification` distinguishes `protective` authority/integrity/size fences,
`strictness` shape/configuration requirements, and `policy` feature or lifecycle
choices. It describes the reason for the current guard, not an endorsement.

| Decision | Meaning and evidence requirement |
| --- | --- |
| `keep` | Protective guard; the inventory rejects this status on another classification. |
| `coerce` | Already-decided value repair, currently limited to the exact-empty-string table from `090b6de11`. |
| `widen` | Already-decided accepted shapes from `090b6de11`: sparse Ooba formatting, nullable inner format, optional cache depth, lore mode and activation percentage. |
| `warn` | A recorded decision to continue with a warning; none is asserted by this initial register. |
| `needs-decision` | No applicable approved family-wide decision; not an ordered worklist or an instruction to change behavior. |

The five decoder-domain rows intentionally remain `needs-decision`: each includes
many still-strict fields. Their notes link the finite canonicalizer and widened
source types as the existing per-field `coerce`/`widen` decisions. There is no
field-by-field duplicate of the generated schema, and no claim that the whole
schema was approved for coercion. Six entry points share five domains because
generation and display-source decoding both use `database`.

## Surfacing

The direct browser bridge in
[`serverChat.ts`](../../src/ts/process/request/serverChat.ts) retains structured
HTTP codes only for `hypa_context_truncation_confirmation_required`,
`generation_in_progress`, `generation_job_not_found`, and
`stale_generation_attempt`. Only the Hypa code is retained structurally from
stream errors. Other errors normally become the server message/reason/error
text; an ordinary code does not automatically select a localized string.

[`en.ts`](../../src/lang/en.ts) has dedicated incomplete-settings and Hypa
confirmation text. Accepted-send recovery has dedicated generation-in-progress
text, and durable operation submission maps `generation_finalization_pending`
to `errors.replyStillSaving`. Those mappings are contextual: server-returned
incomplete-settings errors still use the supplied message. Job-not-found and
stale-attempt codes drive reconciliation rather than dedicated error prose.
Nested settings reasons are `structural-only`; nonblocking profile reasons and
skipped effects can be `silent`.

Most guards therefore appear as a raw alert, composer error, or `risuerror` inlay.
A terminal failure with no assistant row can look like a disappearing reply
when the alert is dismissed. The `surfaced` field records the strongest relevant
mapping, with exceptions in notes; it is not a promise that every transport
uses the same UI. See the [generation client](../../src/docs/generation-client.md)
for outbox, retry and reattachment behavior.

## Mechanical Scope And Maintenance

[`util/architecture-inventory.ts`](../../util/architecture-inventory.ts) owns
`GENERATION_REJECTION_SCOPE`, `collectGenerationRejections`, and
`validateGenerationRejectionRegister`. `pnpm check:server` invokes this probe
through the existing server checker. The scope is explicit:

| Probe | Closed source scope |
| --- | --- |
| Production AST roots | Every `.ts` under `server/fastify/src` and `packages/shared-core/src`, excluding `.test.ts`, `.spec.ts`, `.d.ts`. |
| Code constructor arguments | `GenerationAdmissionError` argument 1; `OperationHttpError` argument 1 (zero based), at every call site in those roots. Aliases resolve through the TypeScript checker. Unresolvable code arguments fail. |
| Class code/error fields and bodies | `GenerationAdmissionError`, `OperationHttpError`, `GenerationEffectiveConfigurationTooLargeError`, `ChatGenerationSettingsIncompleteAssemblyError`, `AgentPresetGenerationError`, `BardWikiPinnedBudgetError`, `BoundedRegexError`, `RisuParserBudgetError`. |
| Named unions | `AssembleAbortReason`, `ChatGenerationSettingsMissingReason` (object members' `code`), `ModelProfileStatusReason`, `ProviderUnsupportedReason`. Non-error members still require rows. |
| Constants | `CHAT_GENERATION_SETTINGS_INCOMPLETE_ERROR`, `HYPA_CONTEXT_TRUNCATION_CONFIRMATION_REQUIRED`, resolved by TypeScript literal types, including imported/re-exported bindings. |
| Route payloads | `server/fastify/src/routes/generation.ts`, `generationChat.ts`, `generationOperations.ts`, `generationEffects.ts`: object/class properties named `error`, `code`, `reason`, `failureCode`, including HTTP `.send`, SSE and helper return objects. |
| Durable state | `failureCode` object fields in `server/fastify/src/generationOperations.ts`. |
| Whole-tree throws | Direct `throw new Error(...)` with a resolved snake-case/lowercase code or uppercase underscore code. Backup/maintenance observations receive explicit out-of-scope rows. |
| Prose and validators | Each registered message substring must remain at an anchored path; each validator function/configuration name must remain there. These are one-way probes, not arbitrary exception/call-graph discovery. |

Conditional and nullish/OR code expressions retain their literal fallback arms,
including `generation_settings_not_ready`. A two-way match is by **source path
and value**, so moving an existing code into a new file also needs an anchor.
There is no ignored-code list. Missing scoped declarations/routes/constants,
unregistered observations, deleted codes, stale exported symbols, nonunique
substring anchors, missing cited tests, duplicate ids, invalid schema fields,
and guide-table drift fail with a row or source path and value.

This is a closed-world check of these syntactic boundaries, not proof that every
possible JavaScript exception or upstream/network failure has a stable code.
Framework errors are represented by the configured request-boundary family;
provider/network catch-alls remain phase-dependent. Adding a new error class,
union or route family requires extending the literal scope here and in the
probe. Prose-message changes require review of the family even when the retained
substring still matches. No standing check claims to prove historical behavior,
classification intent, or test adequacy from text.

To add or change a guard:

1. Run `pnpm exec tsx util/architecture-inventory.ts --print-generation-rejections`
   for the mechanically collected source/value pairs; locate the actual emitting
   predicate and its transport before choosing a layer.
2. Add a stable kebab-case JSON id. Use `code` for emitted values,
   `union-member` for named reason members, `validator-group` for one envelope
   validator function, and `message-family` for raw prose. Cover every observed
   source path for the value with an exported symbol or unique substring anchor.
   Add an explicit post-dispatch/out-of-scope row if that is what the source does.
3. Read the pinned historical file with `git show 71c476e9c:<path>`, verify the
   symbol and predicate, and record the evidence note. Use `unknown` when the
   comparison is unresolved. Current mirror pointers belong in notes.
4. Record classification and decision without inventing a new repair policy.
   Existing test paths are evidence only where their scenario was inspected;
   empty `tests` means no specific test is claimed, not that no test exists.
   This register is not a test inventory and extended tests are not core protection.
5. Run `pnpm exec tsx util/architecture-inventory.ts --write-generation-rejection-table`
   to refresh the projection, then `pnpm check:server`, `pnpm check:docs`, and
   Prettier on the touched TypeScript/JSON. The checker enforces the schema,
   two-way observation match and source/table anchors described above.

## Lookup Table

The table is a projection, not a second source of truth. Search either id or
value; decoder values retain the source template `${domain}` and their ids name
the actual domain. Full current/historical anchors, classification, surfacing,
test evidence and caveats remain in the JSON.

<!-- generation-rejection-table:start -->
| ID | Value / family | Layer | Transport | Condition | Pre-Fastify | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| fastify-request-boundary | bodyLimit: config.bodyLimit | envelope | http:400, http:408, http:413, http:415 | Fastify rejects an oversized or malformed request body, unsupported media type, or expired request-receive deadline before route handling. | not-applicable | needs-decision |
| validate-canonicaluuid | canonicalUuid | envelope | http:400 | An envelope identity is not a lowercase UUID v4. | not-applicable | needs-decision |
| validate-coerceanthropicadditionalparams | coerceAnthropicAdditionalParams | envelope | http:400 | Anthropic completion additional parameters are not string-pair rows. | not-applicable | needs-decision |
| validate-coercecohereadditionalparams | coerceCohereAdditionalParams | envelope | http:400 | Cohere completion additional parameters are not string-pair rows. | not-applicable | needs-decision |
| validate-coercelegacyinstructadditionalparams | coerceLegacyInstructAdditionalParams | envelope | http:400 | Legacy-instruct completion additional parameters are not string-pair rows. | not-applicable | needs-decision |
| validate-coercemistraladditionalparams | coerceMistralAdditionalParams | envelope | http:400 | Mistral completion additional parameters are not string-pair rows. | not-applicable | needs-decision |
| validate-coerceresponsesadditionalparams | coerceResponsesAdditionalParams | envelope | http:400 | Responses completion additional parameters are not string-pair rows. | not-applicable | needs-decision |
| validate-coercevertexauth | coerceVertexAuth | envelope | http:400 | A completion Vertex credential object omits or mistypes required service-account fields. | not-applicable | needs-decision |
| validate-createmessagerecord | createMessageRecord | envelope | http:400 | The accepted submit message violates the normalized text-message record contract. | not-applicable | needs-decision |
| validate-handleserverintentcompletion | handleServerIntentCompletion | envelope | http:400 | A server-intent completion supplies provider/model/options, invalid scalar/message fields, malformed tools/rounds, unbuffered tools, or no initialized database. | not-applicable | needs-decision |
| validate-normalizechatoccupancy | normalizeChatOccupancy | envelope | http:400 | Occupancy version or interaction is outside the protocol envelope. | not-applicable | needs-decision |
| validate-normalizegenerationoptions | normalizeGenerationOptions | envelope | http:400 | The generation options object has invalid synthetic-send, reset, loadout, inlay, or capability field shapes. | not-applicable | needs-decision |
| validate-parsesubmitrequest | parseSubmitRequest | envelope | http:400 | The protocol-v1 body violates version/revision/mode/identity/draft, occupancy-mode, message-role/id, sentinel, or target rules. | not-applicable | needs-decision |
| validate-readoptionaloccupancyepoch | readOptionalOccupancyEpoch | envelope | http:400 | The optional occupancy epoch header is not a non-negative safe integer. | not-applicable | needs-decision |
| validate-readrequesteddatabaselineage | readRequestedDatabaseLineage | envelope | http:400 | The database-lineage request header is absent or unusable. | not-applicable | needs-decision |
| validate-readrequiredwritersessionid | readRequiredWriterSessionId | envelope | http:400 | The request lacks a writer-session header. | not-applicable | needs-decision |
| validate-registergenerationoperationroutes | registerGenerationOperationRoutes | envelope | http:400 | An inline retry/control envelope lacks valid ids, body, positive expectedStateVersion, or user_stop reason. | not-applicable | needs-decision |
| validate-registergenerationroutes | registerGenerationRoutes | envelope | http:400, http:501 | A legacy completion lacks provider/model/messages/stream or requests an unsupported provider or streaming adapter. | not-applicable | needs-decision |
| validate-requiredstring | requiredString | envelope | http:400 | A required envelope string is absent, non-string, or blank. | not-applicable | needs-decision |
| validate-validate | validate | envelope | http:400 | The legacy chat body violates required ids, mode/send/sentinel/regenerate rules, forbidden presetId, or optional field types. | not-applicable | needs-decision |
| validate-validatemessages | validateMessages | envelope | http:400 | Completion messages are not an array of supported role/content records. | not-applicable | needs-decision |
| validate-validatepreview | validatePreview | envelope | http:400 | The preview shortcut lacks scope ids or violates its shared optional-field types. | not-applicable | needs-decision |
| active-writer-stale | active_writer_stale | admission | http:423, sse-error, operation-state | The request or accepted compatibility write belongs to a different general writer. | not-applicable | keep |
| auth-required | Auth required | admission | http:401 | The API lacks a configured password/assertion or the supplied assertion fails verification. | not-applicable | keep |
| chat-occupancy-normalization-required | chat_occupancy_normalization_required | admission | http:409 | A demoted owner has not normalized its claims to exactly one chat-only occupancy. | not-applicable | keep |
| chat-occupancy-protocol-required | chat_occupancy_protocol_required | admission | http:426 | An active self-occupancy requires negotiation, or the requested occupancy protocol is unsupported or disabled. | not-applicable | keep |
| chat-occupancy-recovery-blocked | chat_occupancy_recovery_blocked | admission | http:409 | An operation, uncommitted finalization, transcript-mutating effect, memory job, or BardWiki job still pins the chat. | not-applicable | keep |
| chat-occupancy-stale | chat_occupancy_stale | admission | http:409, sse-error, operation-state | The supplied or accepted lineage/session/chat/epoch tuple is missing, expired, or no longer exact. | not-applicable | keep |
| chat-occupied | chat_occupied | admission | http:423, sse-error, operation-state | A live foreign occupancy owns the chat when compatibility generation or an effect tries to proceed. | not-applicable | keep |
| chat-only-interaction-unsupported | chat_only_interaction_unsupported | admission | http:409 | A chat-only claim requests Continue or general Regenerate rather than Send or latest-response Reroll. | not-applicable | needs-decision |
| database-lineage-conflict | database_lineage_conflict | admission | http:409, sse-error, operation-state | The requested or accepted database lineage differs from current authority. | not-applicable | keep |
| generation-rate-limit | generationSubmitRateLimit | admission | http:429 | Submissions exceed the configured 60 requests per minute generation rate limit. | not-applicable | needs-decision |
| generation-scope-invalid | generation_scope_invalid | admission | http:409, sse-error, operation-state | The stored or supplied generation scope lacks its required identity or permission fields. | not-applicable | keep |
| agent-preset-missing | agent_preset_missing | preflight | http:409 | A nonempty selected Agent Preset id is absent from the supplied Agent Presets. | not-applicable | needs-decision |
| chat-generation-settings-incomplete | chat_generation_settings_incomplete | preflight | http:409 | At least one chat generation settings readiness requirement is missing or invalid. | not-applicable | needs-decision |
| decoder-preflight | Invalid ${domain} generation input at | preflight | http:400, sse-error, operation-state | After finite compatibility repairs, a known field in the preflight decoder domain violates the generated input schema. | unknown | needs-decision |
| decoder-settings | Invalid ${domain} generation input at | preflight | http:400, sse-error, operation-state | After finite compatibility repairs, a known field in the settings decoder domain violates the generated input schema. | unknown | needs-decision |
| jailbreak-toggle-invalid | jailbreak_toggle_invalid | preflight | http:409 | The supplied jailbreak toggle is not boolean. | not-applicable | needs-decision |
| jailbreak-toggle-missing | jailbreak_toggle_missing | preflight | http:409 | The generation settings omit an explicit jailbreak toggle. | not-applicable | needs-decision |
| model-preset-id-missing | model_preset_id_missing | preflight | http:409 | No nonempty chat-scoped model preset id is selected. | not-applicable | needs-decision |
| model-preset-missing | model_preset_missing | preflight | http:409 | The selected model preset is absent from the supplied owner records. | not-applicable | needs-decision |
| persona-id-missing | persona_id_missing | preflight | http:409 | No nonempty chat-scoped persona id is selected. | not-applicable | needs-decision |
| persona-missing | persona_missing | preflight | http:409 | The selected persona id has no matching persona record. | not-applicable | needs-decision |
| prompt-preset-id-missing | prompt_preset_id_missing | preflight | http:409 | No nonempty chat-scoped prompt preset id is selected. | not-applicable | needs-decision |
| prompt-preset-missing | prompt_preset_missing | preflight | http:409 | The selected prompt preset is absent from the supplied owner records. | not-applicable | needs-decision |
| settings-missing | settings_missing | preflight | http:409 | The chat has no generationSettings object. | not-applicable | needs-decision |
| settings-not-configured | settings_not_configured | preflight | http:409 | The chat generation settings are not explicitly configured. | not-applicable | needs-decision |
| sidebar-toggle-invalid | sidebar_toggle_invalid | preflight | http:409 | A currently required sidebar toggle has a non-string value. | not-applicable | needs-decision |
| sidebar-toggle-missing | sidebar_toggle_missing | preflight | http:409 | A currently required sidebar toggle has no chat-scoped value. | not-applicable | needs-decision |
| sidebar-toggles-missing | sidebar_toggles_missing | preflight | http:409 | Required sidebar toggles exist but the chat has no toggle object. | not-applicable | needs-decision |
| accepted-configuration-fingerprint | Accepted effective generation configuration fingerprint mismatch | acceptance | http:409, sse-error, operation-state | The stored accepted configuration fingerprint no longer matches its serialized value. | not-applicable | keep |
| attempt-configuration-fingerprint | Accepted attempt effective generation configuration fingerprint mismatch | acceptance | http:409, sse-error, operation-state | The attempt configuration fingerprint differs from the operation configuration. | not-applicable | keep |
| attempt-lineage-stale | generation attempt lineage is stale | acceptance | http:409, sse-error, operation-state | The current attempt id/job/number no longer matches the dispatch caller. | not-applicable | keep |
| attempt-marker-stale | generation attempt dispatch marker is stale | acceptance | http:409, sse-error, operation-state | The atomic attempt dispatch marker cannot be written under the expected guard. | not-applicable | keep |
| attempt-not-dispatchable | generation operation is not dispatchable | acceptance | http:409, sse-error, operation-state | The operation is not owned_by_job, cancellation is requested, or the current attempt is no longer running. | not-applicable | keep |
| generation-effective-configuration-too-large | generation_effective_configuration_too_large | acceptance | http:413 | The accepted effective-configuration manifest exceeds the 8 MiB limit. | not-applicable | keep |
| generation-finalization-pending | generation_finalization_pending | acceptance | http:409 | An uncommitted, replayable finalization journal still owns this chat tail. | not-applicable | keep |
| generation-in-progress | generation_in_progress | acceptance | http:409 | A live operation claim or process-local generation job already owns this chat. | not-applicable | keep |
| generation-job-start-failed | generation_job_start_failed | acceptance | http:500 | Legacy durable job startup throws an error not mapped to admission, conflict, or configuration size. | not-applicable | needs-decision |
| generation-operation-foreign-session | generation_operation_foreign_session | acceptance | http:423 | Operation control, receipt access, retry, or observation is attempted by a session other than its admitted owner. | not-applicable | keep |
| generation-operation-not-found | generation_operation_not_found | acceptance | http:404 | A retry or operation/status lookup cannot find the requested operation. | not-applicable | needs-decision |
| generation-settings-not-ready | generation_settings_not_ready | acceptance | http:400, http:409 | Preflight rejected acceptance or retry without supplying a string error code. | not-applicable | needs-decision |
| message-id-conflict | message_id_conflict | acceptance | http:409 | The accepted user-message id already exists in authoritative history. | not-applicable | keep |
| operation-character-mismatch | chat does not belong to character | acceptance | http:404 | The submit chat is owned by a different character. | not-applicable | keep |
| operation-effective-configuration-invalid | operation_effective_configuration_invalid | acceptance | http:409 | The stored accepted configuration cannot be decoded as the required effective snapshot. | not-applicable | needs-decision |
| operation-id-conflict | operation_id_conflict | acceptance | http:409 | An operation id or cancellation binding is reused for different intent or target data. | not-applicable | keep |
| operation-intent-missing | operation_intent_missing | acceptance | http:409 | An explicit retry has no stored intent to replay. | not-applicable | needs-decision |
| operation-not-retryable | operation_not_retryable | acceptance | http:409 | An explicit retry targets a legacy-origin operation or a state other than retryable/abandoned. | not-applicable | needs-decision |
| operation-state-conflict | operation_state_conflict | acceptance | http:409 | The expected operation state/version or cancellation binding changed before acceptance or retry. | not-applicable | keep |
| operation-target-stale | operation_target_stale | acceptance | http:409, sse-error, operation-state | The exact source or regenerate target is no longer the authoritative chat tail. | not-applicable | keep |
| retry-request-id-conflict | retry_request_id_conflict | acceptance | http:409 | The retry request id is already bound to another operation. | not-applicable | keep |
| revision-conflict | revision_conflict | acceptance | http:409 | The submit or effect base revision differs from the current database revision. | not-applicable | keep |
| startup-failed | startup_failed | acceptance | operation-state | An accepted operation cannot bind or launch its process-local runner. | not-applicable | needs-decision |
| api-key-missing | api-key-missing | profile-capability | http:400, sse-error, operation-state | The resolved first-class provider requires an API key and none is usable. | not-applicable | needs-decision |
| base-url-missing | base-url-missing | profile-capability | http:400, sse-error, operation-state | The resolved custom API or local Ollama profile has no usable base URL. | not-applicable | needs-decision |
| config-incomplete | config-incomplete | profile-capability | http:400, sse-error, operation-state | Provider-specific endpoint, key, custom-model format, Vertex, Bedrock, Horde, or Ollama requirements are incomplete. | unknown | needs-decision |
| credential-missing | credential-missing | profile-capability | http:400, sse-error, operation-state | A profile credential id has no corresponding credential record. | not-applicable | needs-decision |
| format-not-server-routable | format-not-server-routable | profile-capability | http:400, sse-error, operation-state | The resolved format has no server provider adapter. | rejected | needs-decision |
| model-profile-readiness | and cannot be used for generation | profile-capability | http:400, sse-error, operation-state | The selected durable model profile has incomplete or unsupported status. | not-applicable | needs-decision |
| novelai | novelai | profile-capability | http:400, sse-error, operation-state | The novelai format is designated for local/browser dispatch and has no server chat route. | tolerated | needs-decision |
| novellist | novellist | profile-capability | http:400, sse-error, operation-state | The novellist format is designated for local/browser dispatch and has no server chat route. | tolerated | needs-decision |
| ooba | ooba | profile-capability | http:400, sse-error, operation-state | The ooba format is designated for local/browser dispatch and has no server chat route. | tolerated | needs-decision |
| plugin | plugin | profile-capability | http:400, sse-error, operation-state | The plugin format is designated for local/browser dispatch and has no server chat route. | tolerated | needs-decision |
| profile-model-missing | profile-model-missing | profile-capability | http:400, sse-error, operation-state | A selected durable profile has no usable model id. | not-applicable | needs-decision |
| profile-not-found | profile-not-found | profile-capability | http:400, sse-error, operation-state | A selected durable profile reference cannot be found. | not-applicable | needs-decision |
| provider-capability-incomplete | provider-capability-incomplete | profile-capability | http:400, sse-error, operation-state | The provider capability verdict is config-incomplete for an otherwise resolved profile. | not-applicable | needs-decision |
| provider-capability-unsupported | provider-capability-unsupported | profile-capability | http:400, sse-error, operation-state | The provider capability verdict has no supported server route. | not-applicable | needs-decision |
| request-model-missing | request-model-missing | profile-capability | http:400, sse-error, operation-state | The first-class provider requires a request-model name and none is present. | not-applicable | needs-decision |
| tokenizer-google | Google Cloud tokenization is not supported by Fastify prompt budgeting. | profile-capability | http:400, sse-error, operation-state | Google Cloud tokenization is enabled for a Google tokenizer/model. | tolerated | needs-decision |
| tokenizer-plugin | is not supported for plugin models by Fastify prompt budgeting. | profile-capability | http:400, sse-error, operation-state | A plugin model selects a tokenizer outside the allowed automatic/tiktoken choices. | tolerated | needs-decision |
| tokenizer-unsupported | is not supported by Fastify prompt budgeting. | profile-capability | http:400, sse-error, operation-state | An explicit tokenizer requires unavailable local, network, plugin, or unknown tokenizer support. | tolerated | needs-decision |
| unsupported-chat-provider | unsupported /chat provider: | profile-capability | sse-error, operation-state | The resolved model id, provider format, or configuration cannot be routed to a server adapter. | unknown | needs-decision |
| unsupported-model | unsupported-model | profile-capability | http:400, sse-error, operation-state | Resolved model metadata carries an unsupported reason. | not-applicable | needs-decision |
| unsupported-provider-id | unsupported-provider-id | profile-capability | http:400, sse-error, operation-state | The durable profile explicitly names a provider outside the supported first-class ids. | not-applicable | needs-decision |
| vertex-client-email-missing | vertex-client-email-missing | profile-capability | http:400, sse-error, operation-state | The resolved Vertex service-account configuration omits its client email. | not-applicable | needs-decision |
| vertex-private-key-missing | vertex-private-key-missing | profile-capability | http:400, sse-error, operation-state | The resolved Vertex service-account configuration omits its private key. | not-applicable | needs-decision |
| vertex-project-id-missing | vertex-project-id-missing | profile-capability | http:400, sse-error, operation-state | The resolved Vertex configuration omits its project id. | not-applicable | needs-decision |
| vertex-region-missing | vertex-region-missing | profile-capability | http:400, sse-error, operation-state | The resolved Vertex configuration omits its region. | not-applicable | needs-decision |
| webllm | webllm | profile-capability | http:400, sse-error, operation-state | The webllm format is designated for local/browser dispatch and has no server chat route. | tolerated | needs-decision |
| agent-preset-generation-failed | agent_preset_generation_failed | assembly | http:422, sse-error, operation-state | An Agent Preset is missing, invalid, incomplete, unready, or a required step/output fails. | not-applicable | needs-decision |
| bardwiki-pinned-budget-exceeded | bardwiki_pinned_budget_exceeded | assembly | sse-error, operation-state, stream-reason | Pinned BardWiki references exceed their effective prompt budget. | not-applicable | needs-decision |
| cancel-during-assembly | signal.aborted && signal.reason === 'user_stop' && !providerMayHaveRun | assembly | operation-state | User Stop interrupts prompt assembly before any main-provider dispatch. | unknown | needs-decision |
| character-missing | character not found: | assembly | http:404, sse-error, operation-state | The requested character cannot be found for assembly. | unknown | needs-decision |
| chat-missing | chat not found: | assembly | http:404, sse-error, operation-state | The requested chat cannot be found for assembly. | unknown | needs-decision |
| database-missing | database not found | assembly | http:404, sse-error, operation-state | No database can be loaded for assembly. | unknown | needs-decision |
| decoder-database | Invalid ${domain} generation input at | assembly | http:400, sse-error, operation-state | After finite compatibility repairs, a known field in the database decoder domain violates the generated input schema. | unknown | needs-decision |
| decoder-memory | Invalid ${domain} generation input at | assembly | http:400, sse-error, operation-state | After finite compatibility repairs, a known field in the memory decoder domain violates the generated input schema. | unknown | needs-decision |
| decoder-provider | Invalid ${domain} generation input at | assembly | http:400, sse-error, operation-state | After finite compatibility repairs, a known field in the provider decoder domain violates the generated input schema. | unknown | needs-decision |
| durable-deadline | t >= job.deadlineAt \|\| t >= job.absoluteDeadlineAt | assembly | operation-state | A durable job reaches its inactivity deadline or absolute lifetime before completion. | unknown | needs-decision |
| generation-configuration-asset-index-invalid | generation_configuration_asset_index_invalid | assembly | sse-error, operation-state | The hydrated retained-asset index is not an array of valid asset hashes. | not-applicable | keep |
| generation-configuration-dependency-corrupt | generation_configuration_dependency_corrupt | assembly | sse-error, operation-state | A stored dependency kind or content hash differs from its accepted reference. | not-applicable | keep |
| generation-configuration-dependency-cycle | generation_configuration_dependency_cycle | assembly | sse-error, operation-state | Hydration revisits an active dependency digest and detects a cycle. | not-applicable | keep |
| generation-configuration-dependency-invalid | generation_configuration_dependency_invalid | assembly | sse-error, operation-state | A tagged object or dependency descriptor has invalid keys, digest, kind, or entry pairs. | not-applicable | keep |
| generation-configuration-dependency-missing | generation_configuration_dependency_missing | assembly | sse-error, operation-state | An accepted configuration references a dependency row that no longer exists. | not-applicable | keep |
| generation-configuration-invalid | generation_configuration_invalid | assembly | sse-error, operation-state | The accepted configuration is not an object or its hydrated version/database shape is invalid. | not-applicable | keep |
| generation-configuration-version-unsupported | generation_configuration_version_unsupported | assembly | sse-error, operation-state | The stored manifest is neither a supported legacy snapshot nor version 2 semantic contract 1. | not-applicable | keep |
| generation-operation-lineage-missing | generation_operation_lineage_missing | assembly | sse-error, operation-state | An assembly write with scoped authority lacks an operation id or attempt number. | not-applicable | keep |
| generation-operation-lineage-stale | generation_operation_lineage_stale | assembly | sse-error, operation-state | The operation, chat, attempt, or persisted scope no longer matches the assembly write. | not-applicable | keep |
| history-context-overflow | history_context_overflow | assembly | sse-error, operation-state, stream-reason | History still cannot fit the effective context budget after allowed trimming. | rejected | needs-decision |
| hypa-context-truncation-confirmation-required | hypa_context_truncation_confirmation_required | assembly | http:409, sse-error, operation-state | History was trimmed without enabled Hypa Memory and the chat lacks truncation acknowledgement. | tolerated | needs-decision |
| lua-interactive | requires browser interaction and is not supported by server prompt assembly | assembly | sse-error, operation-state | A permitted Lua script invokes interactive input/select/confirm during server assembly. | tolerated | needs-decision |
| overflow | overflow | assembly | sse-error, operation-state, stream-reason | The final prompt exceeds context after removable history is exhausted. | rejected | needs-decision |
| regenerate-missing | regenerate message not found | assembly | http:404, sse-error, operation-state | The requested regenerate target is missing. | unknown | needs-decision |
| regenerate-not-assistant | regenerate target must be an assistant message: | assembly | http:404, sse-error, operation-state | The requested regenerate target is not an assistant message. | unknown | needs-decision |
| regenerate-not-latest | regenerate target must be the latest assistant message: | assembly | http:404, sse-error, operation-state | The requested regenerate target is not the latest assistant message. | unknown | needs-decision |
| request-abort | attachAbort | assembly | operation-state | A non-durable request disconnects or exceeds its sliding request deadline before provider work finishes. | unknown | needs-decision |
| risu-bounded-regex | RISU_BOUNDED_REGEX | assembly | sse-error, operation-state | A regex pattern, input, output expansion, or execution exceeds bounded-regex safety limits. | unknown | keep |
| risu-parser-budget-exceeded | RISU_PARSER_BUDGET_EXCEEDED | assembly | sse-error, operation-state | CBS each-expansion exceeds 4096 elements or 1 MiB of expanded output. | unknown | keep |
| tokenizer-load | Failed to load tokenizer | assembly | sse-error, operation-state | The selected portable tokenizer cannot load its server asset or implementation. | unknown | needs-decision |
| tokenizer-not-loaded | before synchronous token counting. | assembly | sse-error, operation-state | Synchronous counting requests a portable tokenizer that was not loaded. | unknown | needs-decision |
| trigger-stop | trigger_stop | assembly | sse-error, operation-state, stream-reason | A start trigger sets stopSending before the main provider is dispatched. | rejected | needs-decision |
| unknown-stop | unknown_stop | assembly | sse-error, operation-state, stream-reason | Assembly stopped without one of its named abort reasons. | unknown | needs-decision |
| validate-throwserverluafailure | throwServerLuaFailure | assembly | sse-error, operation-state | Lua reports an interactive, unsupported, execution, timeout, abort or aggregate-budget failure to the assembly caller. | unknown | needs-decision |
| bedrock-invalid-key | The key assigned to this request is invalid. | dispatch | sse-error, operation-state | The Bedrock colon-delimited key has the wrong field count or blank required parts. | unknown | needs-decision |
| bedrock-invalid-request | bedrock could not resolve request from the given options | dispatch | sse-error, operation-state | Bedrock request resolution fails even after credential selection. | unknown | needs-decision |
| cohere-no-user | cohere requires a user message to generate a response | dispatch | sse-error, operation-state | Cohere cannot find a usable user message in the request. | rejected | needs-decision |
| dispatch-anthropic | options.anthropic.apiKey is required | dispatch | sse-error, operation-state | The anthropic provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-bedrock | options.bedrock.credentials is required | dispatch | sse-error, operation-state | The bedrock provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-cohere | options.cohere.apiKey is required | dispatch | sse-error, operation-state | The cohere provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | tolerated | needs-decision |
| dispatch-gemini | options.gemini.apiKey or options.gemini.vertex is required | dispatch | sse-error, operation-state | The gemini provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-horde | options.horde.prompt is required | dispatch | sse-error, operation-state | The horde provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-kobold | options.kobold.baseUrl is required | dispatch | sse-error, operation-state | The kobold provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-legacy-instruct | options["openai-legacy-instruct"].apiKey is required | dispatch | sse-error, operation-state | The legacy-instruct provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-mistral | options.mistral.apiKey is required | dispatch | sse-error, operation-state | The mistral provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-nanogpt | options.nanogpt.apiKey is required | dispatch | sse-error, operation-state | The nanogpt provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-ollama | options.ollama.baseUrl is required | dispatch | sse-error, operation-state | The ollama provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-ooba-legacy | options["ooba-legacy"].baseUrl is required | dispatch | sse-error, operation-state | The ooba-legacy provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-openai | options.openai.apiKey is required | dispatch | sse-error, operation-state | The openai provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-openai-request | apiKey is required | dispatch | sse-error, operation-state | The openai-request provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-responses | options["openai-responses"].apiKey is required | dispatch | sse-error, operation-state | The responses provider variant/request resolver cannot construct a request from its required credentials, endpoint, model and input. | unknown | needs-decision |
| dispatch-tools | tools are not supported by the resolved | dispatch | sse-error, operation-state | A nonempty tool list selects a provider outside the supported OpenAI/OpenRouter/NanoGPT/Responses/Anthropic/Gemini tool set. | unknown | needs-decision |
| dispatch-unimplemented | provider not implemented yet: | dispatch | sse-error, operation-state | Dispatch reaches a provider without an implemented final adapter. | rejected | needs-decision |
| generation-credential-authority-missing | generation_credential_authority_missing | dispatch | sse-error, operation-state | A live-id-v1 accepted credential must be refreshed but no SQLite credential authority is available. | not-applicable | keep |
| generation-credential-identity-changed | generation_credential_identity_changed | dispatch | sse-error, operation-state | The live Vertex client email differs from the accepted service-account identity. | not-applicable | keep |
| generation-credential-unavailable | generation_credential_unavailable | dispatch | sse-error, operation-state | The accepted credential id is missing, duplicated, malformed, type-changed, or lacks usable live key material. | not-applicable | keep |
| invalid-json-schema | Invalid JSON schema: | dispatch | sse-error, operation-state | Structured-output JSON/schema-interface text cannot be parsed into a supported schema. | rejected | needs-decision |
| openrouter-catalog-failed | the model catalog request failed and no cached free model is available. | dispatch | sse-error, operation-state | OpenRouter risu/free discovery fails with no cached eligible model. | unknown | needs-decision |
| openrouter-no-free-model | the model catalog contains no eligible free model. | dispatch | sse-error, operation-state | OpenRouter risu/free discovery returns no eligible free model. | unknown | needs-decision |
| provider-dispatch-exception | provider_dispatch_exception | dispatch | sse-error, operation-state | Provider preparation or iteration throws and the chat route converts it to a terminal error. | unknown | needs-decision |
| validate-readprovidercredentials | readProviderCredentials | dispatch | sse-error, operation-state | Live persisted provider credential records are malformed or contain duplicate identities. | not-applicable | keep |
| validate-resolveopenaicompatiblevariant | resolveOpenAICompatibleVariant | dispatch | http:400 | Completion provider options lack required credentials or contain malformed additional-parameter pairs. | not-applicable | needs-decision |
| aborted | aborted | post-dispatch | sse-error, operation-state | Provider iteration ended without a terminal result, or a background memory deadline was already aborted. | not-applicable | needs-decision |
| cancel-finalization-journal-unconfirmed | cancel_finalization_journal_unconfirmed | post-dispatch | operation-state | The route cannot confirm durable journaling of its cancelled partial. | not-applicable | needs-decision |
| completion-output-cap | completion output exceeded the | post-dispatch | http:400 | Buffered completion output exceeds the 32 MiB accumulation cap. | not-applicable | keep |
| finalization-journal-unconfirmed | finalization_journal_unconfirmed | post-dispatch | operation-state | The route cannot confirm durable journaling of its failed finalization. | not-applicable | needs-decision |
| finalization-record-missing | finalization_record_missing | post-dispatch | operation-state | Startup finds finalizing ownership without a recoverable finalization record. | not-applicable | needs-decision |
| generation-aborted | generation_aborted | post-dispatch | operation-state | A durable provider iterator ends without a terminal result and without successful completion. | not-applicable | needs-decision |
| generation-cancel-persistence-failed | generation_cancel_persistence_failed | post-dispatch | sse-error, operation-state | A cancelled partial cannot be committed by cancellation finalization. | not-applicable | needs-decision |
| generation-configuration-chat-missing | generation_configuration_chat_missing | post-dispatch | sse-error, operation-state | A follow-up runtime overlay cannot identify or load its accepted chat. | not-applicable | keep |
| generation-effect-atomic-commit-required | generation_effect_atomic_commit_required | post-dispatch | http:409 | An effect receipt attempts to bypass the required atomic message/effect commit. | not-applicable | keep |
| generation-effect-claim-stale | generation_effect_claim_stale | post-dispatch | http:409 | An effect lease/claim is missing, expired, or no longer exact. | not-applicable | keep |
| generation-effect-foreign-session | generation_effect_foreign_session | post-dispatch | http:423 | An effect mutation belongs to a different admitted browser session. | not-applicable | keep |
| generation-effect-target-stale | generation_effect_target_stale | post-dispatch | http:409 | A generated-translation/effect target or atomic claim no longer matches its accepted result. | not-applicable | keep |
| generation-effects-not-found | generation_effects_not_found | post-dispatch | http:404 | A completion-effect lookup finds no matching effect ledger entry. | not-applicable | needs-decision |
| generation-finalization-lineage-stale | generation_finalization_lineage_stale | post-dispatch | operation-state | Finalization no longer owns the exact operation/attempt or persisted scope. | not-applicable | keep |
| generation-persistence-failed | generation_persistence_failed | post-dispatch | sse-error, operation-state | Provider output cannot be committed by normal finalization. | not-applicable | needs-decision |
| malformed-finalization-journal | malformed_finalization_journal | post-dispatch | operation-state | A stored finalization journal cannot be safely replayed and is quarantined. | not-applicable | needs-decision |
| mutation-id-conflict | mutation_id_conflict | post-dispatch | http:409 | An effect mutation id is reused with different content. | not-applicable | keep |
| not-applicable | not_applicable | post-dispatch | operation-state | The completion effect is skipped because it does not apply. | not-applicable | needs-decision |
| not-configured | not_configured | post-dispatch | operation-state | IGP is skipped because its prompt template is blank. | not-applicable | needs-decision |
| operation-effective-configuration-missing | operation_effective_configuration_missing | post-dispatch | http:409 | A completion effect has no accepted effective configuration to load. | not-applicable | needs-decision |
| provider-failed | provider_failed | post-dispatch | operation-state | The provider attempt fails; a retained partial is terminal while an empty protocol-v1 attempt can be retried. | not-applicable | needs-decision |
| provider-output-banned | provider_output_banned | post-dispatch | sse-error, operation-state | All usable provider output is rejected by the banned-output script policy. | not-applicable | needs-decision |
| backup-copy-batch-limit-exceeded | backup_copy_batch_limit_exceeded | out-of-scope | operation-state | A backup-copy request exceeds the worker batch cap. | not-applicable | keep |
| backup-copy-pool-busy | backup_copy_pool_busy | out-of-scope | operation-state | No backup worker slot is available. | not-applicable | needs-decision |
| backup-copy-pool-closed | backup_copy_pool_closed | out-of-scope | operation-state | Backup-copy submission targets a closing pool. | not-applicable | needs-decision |
| backup-directory-depth-exceeded | backup_directory_depth_exceeded | out-of-scope | operation-state | Backup directory traversal reaches its depth cap. | not-applicable | keep |
| bardwiki-reconcile-authority-invalid | bardwiki_reconcile_authority_invalid | out-of-scope | operation-state | A BardWiki reconcile-receipt job incorrectly carries generation operation authority. | not-applicable | keep |
| chat-not-found | chat_not_found | out-of-scope | http:409 | A completion-effect occupancy check cannot find its chat. | not-applicable | needs-decision |
| chat-occupancy-switch-required | chat_occupancy_switch_required | out-of-scope | http:409 | A compatibility effect would switch from an already occupied chat without the exact switch protocol. | not-applicable | keep |
| generation-ended-without-result | generation_ended_without_result | out-of-scope | operation-state | The durable runner terminates without a committed assistant result. | not-applicable | needs-decision |
| generation-job-configuration-missing | generation_job_configuration_missing | out-of-scope | operation-state | A background job has no complete matching accepted operation/attempt configuration. | not-applicable | needs-decision |
| generation-job-configuration-stale | generation_job_configuration_stale | out-of-scope | operation-state | A background job cannot verify or decode its accepted configuration. | not-applicable | keep |
| generation-job-foreign-session | generation_job_foreign_session | out-of-scope | operation-state, http:423 | A background job control request comes from a different originating writer session. | not-applicable | keep |
| generation-job-lineage-missing | generation_job_lineage_missing | out-of-scope | operation-state, http:409 | A scoped memory/BardWiki job lacks operation/attempt identity. | not-applicable | keep |
| generation-job-lineage-stale | generation_job_lineage_stale | out-of-scope | operation-state, http:409 | The job operation lineage no longer matches current authoritative ownership. | not-applicable | keep |
| generation-job-not-found | generation_job_not_found | out-of-scope | http:404 | A process-local generation stream/job has expired or cannot be found. | not-applicable | needs-decision |
| generation-job-target-stale | generation_job_target_stale | out-of-scope | operation-state | A stored memory/BardWiki job no longer matches its captured chat/operation/attempt/scope. | not-applicable | keep |
| generation-terminal-snapshot-not-found | generation_terminal_snapshot_not_found | out-of-scope | http:404 | A retained terminal snapshot has expired or cannot be found. | not-applicable | needs-decision |
| inferred-provider-id | inferred-provider-id | out-of-scope | operation-state | Provider identity is inferred; this reason alone can accompany a ready profile. | not-applicable | needs-decision |
| invalid-maintenance-lease | invalid_maintenance_lease | out-of-scope | operation-state | A maintenance operation presents an invalid coordinator lease. | not-applicable | keep |
| legacy-mode | legacy-mode | out-of-scope | operation-state | Legacy model selection yields compatibility status rather than a profile rejection. | not-applicable | needs-decision |
| legacy-recovery-unavailable | legacy_recovery_unavailable | out-of-scope | operation-state | Startup cannot recover a persisted result or pending journal for a nonterminal legacy-origin operation. | not-applicable | needs-decision |
| missing-provider-id | missing-provider-id | out-of-scope | operation-state | No effective provider can be inferred and the profile is retained in compatibility status. | not-applicable | needs-decision |
| server-restarted | server_restarted | out-of-scope | operation-state | Startup recovers an interrupted protocol-v1 operation or attempt. | not-applicable | needs-decision |
| stale-generation-attempt | stale_generation_attempt | out-of-scope | http:409 | An attempt control or stream attachment refers to a noncurrent or non-dispatchable attempt. | not-applicable | keep |
| static-model | static-model | out-of-scope | operation-state | A static-model override yields compatibility status rather than a profile rejection. | not-applicable | needs-decision |
| user-stop | user_stop | out-of-scope | operation-state | The user requests cancellation and the runner settles without a result. | not-applicable | needs-decision |
| validate-parsecancellationoccupancy | parseCancellationOccupancy | out-of-scope | http:400 | A Stop envelope supplies only one of chatId and chatOccupancy. | not-applicable | needs-decision |
<!-- generation-rejection-table:end -->
