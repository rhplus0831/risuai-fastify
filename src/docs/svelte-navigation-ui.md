# Svelte Navigation UI Guide

Last audited: 2026-08-27.
Targeted source check: 2026-09-09 (shared conversation-shell geometry and role-transition motion policy).

This guide owns the sidebar, navigation controls, character and chat selection,
character configuration, and list organization.
Return to the [architecture index](../../docs/structure/README.md) for
cross-layer ownership or the [Svelte UI guide](svelte-ui.md) for application
routes and shell priority.

## Fast Triage

| Symptom                                                                | Inspect first                                                                   | Then inspect                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Sidebar route, tab, character, folder, or grid button is wrong         | `src/lib/SideBars/Sidebar.svelte`                                               | `src/ts/router.ts`, `src/ts/stores.svelte.ts`                                  |
| Reader selection, missing-chat fallback, or Use this device is wrong   | `src/lib/Workspace.svelte`, `SideBars/ReaderNavigation.svelte`                  | `src/ts/readerRouteScope.ts`, `src/ts/bootstrap.ts`, `src/ts/clientSession.ts` |
| Chat list, chat folder, branch graph, or export/reset flow is wrong    | `src/lib/SideBars/SideChatList.svelte`                                          | `src/ts/chatCommands.ts`, `src/ts/server/chatMessageHydration.svelte.ts`       |
| Character profile, media, lorebook, scripts, or TTS editor is wrong    | `src/lib/SideBars/CharConfig.svelte`                                            | The focused bridge/upload helper under `src/ts/server/`                        |
| Character/chat reorder is stale, duplicated, or treated as file import | `src/lib/SideBars/sidebarDrag.ts`, `SideChatList.svelte`, `src/ts/dragTypes.ts` | [Drag, Drop, And Reordering](#drag-drop-and-reordering)                        |

## Sidebar And Route Ownership

`src/lib/SideBars/Sidebar.svelte` owns the writer's desktop navigation: home, settings, and
Playground buttons; character avatars and folders; character organization;
grid opening; quick settings; developer tools; and the switch between the chat
list and character configuration. It consumes `selectedCharID`, `settingsOpen`,
`sideBarStore`, `DynamicGUI`, `PlaygroundStore`, `botMakerMode`, and
`CharEmotion` plus route and command helpers.

The narrow rail also renders durable pinned-chat shortcuts below its menu
button. `sidebarMultitasking.ts` derives those shortcuts from chat metadata and
aggregates local plus bootstrap-discovered generation activity by stable chat
id. A bot avatar shows one generation indicator when any owned chat is active;
a collapsed character folder shows one aggregate indicator regardless of how
many contained bots are active. Route navigation remains available while those
generations continue in the background. Exhausted observers take priority over
the healthy spinner and use a warning treatment on pinned chats, character and
collapsed-folder aggregates, and the exact row in `SideChatList.svelte`.
Completed background replies add a session-scoped unread marker keyed by stable
chat ID. The marker appears on chat rows and pinned chats and aggregates onto
character avatars and collapsed character folders. Opening the chat or moving
its transcript to the latest message clears it; warning and active-generation
states take visual priority while they are present.

`sidebarChatProjection.svelte.ts` shares validated chat metadata across pinned
shortcuts and status badges. It reads only sidebar display fields and chat
identities; changing chatPage or message bodies does not rebuild the projection.
Generation, warning, and unread states each derive one set of character indexes,
so individual badges and folder aggregates avoid repeating global chat scans.

`ConversationShell.svelte` owns the role-neutral outer flex frame, navigation
slot, main-content column, and responsive dialog semantics. On wide layouts
`src/App.svelte` supplies the writer sidebar beside chat. On responsive layouts
the shell mounts it as a focus-trapped dialog when `sideBarStore` is open;
Escape closes that dialog. `shellGeometry.ts` normalizes the shared 1024-pixel
boundary, one-to-four desktop or one-to-two mobile rail columns, and the
24/28/32/36-rem panel sizes. Route/store synchronization and history ownership
belong to [Svelte UI](svelte-ui.md#routes-and-stores).

`sideBarTransitionCause` separates explicit open/close requests from automatic
mount, startup, role resolution, promotion, demotion, reconnect, and recovery.
Only explicit requests attach the rail, panel, and backdrop entry/exit animation
classes. The settled writer geometry remains the canonical layout; automatic
role changes establish it immediately.

Character routes without a chat ID show the list/selection state; routes with a
chat ID put `SideChatList.svelte` into chat-open mode. The latter shows back,
author-note, and generation-toggle controls and tears down list Sortable
instances until the route returns to the chat list. The selected character tab
is stored on the exact history entry through `src/ts/router.ts`.

## Connected Reader Navigation

`Workspace.svelte` retains the connected reader controller and supplies it to
the same persistent `ConversationShell.svelte` frame as the writer. It also uses the
same presentation primitives as the writer: `NavigationRail.svelte`,
`NavigationButton.svelte`, `SidebarAvatar.svelte`, `PinnedChatsRail.svelte`,
`ChatSelectionButton.svelte` and `CharacterCatalogView.svelte`. The writer
`Sidebar`, `SideChatList` and `GridCatalog` adapters retain organization commands,
editor owners and pending outcomes. These shared views accept explicit display
inputs, selected IDs and callbacks; they do not fall back to writer stores.

`ReaderNavigation.svelte` consumes certified rows, character order and display
settings from `readerTranscriptProjection.svelte.ts`, including confirmed
`sideBarSize`, `desktopSidebarColumns`, and `mobileSidebarColumns`. The reader
and writer call the same geometry resolver and use the same responsive
classification; pending writer settings never enter the reader adapter.
`readerNavigation.ts`
filters ambiguous/missing identities, orders active characters and derives pins
from shell summaries or hydrated details. Folder expansion, character/chat
search, grid/list presentation and drawer state stay local. Auth/database
identity changes clear that state; reconnect keeps valid reading navigation.
When a reader chat is open, only the Back branch is interactive; an inert rail
spacer preserves the canonical desktop width. On responsive screens the hidden
reader drawer stays mounted so search/folder
state survives ordinary open/close cycles; `modalFocusTrap` activates only
while it is visible and retains Escape dismissal and focus restoration.

Home/grid and stable character/chat routes do not update `selectedCharID`,
`currentChar` or persisted `chatPage`. Settings, plugin panels and authoring
controls are disabled with localized reasons. In-app restricted navigation,
shortcuts and writer route warming reject reader activation. Direct restricted
URLs show a shared-shell write-access gate with Home and a valid Return to
reading action. Only valid reading routes become `readerRouteIntent.ts`
promotion intent; blocked pages cannot reopen an old restricted surface. The
writer chat list loads Toggles lazily behind current authority and session
checks, keeping its Settings renderer dependencies out of reader startup.

While an asynchronous writer route is loading, newer navigation takes precedence
over a retained reader route with a different semantic route key. App consumes
only that superseded intent's sequence; equivalent URL aliases and a failed
application keep their matching retry intent. Each route effect fences its
completion by its own lifetime, so an older successful handler cannot replace
the newer visible route or consume a later intent. Startup's `background-ready`
milestone does not mean the initial route handler has finished.

During unresolved automatic writer startup, the workspace stays behind the
loading boundary. `canUseClientReaderContent()` admits character-detail reads,
transcript mounting, and missing-route repair only after a reading or writing
disposition has settled.

`readerRouteScope.ts` resolves only unique character/chat identities from the
certified reader projection. A shell triggers a fenced detail read. An
interrupted or failed resource read is not evidence of deletion: only a current
authoritative missing character returns to the browser, and a missing chat
chooses an available unique chat in the same character or its chat list.
Ambiguous identities remain unavailable instead of selecting the first match.
`ReaderTranscript.svelte` owns the selected transcript and generation viewer;
its read-only rendering contract is in
[Svelte Chat UI](svelte-chat-ui.md#connected-reader-transcript).

`DeviceAccessAction.svelte` owns the one explicit **Use this device** action,
read-only badge, lifecycle announcement, and operation result. It stays at the
safe-area-aware top-right of the visual workspace and becomes icon-only on
small screens. `ReaderTranscript.svelte` reserves matching header clearance;
the contained disabled composer is a separate pure presentation component.

The action is available only from a connected reader, shares an in-progress
attempt, and keeps reading/local navigation available while takeover
confirmation is pending. Cancellation, supersession, interruption, and
retained-work recovery failures have distinct localized feedback. A successful
acquisition still waits for fenced writer recovery before mutation controls
become usable; plugins, effects, and chat dependencies additionally gate
generation. Reconnect and ordinary reader navigation do not request takeover.

A demoted writer returns to the reader surface with its local route and captured
editor/composer drafts retained. `WriterDraftRecovery.svelte` exposes those
local copies without presenting them as committed messages or replaying them
from the reader. Ownership discovery and recovery belong in
[Client Runtime](client-runtime.md#startup-sequence).

## Character Folder Opening

Character folders carry an optional durable `askBeforeOpening` flag in
`characterOrder`. `Sidebar.svelte` exposes the flag through the folder context
menu and gates both direct expansion and automatic expansion used to scroll to
the selected character.

`src/ts/characterFolderOpening.ts` remembers successful confirmations by stable
folder ID in module memory. Cancellation leaves the folder closed and does not
record approval. Closing and reopening an approved folder is immediate until a
full page refresh creates a new module lifetime. Concurrent attempts for one
folder share the same confirmation.

Tests include `src/ts/characterFolderOpening.test.ts`,
`src/lib/SideBars/Sidebar.keyboard.dom.test.ts`,
`src/lib/SideBars/Sidebar.charList.test.ts`, and
`src/ts/characterCommands.test.ts`.

## Chat Lists And Folders

`src/lib/SideBars/SideChatList.svelte` owns selecting, creating, deleting,
forking, importing, and exporting chats; chat folders; chat/folder names;
reordering; persona binding; and server-backed metadata watchers. Persona
binding writes the authoritative `generationSettings.personaId` through the
generation-settings save queue; legacy `bindedPersona` is compatibility input,
not a second writable selection. Stable chat and folder IDs are the
organization keys. The component surfaces pending, queued, and failed
structural operations and blocks conflicting actions while an operation is
pending.

Folder folding/color/name and chat renaming capture only the affected previous
and attempted metadata fields plus stable owner IDs through
`captureChatFolderMetadataPatch()` / `captureChatMetadataPatch()` in
`src/ts/chatCommands.ts`. The compact `src/lib/Others/ChatList.svelte` rename
path uses the same contract. Direct outcome dispatchers reuse the existing
pending-attempt, writer-loss, and projection-epoch rollback fences, preserving
newer edits and authoritative refreshes without copying resident histories.

Create/delete/folder/order/fork/reset/import actions use distinct typed captures
from the same command owner. Reorders keep IDs and assignments and preserve
surviving row/message identities. Delete/reset retain only removed rows, so
pending changes to detached rows survive rejection; capture-time projection
epochs fence rollback across awaited note flushing and authoritative refreshes.
Deletion binds its selected-chat effect before flushing, preserving navigation
that occurs during the wait.
Forks own the new transcript and supplied source metadata. Import baselines hold
identities/selection while failed suffix rollback preserves accepted prefixes.

Its derived grouping preserves source order and each chat's original array
position. Selection normally navigates to the stable character/chat route. A
provisional create/delete flow repairs the route only if the captured route and
selection still belong to that operation.

Export All strictly hydrates every chat before downloading. Only after a
successful, still-current export does the UI offer two confirmations to replace
all chats with an empty `Chat 1`. The optimistic durable reset preserves chat
folders, routes the still-current view to the replacement, and rolls back on
failure. Canceling, a failed export, or a changed export fence leaves chat
structure unchanged. Guards are `SideChatList.svelte.test.ts`,
`src/ts/characters.exportChat.test.ts`, and `src/ts/chatCommands.test.ts`.

The branch-graph action also strictly hydrates every chat and abandons its
result if the character owner changes. It passes a read-only graph of hashed
greetings and message prefixes from `src/ts/gui/branches.ts` to
`AlertComp.svelte`; branch details appear on pointer hover and keyboard focus.
`AlertComp.dom.test.ts` covers the dialog surface.

## Chat-Scoped Generation Controls

### Owner Readiness And Toggle Preservation

In chat-open mode, `ChatGenerationSettingsControls.svelte`, `Toggles.svelte`,
and `src/ts/activeChatGenerationSettings.ts` own the chat-local settings UI.
Optimistic saves serialize per chat and expose pending/queued/failed state; a
freshness guard prevents a different character projection from rolling back the
visible value while a save settles. Runtime overlay resolution belongs to
[Prompt Assembly And Scripting](../../docs/structure/prompt-assembly-and-scripting.md).

Toggle reconciliation has an additional readiness contract:

1. `resolveActiveChatGenerationSettings()` exposes
   `sidebarToggleDefinitionsReady` only when the character, persona,
   prompt-preset, module, Agent configuration, and module-settings owners are
   available and the active character/chat resolves. An empty projection during
   hydration does not prove that its toggle definitions were removed.
2. `ensureActiveChatSidebarToggleDefaults()` and module-command default filling
   wait for that readiness. Automatic reconciliation only adds missing defaults;
   it never prunes saved values. Explicit save paths may prune stale keys only
   after definitions are ready.
3. `readChatGenerationSettingsWrite()` in
   `server/fastify/src/commands/chats.ts` checks both full and sparse writes
   against authoritative post-update activation. It rejects removal of an
   existing value whose toggle is still required.

Regression owners: `src/ts/activeChatGenerationSettings.test.ts`,
`src/lib/SideBars/chatGenerationSettingsControls.test.ts`, and
`server/fastify/__tests__/commands.test.ts` (delayed Persona-module hydration
and required-value removal).

### Saved Toggles Presets

Saved Toggles uses `ChatGenerationTogglePresets.svelte` and the app-hosted
`ChatGenerationTogglePresetDialog.svelte`. The state caption distinguishes
unused, unlinked, shape-mismatched, edited, and matched presets. Selecting a row
changes only the comparison target until the user applies or selects it. The
dialog supports save/overwrite, rename, delete, unselect, apply, and compatible
value picking. Its display order is frozen when the dialog opens, then sorted by
toggle-key-set similarity, active-count distance, `updatedAt`, and name. The
selected ID persists in `generationSettings.togglePresetId`, and loadout
capture/apply in `src/ts/loadout.ts` preserves it. Record normalization and
comparison logic live in
`packages/shared-core/src/chatGenerationTogglePresetRecords.ts`; browser state
and commands live in
`src/ts/chatGenerationTogglePresets.ts`; focused guards are
`src/ts/chatGenerationTogglePresets.test.ts` and
`src/lib/SideBars/chatGenerationSettingsControls.test.ts`.

`ChatTranslationSettings.svelte` owns the active chat's automatic translation,
bot-only, and bilingual controls. Translation execution belongs to
[Translation And Input Hooks](../../docs/structure/translation-and-input-hooks.md).
`LoadoutModal.svelte` exposes selective apply and outcome states; its fenced
sequence belongs to [Client Runtime](client-runtime.md#loadout-apply-sequencing).

## Character Selection And Configuration

The add-character flow selects a successfully imported character only while
its captured navigation scope remains current. Import normalization in
`src/ts/characterCards.ts` supplies a missing chat `fmIndex` from the
character's `firstMsgIndex`, falling back to `-1`, so the first selected chat
can render its greeting. Guards are
`src/ts/characterCards.pngImport.svelte-node.test.ts` and
`src/ts/characters.changeChar.test.ts`.

`src/lib/SideBars/CharConfig.svelte` owns profile, icon/view/media, advanced,
scripts, TTS, lorebook, import/export, and character deletion surfaces. Its
server-backed profile draft is created synchronously before initial render:
`createCharacterOwnerDraft()` reads the current selected character owner and
clones the requested fields before installing reactive synchronization. The
first frame therefore reflects the server projection rather than empty control
defaults. `CharConfig.svelte.test.ts` includes an initial-draft rendering guard.

Profile edits, chat metadata, script definitions, and uploaded media use
separate focused bridges and freshness guards under `src/ts/server/`. Keep
script definitions outside the profile draft, and capture character/field
identity before any asynchronous picker, upload, or provider operation.

Character script/trigger editor activity is held in a 300 ms trailing draft
before cloning or durable dispatch. Leaving the editor flushes the draft;
display activation waits for final acceptance, while generation blocks on a
queued or failed immediate save. The cross-layer persistence and display rules
are canonical in
[Prompt Assembly And Scripting](../../docs/structure/prompt-assembly-and-scripting.md#intermediate-display-processing).

`src/ts/hotkey.ts` mixes live store/modal state with DOM class selectors for
visible controls. A markup or class-name change can therefore break keyboard
actions even when the routed state is correct; verify both the visible target
and its selector when changing navigation controls.

## Drag, Drop, And Reordering

`src/ts/dragTypes.ts` defines MIME markers for internal reorder surfaces. The
`src/App.svelte` root marks any drag that bubbles from inside the app with
`application/x-risu-app-internal-drag`; feature owners add their narrower
marker. The app-level importer ignores either the general internal marker or
`application/x-risu-sidebar-drag` before looking for files. External `Files`
drags remain available to import. `src/App.routeEffect.dom.test.ts` and
`src/ts/dragTypes.test.ts` guard this boundary.

Character and folder organization in `Sidebar.svelte` uses native drag events.
`sidebarDrag.ts` captures both the source position and a structural signature of
`characterOrder`; a drop is rejected if the live structure changed or the
source position disappeared. Only the sidebar MIME marker enables its drop
zones. Avatar-to-avatar drops create folders, while root/folder drop zones call
the command-backed movement helpers. Organization is disabled during an active
mutation. `dropList.ts`, `sidebarCharList.ts`, and folder rendering keep the DOM
projection aligned with the durable order.

Keyboard and menu organization must use the pure movement/position resolvers in
`sidebarOrganizer.ts`, not reproduce pointer math.
`Sidebar.keyboard.dom.test.ts`, `sidebarOrganizer.test.ts`, and
`sidebarDrag.test.ts` cover both access paths.

Chat and chat-folder reordering in `SideChatList.svelte` uses Sortable instances
for each chat group plus the folder list. On drop it reconstructs order from
stable DOM IDs, rejects missing, duplicate, or unknown IDs, preserves the
selected chat by ID, and dispatches chat order/folder assignments together. A
conflicting or stale drop destroys and rebuilds the Sortable projection instead
of persisting DOM order. The instances are destroyed while a concrete chat
route is open and recreated only for a current list generation.

These reorder flows are optimistic command mutations. UI code must retain
queued intent, roll back terminal failure, and allow resource reconciliation to
replace the projection. The command/outbox contract is canonical in
[Durable Mutations And Recovery](../../docs/structure/durable-mutations-and-recovery.md#durable-mutation-recovery-command-queue-and-local-acknowledgements).

## Focused Tests

Start with `src/lib/SideBars/SideChatList.svelte.test.ts`,
`src/lib/SideBars/Sidebar.keyboard.dom.test.ts`,
`src/lib/SideBars/sidebarOrganizer.test.ts`,
`src/lib/SideBars/sidebarDrag.test.ts`,
`src/lib/SideBars/chatGenerationSettingsControls.test.ts`,
`src/lib/SideBars/CharConfig.svelte.test.ts`, and the narrower colocated tests
under `src/lib/SideBars/`. The visible-state policy is canonical in
[Testing And Operations](../../docs/structure/testing-and-operations.md#visible-state-test-contract).
