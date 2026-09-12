# Domain Mutations and Editing Owners

Last audited: 2026-08-31.
Targeted source check: 2026-09-12 (visible settings outcomes and draft recovery boundaries).

This area covers optimistic browser edits and rollback for settings, prompts and presets, characters,
chats and messages, personas, loadouts, modules, plugins, lorebooks, and script definitions. It also
covers debounced Svelte owner drafts, dirty-draft reconciliation, stable-target command adapters, and
the retained local projections used while durable mutations await replay.

The shared command queue, encrypted outbox, authoritative resource owners, and event reconciliation are
assessed in [Browser State Sync and Recovery](browser-state-sync-and-recovery.md). Provider/model record
semantics belong in [Providers, Models, and Media](providers-models-and-media.md); prompt execution belongs
in [Prompting, Generation, and Streaming](prompting-generation-and-streaming.md); runtime script semantics
belong in [Scripting, Parsing, and Automation](scripting-parsing-and-automation.md). Asset bytes and import/
export transport are assessed in [Assets, Import/Export, and Backups](assets-import-export-and-backups.md),
and plugin/MCP protocol behavior is assessed in
[Plugins, Modules, and MCP](plugins-modules-and-mcp.md). Rendered chat behavior is assessed in
[App Navigation and Chat](app-navigation-and-chat.md); settings/extension UI and character-content UI are
assessed in [Settings, Profiles, and Extensions](settings-profiles-and-extensions.md) and
[Character Content, Memory, and Catalogs](character-content-memory-and-catalogs.md). Shared controls,
alerts, and accessibility are assessed in
[Shared UI, Feedback, and Accessibility](shared-ui-feedback-and-accessibility.md).

The rendered display-settings interruption journey is documented in
[Browser State Sync and Recovery](browser-state-sync-and-recovery.md#durable-command-interruption-through-visible-settings).
It complements settings-owner tests with native storage, HTTP/SSE, SQLite, and
visible saving/error/value assertions. Composer writer-switch recovery provides
the selected draft-bearing browser journey; encrypted module draft read/cleanup
races use the narrower real-crypto store tests indexed in
[Settings, Profiles, and Extensions](settings-profiles-and-extensions.md).
Neither selection claims browser recovery coverage for every editor.

## Test groups

| Logical group | Relevant test locations and included cases | Behavior and regression importance |
| --- | --- | --- |
| Settings writes and dirty drafts | `settingsOwner.svelte.test.ts`: onboarding; immediate no-op/mixed patches; error reporting; field-scoped rollback/rebase; Hypa V3 append/rename/delete/reinsert/selection cases; retained projections; canonical acknowledgement; and exact group/collection-fenced draft reassertion, merge, rejection, and reseeding. `settingsOwner.durable.svelte.test.ts` covers caller-owned staging plus scalar and sparse-object total/partial revert closure after a remote dispatch marker. | Settings owners run throughout the app and can silently overwrite a newer edit if their baseline or rollback is wrong. Sparse objects and Hypa rows are especially prone to broad replacement bugs. |
| Prompt, legacy preset, and split-preset editing | `storage/database.svelte.test.ts`: prompt-template ID detection; settings/model/Agent/accessibility normalization; seven targeted character-row merges; 80 legacy/split preset hydration, sparse save, local ACK, owner ordering, reference repair, select/reorder/copy/create/update/delete rollback cases; and 19 durable retained-projection cases. `promptTemplateMutations.svelte.test.ts`: item-level projection/restore, owner-switch guards, structural rollback, debounced row patches, durable predecessor/correction order, delete-vs-null, lifecycle flush, drag stable IDs, hydration failure/retry, selected-owner adoption, prompt-setting dirty merge, accessibility, and reconciliation. | Protects prompt text and preset state, where an unloaded shell or owner switch can otherwise persist an empty template or write to the wrong preset. |
| Character rows, selection, folders, and character draft | `characterCommands.test.ts`: create payloads, create/delete rollback, selection rollback, order/folder helpers including durable reorder, Supa-memory scalar mutation (9 including the projection helper), row snapshots, scoped dispatch, sanitized kept-key diff, and soft/permanent delete behavior. `characters.changeChar.test.ts` covers import navigation and shell selection freshness. `characterDraft.svelte.test.ts` covers stable-id draft seeding, dirty-field refresh, sanitized/coalesced dispatch, shell suppression, and field-scoped rollback. MCP `characters.setCharacterInfo.test.ts` covers owner abort/replacement/deletion and optimistic character/lorebook/regex/Lua writes with narrow rollback. | Stable character IDs must survive list reorder, deletion, selection changes, and delayed confirmation. Broad rollback would corrupt chat bodies or sibling characters. |
| Chats, messages, generation settings, and file-driven writes | `chatCommands.test.ts` covers projection helpers, selection and structure snapshots, message/scriptstate/note dispatch, factory/sequence rejection, narrow diffs, rollback matrices, durable chat/folder structures, and full-chat reset. Reset cases optimistically replace one character's chats with an empty selected `Chat 1` and restore the exact prior chat array if the durable PUT fails. `activeChatGenerationSettings.test.ts` and `chatGenerationSettings.test.ts` cover readiness, defaults, sparse diffs/digests, stale references, pruning, and stable errors. `alternateGreetingMutation.test.ts` and `alternateGreetingCommands.test.ts` repair chat greeting indices and fence durable optimistic cascades. `globalApi.changeChatTo.test.ts`, `process/files/multisend.test.ts`, and `util.persona.test.ts` cover clone-free selection, file ingestion, and persona precedence. | Protects the highest-frequency state transitions: selecting or resetting chats, editing metadata, appending/editing/deleting messages, importing transcripts, and saving chat-owned generation settings. |
| Personas and loadouts | `persona.test.ts`: 33 stable-ID preparation/debounced PATCH/selection/delete/reorder/dependency/absolute-correction cases, five collection rollback guards, and five dirty selected-profile reconciliation cases. `personaDisplayName.test.ts` pins display/internal naming; `packages/shared-core/src/mutationCertificates.test.ts` pins compact certificate serialization and browser-facade identity. `loadout.test.ts` covers canonical create, multi-facet serialized apply, retained/terminal steps, queue reservation, concurrent replanning, hydration, persona/preset/module/global-variable/Agent Preset facets, touch/favorite, refresh overlays, and create/delete rollback. `loadoutCanonical.test.ts` expands 13 exact/invalid server-shape cases. | Persona and loadout operations touch several resource owners at once. Partial rollback can corrupt the selected profile, references in chats/loadouts, preset selections, module links, or sidebar settings. |
| Modules, plugins, imports, and MCP adapters | `moduleCommands.test.ts` covers projection helpers, chat-scoped toggles, snapshot narrowing, multi-step rollback, durable order, and record/link mutations. `pluginCommands.svelte-node.test.ts` covers arguments, enable/provider/create/update/delete/reorder, grouped settings, pending storage overlays, serialization, and bulk rollback; `pluginCommands.durable.svelte-node.test.ts` adds exact predecessor/successor replay settlement. `process/modules.test.ts`, MCP module projection/read tests, and `stores.modulesEffect.svelte.test.ts` cover imports, partial settlement, refresh, immediate read visibility, and reactive dependency cost. | Modules and plugins span collection records, enabled lists, character/chat references, assets, lorebooks, scripts, triggers, and custom storage. Sequencing errors can persist only half an import or resurrect a deleted record. |
| Lorebooks and script/trigger definitions | `lorebookOwner.svelte.test.ts` covers dirty-entry merge, no-data-loss hydration/watchers, modal and entry mutations, sparse/structural rollback, scoped watchers, ID validation, and module projection fencing. `lorebookOwner.durable.svelte.test.ts` covers scoped snapshots/dispatch and durable owner ordering. `scopedLorebookMutationUiState.test.ts` keeps coalesced failure and local activation outcomes bound to chat plus stable entry ID. `scriptDefinitionOwner.svelte.test.ts` and `scriptDefinitionMutations.test.ts` cover explicit owner drafts, compact mutations, global-script watching, and scoped rollback. | Lorebook and script editors are vulnerable to catastrophic stub writes, wrong-owner updates, and broad rollback that removes unrelated entries or domains. |

## Included case matrices and boundaries

The largest files organize many individual tests under one `describe`; the following map makes their
coverage boundaries explicit without repeating one paragraph per assertion.

### Settings and prompt/preset matrices

- Immediate settings cases distinguish unchanged values, mixed changed/unchanged keys, undefined
  no-delete behavior, newer same-key edits, multi-key partial rollback, runtime-effect replay, and
  immediate writes merged with pending/debounced work.
- Sparse settings cases distinguish explicit deletion, total revert, partial revert, older in-flight
  failure, retained retry projection, successor restaging, successor becoming a no-op, and one-time error
  reporting. Hypa V3 rows separately cover append, edited append, rename, delete/reinsert, selection index
  rebase, duplicate avoidance, and selection-only generic rollback.
- Legacy/split preset parameter rows cover immediate edits after retained `model` and `prompt` creates;
  marked `model`/`prompt` predecessors with total/partial revert closures; retained legacy create/update/
  delete/reorder projections across targeted/full refresh; retained legacy/model/prompt selections; and
  terminal legacy/model/prompt reorder rebasing.
- Prompt item owner-switch cases separately cover create, delete, reorder, and enable at command
  construction and rollback. Drag cancellation separately covers missing source, missing target, and owner
  change. Prompt dirty merge distinguishes row text, clean sibling fields, catch-up clearing, owner reset,
  and settings patches that must survive row reset.

### Character and chat matrices

- Character create/delete cases distinguish create vs create-and-select, import without an optimistic
  row, permanent delete reinsertion, duplicate same-ID replacement, selection index compaction, and
  durable dependencies behind a retained profile patch or delete. Order cases cover root/folder moves,
  folder creation, rename/color/image reset/update, invalid drag/missing folder, stable folder ID, terminal
  rollback, retained replay, and newer folder metadata after an older failure.
- Character scalar/snapshot cases cover `supaMemory`, input translation, selected-character auto-enable,
  `trashTime`, timestamps, stable IDs after index shifts, added-field deletion, nested-array replacement,
  excluded fields, and no full-character-array clone.
- Chat structure cases distinguish chat/folder create, delete, fork/branch fork, combined folder/chat
  reorder, duplicate IDs, missing folder assignment, selection preservation, authoritative row arrival,
  and dependent edits to a failed optimistic ghost.
- Message cases cover append, update, delete, truncate, replace-tail, replace-all, placeholder-prefix
  append/tail, unsafe placeholder edit rejection, message-ID rollback, overlapping update/delete failures,
  field divergence, metadata preservation, >100-chat pre-staging, oversized transcript chunking, accepted
  chunk prefix, and unchunkable message rejection.
- Generation-settings cases cover first write vs existing settings, exact persist-before-send, queued edit,
  retained predecessor replay, remote dispatch marker, total correction, destructive refresh, sparse ACK
  overtaken by full write, same/disjoint field failures, and accepted predecessor plus failed successor.

### Persona, loadout, module, plugin, lorebook, and definition matrices

- Persona structural proofs cover create/delete/select/reorder. PATCH behavior distinguishes debounce/
  keepalive, owner selection/deletion dependencies, partial reverts, remote-marker absolute correction,
  authoritative projection races, direct vs trigger prompt saves, duplicate/missing IDs, and confirmation
  target changes. Dirty merge covers same-field later edits and selected-row-only `largePortrait`.
- Loadout server validation accepts the exact required shape, then rejects unknown keys, blank ID/name,
  non-finite `lastUsed`, non-boolean `favorite`, invalid/sparse character IDs, invalid module IDs/global
  values, invalid required preset fields, invalid optional Agent fields, and duplicate collection IDs.
- Module mutations separately exercise global record, enabled list, character link, chat link, sidebar
  defaults, script/trigger/lorebook split fields, create/delete dependencies, and same-record failure rebase.
  Plugin cases separately cover record, provider, argument, grouped settings, and storage map ownership.
- Lorebook scopes are global collection, global entry, character collection/entry, chat collection/entry,
  and module collection/entry. Structural matrices cover create/update/delete/reorder/replace; entry draft
  matrices cover sparse fields, deletion vs null, immediate correction, in-flight successor, projection
  epoch change, and stale rollback. Watchers separately test global/module/selected-character/all scopes and
  non-open chat local lore.
- Script definitions distinguish global, character, and module owners; regex scripts vs Lua triggers;
  create/update/delete/reorder vs full replace; dirty field merge; compact acknowledgement fencing; and
  rollback after newer same-definition or sibling-domain edits.

## Especially critical tests

- `chatCommands.test.ts` and `characterCommands.test.ts` are the main protection against broad rollback
  corrupting large character/chat collections after ordinary user edits.
- `lorebookOwner.svelte.test.ts` explicitly protects the no-data-loss invariant that an unloaded or
  re-stubbed character lorebook is never persisted as empty.
- `promptTemplateMutations.svelte.test.ts` prevents writes to an old selected owner and prevents unloaded
  templates from being created or saved as empty.
- `storage/database.svelte.test.ts` protects stable legacy preset hydration and retained split-preset
  projections across refresh and replay.
- `persona.test.ts` and `loadout.test.ts` protect cross-resource references and multi-step partial success.
- `process/modules.test.ts` protects accepted-prefix/retained-suffix module imports and refuses to report
  success before durable settlement.

## Primary inventory

Every primary file owned by this document is listed exactly once. Cross-cutting asset, model, provider,
plugin/MCP protocol, scripting runtime, and UI files are assessed in their focused documents.

| Domain | Primary files |
| --- | --- |
| Settings and prompts | `src/ts/server/promptTemplateMutations.svelte.test.ts`; `settingsOwner.durable.svelte.test.ts`; `settingsOwner.svelte.test.ts`; `src/ts/storage/database.svelte.test.ts` |
| Characters | `src/ts/characterCommands.test.ts`; `characters.changeChar.test.ts`; `src/ts/server/characterDraft.svelte.test.ts`; `src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts` |
| Chats and generation | `src/ts/activeChatGenerationSettings.test.ts`; `alternateGreetingCommands.test.ts`; `alternateGreetingMutation.test.ts`; `chatCommands.test.ts`; `chatGenerationSettings.test.ts`; `globalApi.changeChatTo.test.ts`; `process/files/multisend.test.ts`; `src/ts/util.persona.test.ts` |
| Personas and loadouts | `src/ts/loadout.test.ts`; `persona.test.ts`; `personaDisplayName.test.ts`; `packages/shared-core/src/mutationCertificates.test.ts`; `src/ts/server/loadoutCanonical.test.ts` |
| Modules and plugins | `src/ts/moduleCommands.test.ts`; `pluginCommands.durable.svelte-node.test.ts`; `pluginCommands.svelte-node.test.ts`; `process/modules.test.ts`; `process/mcp/risuaccess/tests/modules.optimisticProjection.test.ts`; `process/mcp/risuaccess/tests/modules.test.ts`; `stores.modulesEffect.svelte.test.ts` |
| Lorebooks and definitions | `src/ts/server/lorebookOwner.svelte.test.ts`; `lorebookOwner.durable.svelte.test.ts`; `scopedLorebookMutationUiState.test.ts`; `scriptDefinitionOwner.svelte.test.ts`; `scriptDefinitionMutations.test.ts` |
