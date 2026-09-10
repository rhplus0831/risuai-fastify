# UI/UX Improvement Plan

Status and implementation cursor: [status.md](status.md). Bounded work: [phases](phases/README.md).

## Outcome

Improve the reviewed navigation, Agent Preset, Input Hook, and BardWiki surfaces so users can tell what will happen, understand why an action is unavailable, recover from risky operations, and complete the same work at compact widths or with keyboard and zoom use.

The work is complete when:

- effective versus configured state is visible before generation or save;
- destructive actions disclose their target and consequences and retain the existing rollback/retry guarantees;
- the writer sidebar is unmistakably a modal drawer on responsive screens, row actions are touch-sized and consolidated, and nested chats are easy to scan;
- Agent and Preset authoring provides actionable token/reference guidance without weakening shared runtime validation;
- the BardWiki empty, override, import, rebuild, and activity states form coherent workflows;
- the reviewed surfaces pass focused DOM tests, a real-browser viewport matrix, keyboard/focus checks, 200% reflow review, and expanded contrast checks.

## Scope

In scope:

- writer navigation rail and chat sidebar at the reviewed 550×775 and 655×691 viewports;
- Agent library, Agent Preset list, Agent editor, Preset editor, and preset-use rows;
- Input Hook settings presentation and existing autosave/delete guarantees;
- the chat-scoped BardWiki workspace;
- shared buttons, popup actions, authoring controls, status presentation, localization, and theme tokens only where the reviewed surfaces need them;
- focused component, shared-core, server command, and browser coverage required by these changes.

Out of scope:

- a new visual brand or wholesale settings redesign;
- changing Agent execution order, provider dispatch, prepared-input collection, BardWiki storage, or deletion wire contracts;
- making currently valid no-op Agent records invalid;
- restoring the retired reference-only root grid or image-only destinations;
- unrelated settings, chat transcript, provider, plugin, or memory redesigns;
- claiming external production behavior from local tests.

## Reconciled Baseline

The screenshot report includes both real gaps and interaction hypotheses that current source already addresses. Implementation must preserve the latter instead of rebuilding them.

| Review area | Disposition | Current baseline or remaining gap |
| --- | --- | --- |
| Responsive sidebar | Partial gap | `ConversationShell.svelte` already renders responsive navigation as an `aria-modal` dialog, and `Sidebar.svelte` supplies a scrim close target. The width, scrim clarity, explicit visible close action, and action density remain concerns. |
| Navigation identity | Partial gap | `NavigationButton.svelte`, `SidebarAvatar.svelte`, and chat actions already have accessible names/tooltips. Missing-image visual fallbacks, truncated full-name access, rail continuation cues, and selected hierarchy still need work. |
| Chat and folder deletion | Preserve and refine | `SideChatList.svelte` already confirms deletion and preserves optimistic rollback. The compact placement and visual separation of Delete remain poor. |
| Agent Preset status | Active gap | `statusForPreset()` reports **Ready** for a valid plan with zero enabled Agent uses. Composition emptiness and runtime validity need separate presentation. |
| Preset deletion | Active gap | Browser and server code already clear the global default plus matching chat/loadout references and return counts. `deletePreset()` exposes only a generic confirmation and discards the consequence summary. |
| Agent deletion | Partial gap | Agent deletion is disabled when a preset uses the Agent and the server independently rejects unsafe deletion. The UI does not explain the dependency or link users to it. |
| Agent editor | Active gap | Name/model/ChatML/definition constraints and modal focus are present. Prepared-input mismatch lint, insert actions, warning copy, clearer section hierarchy, preview, and numeric outcome hints are absent. The footer is already outside the scrolling body and must remain so. |
| Preset editor | Active gap | The resolver already detects unavailable Agent output references, and the editor shows currently available tokens. It does not explain stale references in the draft, offer insertion/testing, link the no-Agent state to creation, ask for phase before add, or explain disabled Save. |
| Input Hook autosave | Already implemented; verify | `InputHookSettings.svelte` renders Saving, Pending sync, Saved, failed retention, Retry, live-region semantics, 44px controls, named delete confirmation, focus recovery, and disclosure semantics. The screenshot shows the idle message because no save was in flight. |
| Input Hook terminology | Partial gap | The page description explains Draft and BTW outcomes, but option/card labels can carry the outcomes more directly and the truncated prompt preview lacks a full-value affordance. |
| BardWiki modal semantics | Already implemented; visual refinement | `modalFocusTrap` inerts and hides background branches, traps nested modal focus, locks scrolling, and restores focus. The BardWiki scrim is visually weak, which leaves unrelated close controls prominent. |
| BardWiki lifecycle safety | Already implemented; refine language | Rebuild and vault import already use preview → confirm/apply → status/error stages. Technical wording and the collapsed activity summary remain hard to scan. |
| BardWiki empty and inherited states | Active gap | The zero-document split pane is a dead end, and five override controls hide values already available in `chatResource.effectiveSettings`. |
| Contrast and interaction | Verification gap | Built-in palette tests cover primary and secondary text against main backgrounds. Borders, focus rings, destructive/disabled states, scrims, actual touch targets, long labels, keyboard reorder, and 200% reflow need evidence. |

## Product Contracts

### State vocabulary

- **Ready** means at least one enabled Agent use is valid, all dependencies and output references resolve, and every required model is ready.
- **Empty** means the preset is enabled and valid but has no enabled Agent uses. It remains a legal no-op.
- **Disabled**, **Incomplete**, **Invalid**, and **Model not ready** retain their current resolver meanings.
- A warning explains ineffective or surprising author intent but does not invalidate an existing legal record. An error blocks save and identifies the exact field and recovery action.
- A disabled Save action must have one visible reason: **No changes**, **Fix N issues**, **Waiting for the current change**, or the relevant unavailable-owner reason.
- Mutation feedback continues to distinguish **Saving**, **Pending sync/queued**, **Saved/accepted**, and **Could not save/failed**. Dispatch start alone is never success.

### Authoring diagnostics

- A selected prepared input without its exact token produces a warning with **Insert token** and **Deselect** actions.
- A prepared-input token whose scope is not selected produces a warning with an **Enable input** action. Unknown token-like text must not be silently interpreted.
- Undefined Agent toggle/lorebook references, invalid ChatML, invalid output keys, and unavailable final-output references remain errors.
- Empty instructions and generated default names are allowed but receive plain-language warnings explaining the resulting no-op or ambiguity.
- Valid ChatML can be previewed as compiled role rows. Parser diagnostics should identify the first actionable row/line rather than only returning a generic failure.
- Strict structured output is shown only with JSON-object output. Existing incompatible records remain readable and receive a repair message before save.

### Destructive actions

- Every destructive control has a visible danger treatment inside its menu/dialog, an accessible name containing the target, a named confirmation or bounded Undo, and deterministic focus restoration.
- Preset deletion previews separate impact categories: global default, explicit chat selections, and loadouts. It lists up to five named affected owners per category and summarizes the remainder.
- The preview computes the post-delete effective selection, including fallback to another global default where applicable. It never promises “No preset” merely because an explicit reference is cleared.
- If certified reference owners are unavailable or ambiguous, destructive submission is unavailable with a recoverable explanation; it must not undercount and continue.
- Named confirmation plus failed-draft retention satisfies the Input Hook deletion requirement. This plan does not add Hook Undo unless later evidence shows confirmation is insufficient.

### Responsive and action behavior

- The canonical responsive boundary remains `RESPONSIVE_SHELL_MAX_WIDTH`; this plan does not create a competing breakpoint system.
- When open responsively, navigation is visibly modal: strong scrim, an always-visible Close/Collapse control within the drawer, Escape/backdrop dismissal, focus trap/restoration, and inert underlying content.
- Configured rail/panel sizes are honored where they fit. At reviewed compact widths, geometry must leave an obvious scrim target and cannot push the close control or current row actions off-screen.
- Repeated row actions use the existing `PopupList.svelte` keyboard/menu contract. Keep selection and the primary edit action easy to reach; group secondary actions, and visually separate Delete.
- Compact touch targets are at least 44×44 CSS pixels even when the glyph is smaller. Full names are available on focus and hover.
- Nested branch/folder rows use a native disclosure button plus semantic list/group relationships and redundant indentation/connectors. Do not claim `role="tree"` without implementing its full keyboard model.

### BardWiki behavior

- An inherited control displays both source and effective value, such as **Inherit — currently Hybrid**. The stored draft stays `inherit`/blank.
- Zero documents produces one guided state with **Create first document**, **Import vault**, and **Build from chat** routes. It does not render two competing empty panes.
- Mobile uses list-then-detail navigation. Selecting a document opens its detail with a clear return-to-list action; desktop retains a usable split view.
- Rebuild and import preserve their current preview and fencing contracts. Labels describe outcomes first; terms such as derived corpus, hashes, and conflict strategy remain available in technical details.
- Activity summaries show running, attention, and failed counts and automatically expose actionable failures without creating duplicate announcements.

## Ownership and Likely Change Surface

| Area | Primary owners | Contract companions and focused tests |
| --- | --- | --- |
| Responsive navigation | `src/lib/ConversationShell.svelte`, `src/ts/gui/shellGeometry.ts`, `src/lib/SideBars/Sidebar.svelte`, `src/lib/SideBars/NavigationRail.svelte` | `src/ts/gui/shellGeometry.test.ts`, `src/lib/SideBars/Sidebar.keyboard.dom.test.ts`, `src/lib/Workspace.svelte.test.ts` |
| Chat rows and hierarchy | `src/lib/SideBars/SideChatList.svelte`, `src/lib/SideBars/ChatSelectionButton.svelte`, `src/lib/SideBars/PinnedChatsRail.svelte` | `src/lib/SideBars/SideChatList.svelte.test.ts`, `src/lib/SideBars/PinnedChatsRail.svelte.test.ts`, `src/ts/chatCommands.test.ts` |
| Agent and Preset settings | `src/lib/Setting/Pages/AgentPresetSettings.svelte`, `AgentSettingsSection.svelte`, `AgentEditorDrawer.svelte`, `AgentPresetEditorDrawer.svelte` in the same directory | `src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts`, `src/ts/agents.test.ts`, `src/ts/agentPresets.test.ts` |
| Agent contracts | `packages/shared-core/src/agentPresetRecords.ts`, `agentPresetResolver.ts`, `agentPresetOutputReferences.ts` | Their colocated tests plus `server/fastify/__tests__/agentPresetExecution.test.ts` and `agentPresetDeletionSafety.test.ts` |
| Input Hooks | `src/lib/Setting/Pages/InputHookSettings.svelte`, `src/ts/server/settingsOwner.svelte.ts` | `src/lib/Setting/Pages/InputHookSettings.svelte.test.ts`, `src/ts/server/settingsOwner.svelte.test.ts`, `settingsOwner.durable.svelte.test.ts` |
| BardWiki workspace | `src/lib/ChatScreens/BardWikiWorkspace.svelte`, `src/ts/server/bardWikiResource.ts`, `src/ts/server/bardWikiCommands.ts` | `packages/protocol/src/bardWiki.ts`, `server/fastify/src/bardWikiSettings.ts`, `server/fastify/src/routes/bardWiki.ts`, `src/lib/ChatScreens/BardWikiWorkspace.svelte.test.ts` |
| Shared UI and language | `src/lib/UI/GUI/Button.svelte`, `src/lib/UI/PopupList.svelte`, `src/lib/UI/GUI/TextAreaInput.svelte`, `src/ts/gui/modalFocusTrap.ts`, `src/styles.css`, `src/lang/en.ts` | Shared UI tests, `src/ts/gui/colorscheme.test.ts`, `src/lang/index.test.ts`, and the visible-state policy |

New user-visible copy belongs in `src/lang/en.ts`; other packs may use the existing English fallback until translated. Reuse existing primitives before adding a new one. A generalized status, field-issue, effective-value, or editor-footer component is justified only after at least two real consumers need the same interaction contract.

## Data and Architecture Impact

- No protocol or persistence migration is expected. BardWiki effective values already arrive in `effectiveSettings`; preset deletion already returns cleared-reference counts.
- Prepared-input and ChatML diagnostics should be pure and share the canonical token/parser definitions. Add a shared-core helper only if it is the narrowest owner; do not create a UI-only second grammar.
- Preset-delete impact is a certified projection over existing settings, character/chat metadata, and loadout owners. It must not hydrate transcripts or scan browser compatibility storage.
- UI status derives from current resolvers and command outcomes. It must not create a second readiness model or collapse queued intent into acceptance.
- Reordering continues to use stable IDs and full owner-scoped ID lists. Menus and announcements are presentation changes around the existing command paths.
- Drawer and modal work must preserve `data-modal-root`, `modalFocusTrap`, `modalBackdropDismiss`, dirty-draft capture, nested modal stacking, and focus origin restoration.

## Sequencing

The [phase index](phases/README.md) is normative. The order follows risk and dependency:

1. establish shared diagnostics and measurable UI contracts;
2. make effective/no-op/invalid state truthful;
3. expose deletion and persistence consequences before reorganizing the controls that invoke them;
4. repair compact navigation and action density;
5. add terminology and authoring assistance on top of stable diagnostics;
6. restructure BardWiki using the effective-value and language patterns;
7. run the combined accessibility/browser pass and close out.

Avoid editing every surface in one change. Each slice should leave a complete behavior with focused tests and should update [status.md](status.md) before the next slice begins.

## Validation and Completion

During implementation, run one focused test target per command as required by the repository test wrapper. Select from the ownership table and each phase's explicit targets. UI tests must assert rendered state after interaction, not only source text or values assigned by the test.

The browser matrix must include:

- writer navigation at 550×775, 655×691, and a normal desktop viewport;
- pointer and keyboard opening/closing, menu movement, full-name access, disclosure, and destructive cancellation;
- Agent and Preset drawers at compact width and 200% reflow, including footer reachability and issue-to-field navigation;
- Input Hook saving, queued, accepted, failed, Retry, deletion cancel/accept, and focus recovery;
- BardWiki zero/one/many documents, inherited/overridden settings, rebuild/import preview, active/failed jobs, and mobile list-detail navigation;
- modal background inertness, one unambiguous close action, focus restoration, live announcements, and reduced-motion behavior.

Contrast automation must cover text, muted text, borders needed to identify controls, focus rings, selected states, disabled states, danger controls, and scrims across built-in themes. Custom themes should receive a runtime fallback or warning rather than being silently rewritten.

After implementation and self-review are complete, run `pnpm test:agent` once because the work crosses shared UI, navigation, settings, shared-core behavior, and browser contracts. Run the focused browser journey explicitly; the aggregate smoke build is not proof that the journey ran. Run `pnpm check:docs`, formatting, and `git diff --check`. Do not run `pnpm test:all` unless the user requests it.

Completion requires all phase acceptance evidence in [status.md](status.md), no unresolved high-impact review finding, updated current architecture/test guides, and archival of this plan. Local validation does not establish deployment on the external production server.
