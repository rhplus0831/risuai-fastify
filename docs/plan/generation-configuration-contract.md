# Accepted generation configuration contract

Status: implemented for newly accepted operations (storage version 2, semantic contract 1); legacy inline snapshots retain compatibility behavior.
Date: 2026-09-17.
Scope: accepted Send, Continue, and Regenerate operations, explicit retries, and
operation-owned follow-up work. The bounded manifest references immutable SQLite dependencies; the existing
8 MiB limit applies to the manifest.

## Purpose and guarantee

Once an operation is accepted, subsequent configuration edits must not change
its model routing, prompt rules, executable definitions, asset lookup results,
or follow-up policy. The same operation ID, including an explicit retry, retains
those accepted choices. A new operation resolves current configuration again.

This guarantees configuration consistency, not identical prompts, identical
model output, or automatic permission to replay a provider request. Authorized
transcript transforms, completed memory work, partial-result bookkeeping,
time/random macros, and external tools can change attempt inputs or results.
Provider-dispatch ambiguity and existing retry authority remain separate checks.

The acceptance boundary is the SQLite transaction that validates the target and
revision, appends the accepted user row for Send, binds authority, and records
the operation. Configuration and dependency versions must describe one coherent
state at that boundary, not a series of reads after the transaction commits.

## Classification rule

Every generation input must have one of these owners:

1. **Fixed operation input:** an accepted selection, setting, definition, or
   dependency whose later editing must not redirect this operation.
2. **Operation runtime state:** mutable data read and advanced under the
   operation's existing target, occupancy, revision, and publication checks.
3. **Live execution control:** authorization, cancellation, resource availability,
   and service limits checked when work actually executes.
4. **Outside generation:** data with no supported generation/follow-up reader.

Size alone never decides the category. Fixed data can be represented by a small
immutable reference; runtime state must not become fixed merely because it is
small. A normal row ID or global revision number is not an immutable reference
unless the corresponding historical contents remain retrievable.

## What must remain fixed

| Input family | Required accepted contents | Boundary and exclusions |
| --- | --- | --- |
| Operation intent and target | Database lineage, operation ID, character/chat IDs, mode, accepted user ID or continue/regenerate target ID, accepted tail identity, durable generation options and declared client context/capabilities. | Keep the accepted source relationship. Message text belongs to transcript state; committed submit transforms must not be reapplied on retry. |
| Admission and scope | Originating session, admission kind, occupancy tuple, permission-scope version, and accepted allowed effect classes. | These record the grant; they do not bypass current cancellation, lineage, occupancy, or publication checks. Role changes must not silently widen the grant. |
| Provider routing | Effective main model/profile, provider, endpoint/routing options, tokenizer selection, and eligible auxiliary role/profile bindings for Agents, scripts, memory, translation, and other enabled effects. | Preserve model/prompt/profile override precedence. Do not retain unrelated profiles solely because they share a settings array. Dynamic profile selection needs the explicit rule below. |
| Provider request policy | Context/output budgets, samplers and penalties, reasoning/thinking options, streaming settings that affect execution, JSON schema/output constraints, tool declarations, custom flags, and effective provider-specific options. | Preserve explicit values, defaults, absence, and precedence. Use the resolved inputs consumed by dispatch, not global editor mirrors. Service availability and rate-limit queues remain live. |
| Prompt and character definitions | Selected prompt template/order, main/jailbreak/global/chat notes, formatting, persona text and name, relevant character definition/greeting/example fields, name resolution, local/global/module lore definitions and activation rules. | Preserve supported prompt-visible metadata even if it looks like a label. Lore activation results depend on runtime inputs and need not be frozen at acceptance. Unrelated characters/chats/presets are excluded. |
| Variables and toggles | Accepted global configuration variables and sidebar-toggle values, defaults supplied by definitions, module activation identifiers and precedence/order. | Chat `scriptstate` is runtime state, not a second fixed copy. Consumers must explicitly use accepted defaults plus the appropriate runtime checkpoint. |
| Executable definitions | Applicable regex, input/output/request transforms, triggers/Lua, script model overrides, module namespaces/identities, and capability requirements. | Freeze source and ordered configuration; execution results and authorized writes are runtime state. Script permissions are also subject to live controls. |
| Module and character asset catalogs | Ordered tuples mapping names to asset references/types, namespace and matching/precedence rules, and the versions of catalogs observable by supported lookup/enumeration APIs. | Preserve the catalog as a dependency, not a per-operation copy. Binary bytes remain in content-addressed storage. Missing pinned catalog/configuration versions are explicit failures, never a fallback to newly edited catalogs. Binary availability follows the separate runtime rule below. |
| Agents | Selected Agent Preset, dependency order, referenced Agent definitions/prompts/model bindings, module integration, composition policy, and configured inputs. | Actual Agent outputs and external responses are attempt/job results. Selecting an unrelated Agent dynamically requires a defined dependency rule. |
| Hypa policy | Enabled mode, selected preset/version, Memory Tokens Ratio, context/truncation policy, summary and re-summary prompts, summary/embedding model bindings, chunk/query limits and selection ratios. | Hypa summaries, embeddings, selection metrics, and job progress are runtime data. Policy remains fixed while its own background work progresses. |
| BardWiki policy | Effective global-plus-chat settings, prompts, provider/model binding and operation-owned apply policy. | Receipt source, document revisions, and retrieval results belong to their owning job/attempt; do not embed the whole wiki in operation configuration. |
| Follow-up policy | Accepted eligibility/settings for supported IGP, generated translation, emotion/image work, and other durable generation effects: prompts, preset/model bindings, translator language/history policy, and relevant character/chat settings. | Child work inherits accepted policy rather than silently resolving edited settings at job start. Generated/translated text, target versions and receipts are bound when that child work is created/executed. |
| Credential binding | Selected credential identity and provider/endpoint binding; authentication material is handled separately from ordinary configuration. | Keep secrets out of ordinary configuration JSON. New-operation policy: resolve the current secret for the same credential ID at each provider dispatch, allowing explicit same-ID rotation; never silently select another credential or endpoint. Unavailable/revoked credentials fail under live controls. Legacy flat credentials remain accepted secrets in separately classified dependency rows; legacy inline snapshots keep their original behavior. |

“Relevant” means observable through a supported generation or follow-up API,
including dynamic branches. It does not mean “appeared in the last successful
prompt.” Source owners below define the starting inventory, not permission to
spread their entire database types into a new snapshot.

## Dynamic dependency rule

A script can conditionally select profiles, enable modules, read named lore,
resolve assets, or enumerate a catalog. A static scan of the final prompt is
therefore insufficient to identify the required fixed dependencies.

For each supported selector, choose and test one of two explicit contracts:

- Resolve only inside an accepted immutable candidate set, preserving order,
  names/namespaces, absence, duplicates, and current matching rules.
- Reject undeclared/out-of-set selection before dispatch with a specific
  dependency error. Introducing this restriction requires a documented
  compatibility change; do not add it incidentally while shrinking snapshots.

The current module candidate set is the ordered selection matching the union of
global `enabledModules`, character modules, chat modules, persona modules,
selected prompt integration, and effective Agent Preset integration. Preserve
ID/namespace matching and duplicate/order semantics within that set.

The compatibility-preserving default is the first rule. If an API can select
any member of a collection, pin the applicable collection version by reference
rather than copying every record. If current server selection already excludes a
module, this contract does not newly make that module selectable. Verify each
API's actual visible set before narrowing or expanding it.

For the production case, `moduleassetlist` can enumerate asset names. Pinning
only assets previously used by a message would change behavior. The 14 selected
module catalogs can remain logically fixed without copying 14.8 MB into each
operation. Whether references cover whole modules or separate catalogs is a
storage decision, not a difference in the promised behavior.

Binary asset IDs remain content-addressed. Current multimodal resolution can
drop missing assets non-fatally; separating catalogs must not silently change
that policy to a hard failure. Retention for referenced bytes needs a dedicated
policy and test. The fixed guarantee here concerns catalog contents and lookup
identity, not a claim that all external content is always available.

## What remains live, and when

| State | Read/check boundary | Required invariant |
| --- | --- | --- |
| Transcript, submit-transform receipts, partial responses | Attempt preparation and exact publication checks. | A retry sees its own committed transforms and does not append the user row twice. Unrelated edits are governed by existing target/revision checks; “live” does not mean accepting arbitrary changes. |
| Chat `scriptstate`, `lastMemory`, Hypa data | Attempt preparation; child jobs/effects use the checkpoint appropriate to their own source/result binding. | Operation-owned changes persist. Never restore stale values from the accepted configuration. IGP/translation variable semantics must be explicit rather than accidentally using an old clone. |
| Summary/embedding rows and wiki documents | Existing memory planning/retrieval boundaries; bind source chunks/receipts when enqueuing jobs. | A job retry processes its recorded source with accepted policy. A generation retry may see newly completed, source-valid memory work; it is not a byte-for-byte prompt replay. |
| IGP/translation source and terminal history | Effect creation and execution, with exact terminal transcript/message binding and revalidation at commit. | Configuration stays accepted; the effect consumes the generated result, not the acceptance-time transcript. |
| External tool results, network responses, clock/random values | Attempt or tool-call execution, with existing result receipts where provided. | Do not promise deterministic replay or repeat non-idempotent work merely because configuration is fixed. |
| Authorization, scope/occupancy validity, cancellation, reset lineage | Existing dispatch, worker, effect, and publication boundaries. | A snapshot supplies inputs, not new authority. Preserve accepted-work lifetime rules; do not equate session disconnect with revocation. |
| Availability, credential revocation, server resource/rate limits | Each execution boundary. | Configuration pinning cannot force use of unavailable resources or override live restrictions. |
| Notifications, originating-session completion audio/TTS playback | Existing session delivery/recovery boundary. | Do not treat ephemeral playback as a reason to retain the entire application configuration. Provider-side generation, if any, still requires its own declared policy. |

## What must be excluded

Exclude unrelated collection records, sibling transcripts, database export
wrappers, revision journals, request history, backups, caches, sidebar layout,
editor expansion state, and presentation-only preferences from the operation
configuration. A metadata field exposed to a supported prompt/script API must
first be classified as prompt-visible, rather than discarded by its name.

Exclude message bodies, Hypa histories, embeddings, binary asset bytes, and
external results from the configuration byte budget. Preserve them under their
runtime/content owners with the necessary identity and availability checks.
Do not duplicate a selected prompt template both as a full preset and as a
flattened mirror merely to satisfy a broad database-shaped interface.

## Retry and retention rules

- Same operation: same fixed configuration/dependency versions, fresh attempt
  identity, and authoritative operation runtime state. Editing settings is not
  a way to alter an already accepted retry; a new operation adopts the edit.
- A child job retains its parent's fixed policy and its own recorded source
  identity after the main operation settles, for the lifetime allowed by the
  existing worker/effect contract.
- References must remain resolvable across restarts, module edits/deletion, and
  all supported retry/recovery windows. Garbage collection must account for
  operation, attempt, effect, memory/BardWiki job and backup/restore reachability.
- Missing/corrupt references fail explicitly. Do not silently load the newest
  module/preset or rewrite old fingerprints. Existing inline snapshots require
  a compatibility reader until their supported lifetime ends.
- Pin a contract/semantic version. A deploy is not proof that an older accepted
  operation can be interpreted identically by a new engine; incompatible
  versions need a defined migration or explicit incompatibility outcome.

## Required implementation proofs

1. Accept, edit selected prompts/model/persona/modules/global variables, then
   execute/retry: accepted choices survive. A new operation uses the edits.
2. Accept, rename/remove/reorder module asset entries, then perform both lookup
   and `moduleassetlist`: accepted names/order/absence remain unchanged.
3. Reproduce 14 modules with about 10,000–11,000 asset entries each: admission
   succeeds without deleting catalog capabilities or copying catalogs into every
   bounded operation record. Also preserve ordering/duplicate-selector behavior.
4. Commit submit transforms or chat variables, then retry: no duplicate input,
   no reapplication of committed effects, and no stale runtime restoration.
5. Change Memory Tokens Ratio or summary/model policy after acceptance: old work
   keeps policy, a new operation adopts changes, and source-valid completed
   summaries can still advance the old operation's runtime state.
6. Start delayed memory, BardWiki, translation, and IGP work after settings edits:
   inherited configuration and child source/result identities both remain valid.
7. Exercise dynamic module/profile/asset branches, not just the branch taken by
   the initial attempt. Missing bindings must not silently choose live defaults.
8. Revoke credentials/cancel/reset lineage/change authority: frozen inputs never
   bypass the applicable current checks or expand the accepted scope.
9. Delete/edit dependencies, restart, retry, then prune eligible old work: required
   versions remain until no consumer needs them; legacy snapshots still read.
10. Change UI-only state: no configuration/dependency version change. Add a new
    generation-read field: a coverage check must require an owner/category.

The implementation provides an explicit typed field/dependency manifest for
settings, characters, chats and modules, plus the translator policy inventory. The current `Database` and
`GenerationSettings` types are inventories of potential reads, not the new
contract. An unclassified read is a design gap to resolve, not an excuse to
copy the whole object. Do not select a replacement size limit before testing
this representation against the production-shaped corpus.

## Implementation and compatibility

- [Manifest](../../server/fastify/src/generationConfigurationManifest.ts):
  exhaustive typed owners for finite settings/character/chat/module inputs and
  an explicit translation-policy inventory. Supported dynamic candidate sets
  retain repository selection and ordering.
- [Storage and resolver](../../server/fastify/src/generationConfiguration.ts):
  content-addressed dependency rows, canonical integrity checks, reference
  escaping, versioned manifest, secret classification, terminal runtime overlay,
  asset-retention indexes and transaction-scoped orphan pruning.
- [Credentials](../../server/fastify/src/generationCredentials.ts):
  same-ID secret rotation for new-operation dispatch; accepted provider/endpoint
  remain fixed. Legacy flat credentials remain pinned, without inventing an
  identity-based rotation policy for credentials that have no durable ID.
- [Acceptance and assembly](../../server/fastify/src/routes/generationChat.ts)
  and [operation routes](../../server/fastify/src/routes/generationOperations.ts):
  atomic capture, retry hydration and authoritative runtime reload.
- Memory, BardWiki, IGP and translation consumers share the versioned resolver.
  Definitions stay accepted while each consumer validates its existing scope
  and source/result binding.
- Migration 41 creates the dependency store without rewriting existing
  fingerprints. SQLite backup/restore carries these rows; portable import clears
  the old store. All existing operations retain dependencies, with no new expiry
  window. Explicit orphan pruning only removes rows unreachable from them.
- [Contract tests](../../server/fastify/__tests__/generationConfiguration.test.ts)
  and [durable route tests](../../server/fastify/__tests__/durableGeneration.test.ts)
  cover large catalogs, deduplication, edits, runtime exclusion, restarts,
  integrity failures and legacy compatibility. Existing child-job, authority,
  cancellation and retry tests continue to exercise their independent fences.

No asset binary is embedded in a configuration dependency. Existing missing
binary handling remains unchanged; the retention index prevents GC from
reclaiming accepted assets merely because live module catalogs were edited.

The supplied production dump confirms a 15,781,805-byte configuration,
14,814,965 bytes of selected modules, no embedded messages, and no embedded Hypa
blob. Database-backed startup probes succeeded. This contract addresses the
configuration failure; it does not assert a cause or fix for browser startup.
