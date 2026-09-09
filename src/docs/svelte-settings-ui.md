# Svelte Settings UI Guide

Last audited: 2026-09-04.
Targeted source check: 2026-09-08 (reader gates and originating editor drafts).

This guide owns settings navigation, data-driven rows, shared controls,
authoring editors, model-profile presentation, and visible settings persistence
states. Return to the [architecture index](../../docs/structure/README.md) for
cross-layer ownership or the [Svelte UI guide](svelte-ui.md) for the application
shell and routing model.

## Fast Triage

| Symptom                                                                             | Inspect first                                                                             | Then inspect                                                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Category, slug, mobile back, or page switch is wrong                                | `src/lib/Setting/Settings.svelte`, `src/ts/router.ts`                                     | [Shell And Routed Pages](#shell-and-routed-pages)                                                           |
| A data-driven row is hidden, stale, or not saving                                   | `src/lib/Setting/SettingRenderer.svelte`, the matching definition under `src/ts/setting/` | `src/ts/setting/utils.ts`, `src/lib/Setting/Wrappers/`                                                      |
| A primitive control is wrong everywhere                                             | The control in `src/lib/UI/GUI/`                                                          | Its settings wrapper if only rows are affected                                                              |
| Agent, prompt, or input-hook editor is wrong                                        | The matching page/drawer under `src/lib/Setting/Pages/`                                   | The canonical runtime guide linked from its section below                                                   |
| Role/profile summary, divider, provider panel, or credential editor is wrong        | `src/lib/Setting/Pages/Model/`                                                            | `src/ts/model/modelProfileUiState.ts`, [Providers And Models](../../docs/structure/providers-and-models.md) |
| Optimistic value rolls back, queues indefinitely, or survives page exit incorrectly | `src/ts/setting/utils.ts`, `src/ts/server/settingsOwner.svelte.ts`                        | [Settings Persistence](#settings-persistence)                                                               |

## Shell And Routed Pages

Settings have two presentation layers:

- `src/lib/Setting/Settings.svelte` owns the left navigation, responsive split,
  close/back controls, `SettingsMenuIndex` switch, and manual page components.
- `src/lib/Setting/SettingRenderer.svelte` renders schema-defined rows through
  `src/ts/setting/settingRegistry.ts` and wrapper components.

The shell uses a split layout at 700 pixels when `MobileGUI` is false. A split
`/settings` view defaults to model profiles (index `17`); a narrow view uses
index `-1` for the category list and a routed page gets an explicit back button.
Close delegates to `closeSettingsRoute()`, which uses the owned history origin
or replaces a direct entry with home.

Primary indexes and canonical slugs are:

| Index      | Slug                           | Page or visible category                                                                                                           |
| ---------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `0`        | `backup`                       | `src/lib/Setting/Pages/UserSettings.svelte`                                                                                        |
| `1`        | `bot-preset`                   | `src/lib/Setting/Pages/BotSettings.svelte` when legacy presets exist; otherwise model settings                                     |
| `2`        | `memory`                       | `src/lib/Setting/Pages/OtherBotSettings.svelte`; visible label is **Memory** through `language.settingsNavMemory` and a brain icon |
| `3`        | `display`                      | `src/lib/Setting/Pages/DisplaySettings.svelte`                                                                                     |
| `4`        | `plugins`                      | `src/lib/Setting/Pages/PluginSettings.svelte`                                                                                      |
| `6`        | `advanced`                     | `src/lib/Setting/Pages/AdvancedSettings.svelte`                                                                                    |
| `7`        | `communities`                  | `src/lib/Setting/Pages/Communities.svelte`                                                                                         |
| `8`        | `global-lorebook`              | Legacy `src/lib/Setting/Pages/GlobalLoreBookSettings.svelte`; nav is visibility-gated                                              |
| `9`        | `global-regex`                 | Legacy `src/lib/Setting/Pages/GlobalRegex.svelte`; nav is visibility-gated                                                         |
| `10`       | `language`                     | `src/lib/Setting/Pages/LanguageSettings.svelte`                                                                                    |
| `11`       | `accessibility`                | `src/lib/Setting/Pages/AccessibilitySettings.svelte`; visible page title is **Interaction & Accessibility**                       |
| `12`       | `persona`                      | `src/lib/Setting/Pages/PersonaSettings.svelte`                                                                                     |
| `13`, `18` | `prompt`, `prompt-settings`    | Prompt-template editor and prompt-preset shell                                                                                     |
| `14`       | `modules`                      | `src/lib/Setting/Pages/Module/ModuleSettings.svelte`                                                                               |
| `15`       | `hotkeys`                      | `src/lib/Setting/Pages/HotkeySettings.svelte`                                                                                      |
| `17`       | `model`                        | Profile-first model settings                                                                                                       |
| `19`, `20` | `agent-presets`, `input-hooks` | `src/lib/Setting/Pages/AgentPresetSettings.svelte` and `src/lib/Setting/Pages/InputHookSettings.svelte`                            |
| `21`       | `request-history`              | `src/lib/Setting/Pages/RequestHistorySettings.svelte`                                                                              |
| `22`       | `source-code`                  | `src/lib/Setting/Pages/SourceCode.svelte`                                                                                          |
| `23`       | `bardwiki`                     | `src/lib/Setting/Pages/BardWikiSettings.svelte`                                                                                    |
| `77`       | `supporter`                    | `src/lib/Setting/Pages/ThanksPage.svelte` after the external-server warning when required                                          |

`/settings/memory` is canonical for the Memory page. `/settings/other-bots`
and `/settings/otherbots` remain compatibility aliases and are replaced with
the canonical URL after their route is applied. The visible nav,
`OtherBotSettings.svelte` heading, and Quick Settings button all say Memory.
Keep the shared route slug maps, `SettingsMenuIndex`, page branches, resource
surfaces, and nav conditions aligned.

The Memory page owns four inner tabs for long-term memory, TTS, emotion images,
and image generation. The long-term tab also owns legacy Hypa/lorebook behavior,
the emotion tab owns its global prompt/server overrides, and the image tab owns
the image-handling beta toggle. BardWiki is a separate Tools & Extensions item at
`/settings/bardwiki`; its lazy page edits the global defaults for enablement,
Hypa/BardWiki/Hybrid selection, confirmation policy, model/prompt owners,
canonical updates, and token/query/link limits. The page explains that automatic
confirmation and rebuild can make background provider calls and therefore incur
provider cost. Per-chat overrides belong to the active-chat workspace rather
than this global page; see
[BardWiki Memory](../../docs/structure/bardwiki.md#settings-and-workspace).

The Data group contains Backup & Restore plus Request History. The latter reads
private summaries/details through `src/ts/server/requestHistory.ts`; retention
persists through the server-backed `requestHistoryLimit` setting, and record
deletion uses the authenticated operational delete route. Its detail view keeps
RisuAI request metadata separate from additional non-content metadata returned
by the provider API.

Backup & Restore also mounts `src/lib/Setting/Pages/StorageUsage.svelte` for
server file totals, a colored category breakdown with expandable explanations,
and available disk capacity. It measures on entry and manual refresh, preserving
the previous measurement on refresh failure. The measurement scope and backend
owners are documented in
[Storage Usage](../../docs/structure/assets-and-saves.md#storage-usage).

The Source Code page groups the upstream RisuAI repository, this Fastify fork,
and PocketRisu/RisuBard feature references behind one short Advanced & About
navigation item. Dividers separate the three groups, and the repository cards
identify their relationship explicitly and open protected external links.

Lite mode removes Chat Setup, Capabilities, most Interface controls, and the
advanced/about group. Legacy global lorebook and regex navigation also remain
hidden in Lite. `showGlobalLorebookAndRegex` controls visibility, not execution
of imported legacy data; new global functionality belongs in modules.

The deprecated `enableRisuaiProTools` toggle lives in Advanced settings. It is
visible when unrecommended settings are shown or while Pro Tools is already
enabled, so existing users can turn it off. When set, the shell adds Easy Panel,
which opens the global `easyPanelStore` overlay rather than a routed settings
page. Plugin V3 can append settings menu items; plugin registration semantics
belong to [Plugins And MCP](../../docs/structure/plugins-and-mcp.md#ui-surfaces).

## Data-Driven Rows

`SettingItem` in `src/ts/setting/types.ts` is the schema contract. Its fields are
`id`, `type`, `labelKey`, `fallbackLabel`, `helpKey`, `helpUnrecommended`,
`showExperimental`, `deprecated`, `bindKey`, `bindPath`, `condition`, `options`, `keywords`,
`classes`, `containerClasses`, `componentId`, `componentProps`, `getValue`,
`setValue`, and `onChange`. `SettingContext` supplies `db`, `modelInfo`,
`subModelInfo`, and the optional `presetMirrorTarget`.

`SettingSection` groups leaf items by user intent without changing their IDs.
`src/lib/Setting/SettingsSections.svelte` renders ordinary groups as visible,
named regions and uses the shared accessible accordion only for advanced,
experimental, developer, or legacy groups. Page-level section arrays are not
the discovery catalog: `getFullSettingsData()` continues to flatten the leaf
arrays so settings search and saved Custom Sidebar IDs survive relocation.

`SettingRenderer.svelte` derives that context, evaluates `checkCondition`, and
looks up each row type in `settingRegistry`. Wrappers under
`src/lib/Setting/Wrappers/` adapt schema rows to primitives for check, text,
number, textarea, slider, select, segmented, color, header, button, accordion,
and custom types.

Complex rows escape through `src/ts/setting/customComponents.ts`. Its registry
contains `SeparateParametersSection`, `TranslatorPresetSettings`,
`BanCharacterSetSettings`, `CustomModelsSettings`, `SettingsExportButtons`,
`CustomSidebarConfig`, `ColorSchemeSelect`, `CustomColorSchemeEditor`,
`CustomTextThemeEditor`, `CustomBackgroundToggle`, `NullableTextColorToggle`,
`NotificationToggle`, and `FullscreenToggle`. Prefer a registered custom
component when a workflow cannot be expressed as one row; do not add conditional
page markup to `SettingRenderer.svelte`.

Common failure modes are a false `condition`, a missing registry entry, a stale
wrapper-local mirror, or a select/segmented value whose option became hidden.
`SettingSelect` and `SettingSegmented` can move to an explicit visible fallback;
do not assume an unavailable stored option will remain displayed.

## Settings Persistence

Settings authoring requires current writer capability. Managed readers see an
explanatory gate; helpers and deferred owner/lifecycle callbacks also fence the
originating client-session generation. Writer loss captures registered dirty
editor fields before unmount through `src/ts/server/writerDraftRecovery.ts`.
Those originating-session drafts remain separate from the canonical Reader
projection and encrypted pending commands; see
[Client Runtime](client-runtime.md#draft-recovery-stores).

`src/ts/setting/utils.ts` centralizes data-driven value binding.
`getSettingValue` reads from the composed resource projection, nested path, or
custom getter. `setSettingValue` applies the optimistic projection, runs the
local side effect, stages encrypted durable intent, and dispatches through the
explicit settings owner. Continuous controls are briefly delayed and coalesced
by `src/ts/server/settingsOwner.svelte.ts`.

While write authority is current, `src/ts/server/pendingOwnerMutationRegistry.ts`
lets navigation, structural actions, and page exit flush queued owner patches
before another operation can overtake them. Retryable failures retain durable intent and the optimistic
projection. Terminal or non-durable failures roll back only attempted fields
whose optimistic value is still current; accepted responses can adopt a
canonical server value.

Workflow components must distinguish `accepted`, `queued`, and `failed`.
Queued means retained intent, not server acceptance. The global saving icon
reads `src/ts/server/persistenceActivity.svelte.ts` and stays active for in-flight
work or this writer's queued outbox rows. Generic settings rows no longer add
short-lived Saving/Queued status rows; the stable icon and queued notifications
carry aggregate state. Workflow-specific surfaces can still render their own
progress, queue, and failure contracts. Individual editors own their
busy/disabled state and local failure message. The canonical mutation contract
is in
[Durable Mutations And Recovery](../../docs/structure/durable-mutations-and-recovery.md#durable-mutation-recovery-command-queue-and-local-acknowledgements).

`ModuleSettings.svelte` has separate reload-durable editor recovery in
`src/ts/server/moduleEditorDraftStore.ts`. It rebases a restored draft over the
latest module and offers copy/export/discard recovery when the target vanished.
The module library also renders the authoritative flat `moduleFolders`
settings projection. `src/ts/moduleOrganization.ts` groups modules without
sorting away persisted order and places missing/dangling assignments in a
virtual Uncategorized group. Folder CRUD/order and module move/order actions
dispatch through `src/ts/moduleCommands.ts`; search covers names and
descriptions and disables drag so a filtered DOM cannot become the submitted
complete order. Collapse state is device-local. The chat module picker reuses
the same grouping helper, starts named folders collapsed, and opens matching
groups while searching without changing activation state.
The editor also registers a dirty-leave guard: routed Settings navigation,
Quick Settings tab changes, history traversal, and browser unload warn only
after the draft differs from its opening snapshot. Leaving keeps the recovery
draft; explicit discard confirms before deleting it. These drafts are not
outbox commands; see
[Client Runtime](client-runtime.md#draft-recovery-stores).

Manual editors call `src/ts/setting/confirmSettingsItemRemoval.ts` before
deleting embedded rows. The shared confirmation covers prompt templates, input
hooks, custom models, Agent toggles/lorebook inputs, translator steps, module
rows, model fallbacks/key-value rows, and legacy stop/bias/parameter lists. A
canceled confirmation must leave the draft untouched;
`src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte.test.ts` is the
focused cancel/accept guard.

## Shared Controls And Focus

Primitives under `src/lib/UI/GUI/` own native labels, focus styling, disabled
state, keyboard behavior, and reusable sizing. Wrappers should pass accessible
names and state rather than rebuild a primitive's interaction model.

`TextAreaInput.svelte` combines highlighting, autocomplete, a context menu,
contenteditable mode, popup-editor launch, and cleanup. The popup editor
snapshots the device-specific `useMonacoEditorOnDesktop` or
`useMonacoEditorOnMobile` choice when it opens. Plain text is the default:
Monaco lazy-loads only when enabled, while disabled mode renders a full-size
textarea. The popup toolbar and Accessibility settings update the device
preference. `PopupEditor.svelte.test.ts` guards both modes.

`SliderInput.svelte` supports disabled sentinels, bounded typed numeric entry,
and touch-safe horizontal dragging without taking over vertical page pan.
Fullscreen is browser-session state rendered by `FullscreenToggle.svelte`, not
a persisted setting. Blocking drawers/dialogs should use the shared focus trap
and backdrop-dismiss actions described in
[Svelte UI](svelte-ui.md#app-render-priority).

`NotificationToggle.svelte` preserves the enabled preference when browser setup
fails and displays the shared `PushNotificationWarning.svelte` with a retry
action. App also shows that warning across routes. Cleanup/local inspection,
retry-storage, and retry-operation states remain available for intentional
disable failures. Device/server ordering
and its retry ledger belong to
[Client Runtime](client-runtime.md#push-notification-coordinator).

## Display And Theme Controls

Display has four purpose-based tabs: Theme, Layout & sizing, Chat appearance,
and Sound & notifications. The former Other bucket no longer exists. Custom
background belongs to Theme; fullscreen, height mode, sidebar columns, and
element sizing belong to Layout; message/quote/media presentation belongs to
Chat appearance; and completion audio, keep-session-alive, and push controls
belong to Sound & notifications. Custom CSS is a collapsed advanced-appearance
section, while the legacy-GUI switch is under Advanced compatibility.

`src/ts/setting/displaySettingsData.svelte.ts` registers `ColorSchemeSelect` as
a custom row. `src/lib/Setting/Pages/Display/ColorSchemeSelect.svelte` renders
every preset as a labeled, keyboard-focusable palette card with a conic color
wheel and `aria-pressed` selection. The custom card previews
`Database.customColorScheme`, falling back to `defaultColorScheme` only when the
durable object is absent. Selecting custom reveals the registered
`CustomColorSchemeEditor`.

`displayNonRendererServerSettingKeys` explicitly includes `colorScheme`,
`colorSchemeName`, `customColorScheme`, background, and custom text theme, so
custom controls and page watchers own those durable writes instead of ordinary
row wrappers. CSS variable application and root layout belong to
[Svelte UI](svelte-ui.md#styling-theme-and-layout).

## Agent And Prompt Authoring

Agents and Agent Presets are manual settings UI.
`src/lib/Setting/Pages/AgentPresetSettings.svelte` hosts
`AgentSettingsSection.svelte`, `AgentEditorDrawer.svelte`, and
`AgentPresetEditorDrawer.svelte`. `src/ts/agents.ts` owns Agent and preset-use
mutations; `src/ts/agentPresets.ts` owns preset-row mutations. The surface
creates, edits, duplicates, deletes, and reorders records; chooses the global
default; attaches existing Agents; and shows status, save, and queued/failure
feedback.

The Agent editor exposes instructions, prepared-input scopes, output format,
toggle definitions, Agent-only lorebook inputs, and model/runtime defaults. It
names selected CBS inputs and can validate role-tagged ChatML before save.
Preset-use editing exposes phase, dependency/output wiring, destination,
failure policy, model/runtime overrides, module integration, and final-output
CBS text. `src/lib/SideBars/LoreBook/LoreBookData.svelte` owns Agent-only entry
controls and disables ordinary activation controls for those entries.
`packages/shared-core/src/agentOnlyLorebook.ts` identifies the marker, while
`packages/shared-core/src/agentLorebookInputs.ts` validates the supported runtime
shape. `src/ts/agentLorebookInputs.ts` adapts those records for browser-side
Original Risu export.
There is no generic port-mapping editor: prepared-input scopes, Agent toggles,
Agent-only lorebook inputs, module references, and the final-output template
with `{{slot::mainOutput}}`/`{{agent::outputKey}}` are the bounded authoring
surface.

`src/lib/SideBars/ChatGenerationSettingsControls.svelte` persists the active
chat's `agentPresetId`. The Diagnostics panel lazily hydrates chat history only
when opened. Its filtering is now owned by
`src/ts/agentPresetDiagnostics.ts`, which reads
`Message.generationInfo.agentPreset`, filters by stable preset ID, and returns a
bounded newest-first history for
`src/lib/Setting/Pages/AgentPresetDiagnosticsPanel.svelte`.
`src/ts/router.ts` explicitly treats the removed `/settings/context-agent`
route as not found; it is not a compatibility alias, and
`src/ts/router.test.ts` guards that removal.

Keep editor/status/persistence behavior here. Record normalization, reference
resolution, planning, execution, completeness, and diagnostic payload meaning
belong to
[Agents And Presets](../../docs/structure/agents-and-presets.md).
`AgentPresetProgress.svelte` is a chat surface and is documented in
[Chat UI](svelte-chat-ui.md#generation-and-loading-states).

Prompt work is split across indexes `13` and `18`.
`PromptSettings.svelte` edits prompt-template rows for the selected modern
prompt preset; `BotSettings.svelte` owns template enablement; and the prompt
branch of `botpreset.svelte` owns preset list actions. Duplicate hydrates and
clones the whole prompt preset with a new top-level ID and Copy name; it does
not duplicate one template row in place. Archived prompt presets remain valid
references and are partitioned only in the picker. Legacy bot-preset prompt
templates remain compatibility UI for old saves and explicit extraction paths.
`src/lib/Setting/pickerGenerationSettings.test.ts` guards the whole-preset
duplicate behavior. Prompt assembly and CBS semantics belong to
[Prompt Assembly And Scripting](../../docs/structure/prompt-assembly-and-scripting.md).

`showGlobalLorebookAndRegex` is defined in
`src/ts/setting/advancedSettingsData.ts`. It gates the two legacy navigation
entries but does not disable imported legacy data. Visibility and defaults are
guarded by `src/lib/Setting/Settings.svelte.test.ts`,
`src/ts/setting/advancedSettingsData.test.ts`, and
`server/fastify/__tests__/databaseDefaults.test.ts`.

## Input-Hook Authoring

`src/lib/Setting/Pages/InputHookSettings.svelte` owns Draft and BTW definitions
through a server-backed `inputHooks` draft. Each row edits name, type, prompt,
and model. The model select inherits the `otherAx` role when blank or stores a
specific durable model-profile ID; divider options render as `---` and restore
the prior selection rather than becoming a model.

Draft rows additionally expose the Translation checkbox. The UI owns that
choice and the reviewed-Draft presentation; model resolution, slots, history
windows, Translation semantics, and hook execution are canonical in
[Translation And Input Hooks](../../docs/structure/translation-and-input-hooks.md).
Chat selection and review controls are in
[Chat UI](svelte-chat-ui.md#input-hook-chat-controls).

## Model Profiles And Provider Panels

`src/lib/Setting/Pages/Model/ModelSettingsShell.svelte` opens on Models and owns
conversion, Model assignments, API keys & accounts, and Advanced Legacy Settings.
The Model assignments tab uses
`src/lib/Setting/Pages/Model/ModelProfileRoleList.svelte` to edit
`Database.modelRoleProfiles`. Valid changes apply automatically, and each role
shows binding mode, inherited source, effective model, and provider. Internal
IDs, Ready status, and zero fallback counts are hidden; actionable status reasons
and configured fallbacks remain visible.

The Models tab uses
`src/lib/Setting/Pages/Model/ModelProfileList.svelte` to present
`Database.modelProfiles` and profile create/edit/duplicate/delete actions.
Compact rows open the editor directly and hide internal IDs and routine Ready
status. `ModelItemActions.svelte` discloses duplicate/delete actions, closes on
outside pointer or focus movement, and returns focus to its trigger on Escape.
Before dispatching a
delete, the UI checks every Model Preset role-binding snapshot and blocks a
referenced profile; role bindings are explicitly reassigned on an allowed
delete. The server's authoritative deletion guard remains provider/runtime
owned.

The profile list uses one handle-based Sortable instance for mouse, pen, and
touch. Shared `internalReorderSortableOptions` forces the fallback path for all
pointer types; both profile cards and divider rows expose the same dedicated
drag handle. `Database.modelProfileOrder` interleaves durable UX-only dividers
with profiles. Dividers render as `---`, participate in the same reorder, and
are restored rather than selected in profile dropdowns. Pending profile
mutations disable sorting.

`src/lib/Setting/Pages/Model/ModelProfileEditorDrawer.svelte` and
`src/lib/Setting/Pages/Model/ModelProviderPanel.svelte` own provider,
credential, model, request-model, and visible provider-option controls. The
first-class panels are OpenAI, LLM Gateway, Neuralwatt, Anthropic, Google,
Vertex, Ollama, Custom API, and Debug Echo. Neuralwatt uses the catalog-backed
model grid. Connection setup is expanded for creation and collapsed for editing;
the provider panel separates setup fields from advanced provider options.
`ModelGenerationSettings.svelte` keeps maximum response, context limit, streaming,
and half streaming visible, showing effective inherited values and explicit
per-model overrides. Other runtime options and fallbacks are under Advanced.
The model editor states that edits affect every use of the saved model.

`src/lib/Setting/Pages/Model/ProviderCredentialList.svelte` owns credential list
presentation and profile-reference deletion checks. `ProviderCredentialEditor.svelte`
shares credential creation/editing and masked-secret rotation between that list
and inline model setup. Inline creation preserves the model draft and selects a
new key only once its server-generated ID appears in the credential projection.
Queued creation stays pending until the matching projection arrives or replay is
discarded; it never adds a raw secret to the model profile.
`packages/shared-core/src/providerCredentialRecords.ts` owns
credential schema/projection normalization; durable credential and profile
mutation helpers live in `src/ts/model/modelProfileMutations.ts`.

Model and prompt preset application operates on the masked resource projection.
`src/ts/storage/database.svelte.ts` therefore normalizes projected credentials
without replacing their preserved masked values; preset selection must not be
treated as a raw credential import. The server-side credential contract is in
[Providers And Models](../../docs/structure/providers-and-models.md#provider-credentials).

`src/lib/Setting/Pages/Model/ModelRuntimeDefaultsEditor.svelte` edits
`Database.modelRuntimeDefaults` with explicit Edit/Save/Cancel/Reset from a
compact control above the saved model list. It uses the same common generation controls and an Advanced
section. `resolveModelRuntimeDefaults()` in the shared resolver supplies the
canonical built-in/global defaults in stored units without reading legacy flat
settings. `ModelRuntimeOptionsEditor.svelte` keeps Strip CoT as a default checkbox
or an inherit/enable/disable profile override. Legacy `BotSettings.svelte` shows
half-streaming only where its compatibility model supports streaming.

`src/lib/Setting/Pages/Model/ModelPresetList.svelte`, embedded by
`src/lib/Setting/botpreset.svelte`, owns the Model Preset list and its current
role-snapshot actions. Compact rows show the name, Main Chat/Auxiliary summary,
and an explicit selected marker. `ModelItemActions` exposes rename, duplicate,
reorder, details, and delete; IDs, binding counts, and stored-field metadata appear
only in details. Preset action menus use viewport positioning to remain reachable
outside the dialog's scroll area. Missing-model warnings, broader model-setting changes, prompt
overrides, and mutation feedback remain visible. Creation and rename use explicit
Save/Cancel forms and retain their drafts while saving or queued, and on failure.
The Model assignments launcher labels the selected model preset and its Change
action. NanoGPT compatibility/account UI remains in
`src/lib/Setting/Pages/BotSettings.svelte` with
`src/lib/UI/NanoGPTDashboard.svelte` and
`src/lib/UI/NanoGPTProviderPicker.svelte`; the dashboard fetches balance and
subscription state, while the picker fetches provider metadata for its filtered
selection UI.

Advanced Legacy Settings embeds
`src/lib/Setting/Pages/Model/ModelRoleList.svelte`. It is hidden after every
role resolves from a durable profile, including supported inherited bindings;
legacy-inherit keeps it visible. `packages/shared-core/src/modelProfileRecords.ts`
normalizes profile records, role bindings, runtime defaults, credential
references, provider options, and fallbacks.
`src/ts/model/modelProfileUiState.ts` maps resolved state to the summaries and
visibility used by these pages. Effective resolution and readiness live in
`packages/shared-core/src/modelProfileResolver.ts` and remain canonical in
[Providers And Models](../../docs/structure/providers-and-models.md).

The same page exposes `adv.regexOutputSizeLimitMiB`, a durable numeric control
for regex `OUT` replacements and generated results. It defaults to 16 MiB and
accepts 1-64 MiB. Increasing it improves compatibility with large legacy
scripts at the cost of additional memory exposure; pattern and source limits
remain fixed.

Model Settings has a collapsed Advanced model behavior section for global
compatibility controls that do not belong to an individual profile. It includes
the experimental OpenAI Flex Processing checkbox (`adv.openAIFlex`) bound to
the durable `openAIFlexProcessing` field, global request retry/generation
limits, vision quality, and the legacy custom-model editor.
This global control is separate from an LLM Gateway profile's service-tier
select, whose valid values also include `flex`; do not conflate the two UI
contracts. Provider applicability, request options, and runtime behavior belong
to
[Providers And Models](../../docs/structure/providers-and-models.md).

Advanced itself is organized into Feature access, Performance & media,
Requests & response handling, Scripting & regex, Developer diagnostics,
Experimental, and Legacy & compatibility. The last four rare/risky groups use
collapsed disclosure. Translation-only options live on Language, plugin
development/compatibility lives on Plugins, global prompt behavior lives in the
Prompt Settings tab, and navigation behavior lives under Interaction &
Accessibility.

## Focused Tests

Shell, renderer, and authoring guards include
`src/lib/Setting/Settings.svelte.test.ts`,
`src/lib/Setting/SettingRenderer.svelte.test.ts`,
`src/lib/Setting/SettingsSections.svelte.test.ts`,
`src/lib/Setting/Pages/SourceCode.svelte.test.ts`,
`src/lib/Setting/Wrappers/SettingAccordion.svelte.test.ts`,
`src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts`,
`src/lib/Setting/Pages/InputHookSettings.svelte.test.ts`,
`src/ts/agentLorebookInputs.test.ts`, and
`src/lib/Setting/pickerGenerationSettings.test.ts`.

Model UI guards include
`src/lib/Setting/Pages/Model/ModelProfileRoleList.svelte.test.ts`,
`src/lib/Setting/Pages/Model/ModelProfileList.svelte.test.ts`,
`src/lib/Setting/Pages/Model/ProviderCredentialList.svelte.test.ts`,
`src/lib/Setting/Pages/Model/ModelProfileEditorDrawer.svelte.test.ts`,
`src/lib/Setting/Pages/Model/ModelGenerationSettings.svelte.test.ts`,
`src/lib/Setting/Pages/Model/ModelProviderPanel.svelte.test.ts`, and
`src/lib/Setting/Pages/Model/ModelRuntimeDefaultsEditor.svelte.test.ts`.

Persistence and primitive-control guards include
`src/lib/Setting/Pages/PluginSettings.svelte.test.ts`,
`src/lib/Setting/Pages/Module/ModuleSettings.svelte.test.ts`,
`src/lib/Setting/Pages/RequestHistorySettings.svelte.test.ts`,
`src/lib/UI/GUI/TextAreaInput.svelte.test.ts`,
`src/lib/UI/GUI/TextAreaResizable.svelte.test.ts`,
`src/ts/setting/displaySettingsData.svelte.test.ts`, and
`src/ts/setting/settingsPageSections.test.ts`, and
`src/ts/setting/utils.test.ts`. The visible-state policy is canonical in
[Testing And Operations](../../docs/structure/testing-and-operations.md#visible-state-test-contract).
