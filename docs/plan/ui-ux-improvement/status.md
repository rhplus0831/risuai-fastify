# UI/UX Improvement Status

## Current Cursor

- State: **Phase 5 in progress — guided BardWiki workspace.**
- Next action: turn BardWiki empty, lifecycle, activity, and mobile states into a guided workspace.
- Review source: `/home/codex/risuai-fastify-sandbox/artifacts/ui-ux-review/REPORT.md`, dated 2026-09-10.
- Planning baseline: current repository source inspected on 2026-09-10; the screenshot review was reconciled against shipped behavior before work was sequenced.
- Runtime source is unchanged by this planning package.

## Document Map

- [PLAN.md](PLAN.md): product contract, reconciled findings, ownership, sequencing, risks, and completion criteria.
- [Phase index](phases/README.md): bounded implementation phases and validation policy.
- [Active plans](../README.md): repository planning index.

## Phase Ledger

| Phase | State | Outcome |
| --- | --- | --- |
| [0. Shared contracts and acceptance baseline](phases/phase-0-shared-contracts-and-baseline.md) | Accepted | Shared diagnostics, certified deletion impact, safety DOM assertions, and a disposable-data compact browser scaffold are in place. |
| [1. Effective state and validation](phases/phase-1-effective-state-and-validation.md) | Accepted | No-op, inherited, unchanged, invalid, and ineffective configurations are explicit before save or generation. |
| [2. Destructive safety and persistence feedback](phases/phase-2-destructive-safety-and-persistence.md) | Accepted | Dependency consequences are previewed and accepted/queued/failed recovery semantics remain explicit. |
| [3. Compact navigation and action density](phases/phase-3-compact-navigation-and-actions.md) | Accepted | Responsive drawers, consolidated row menus, nested hierarchy, complete names, fallbacks, and overflow cues are verified at both compact viewports. |
| [4. Outcome language and authoring tools](phases/phase-4-outcome-language-and-authoring.md) | Accepted | Agent, Preset, and Hook authoring now expose outcomes, insertion, autocomplete, diagnostics, previews, phase choice, and technical disclosures. |
| [5. Guided BardWiki workspace](phases/phase-5-guided-bardwiki-workspace.md) | Pending | Turn the empty workspace, overrides, lifecycle tools, and mobile flow into guided tasks. |
| [6. Accessibility, visual evidence, and closeout](phases/phase-6-accessibility-and-closeout.md) | Pending | Complete interaction, contrast, zoom, browser, documentation, and rollout evidence. |

## Decisions

- Keep the existing visual language and shared UI primitives. This is an incremental usability and accessibility pass, not a new design system.
- Keep Agent Preset runtime semantics unchanged: an enabled preset with no enabled Agent uses remains a valid no-op, but the UI calls it **Empty**, not **Ready**.
- Treat selected-but-unused prepared inputs, an empty Agent instruction, and a default generated name as actionable warnings. Existing valid records are not made invalid solely by these warnings.
- Reuse the server-provided BardWiki `effectiveSettings` values. Displaying an inherited value must never materialize it as a chat override.
- Keep the current preset-deletion cleanup contract. The confirmation must explain which default, chats, and loadouts will change and what each will resolve to afterward.
- Keep the current named Input Hook confirmation and retained autosave failure/retry behavior. They satisfy the review's safety requirement and need regression evidence, not a replacement workflow.
- Keep `modalFocusTrap`, background inertness, focus restoration, and the existing sticky drawer footer structure. Only presentation or missing surface-specific feedback should change.
- Do not restore the supplied reference-only root grid or any removed image-only navigation.

## Verification Ledger

- 2026-09-10: read `AGENTS.md`, `STRUCTURE.md`, the UI/UX report, applicable current architecture/test guides, and the relevant implementation owners.
- 2026-09-10: completed seven independent read-only Luna cross-checks for navigation, Agent list, Agent editor, Preset editor, Input Hooks, BardWiki, and shared UI. All workers succeeded; their source claims were reconciled against current files.
- 2026-09-10: visually inspected all seven fresh screenshots from the report artifact directory.
- 2026-09-10: `pnpm check:docs` passed for 49 current documents. The explicit plan/index validator also passed for all 11 planning documents with no link, anchor, path, or index errors.
- 2026-09-10: plan formatting and `git diff --check` passed. No runtime test was required for this documentation-only change.

## Progress Record

Record implementation progress only here. For every completed slice, include the changed owner, source revision, focused commands and results, browser viewport when applicable, remaining limitations, and the next slice. Accept a phase only after every acceptance item in its phase document has evidence.

Do not describe a queued mutation as saved on the server, a static screenshot as interaction evidence, or a focused component test as browser geometry proof. When all phases are accepted, update current architecture/test guides, archive this package under `.archived-docs/ui-and-user-input/`, and update the active/archive indexes.

### 2026-09-10 — Phase 0 shared diagnostics slice

- Source base: `cf2b4bccd`.
- Changed owners: `packages/shared-core/src/agentPresetInputReferences.ts`,
  `packages/shared-core/src/agentPresetResolver.ts`,
  `server/fastify/src/prompt/agentPresetExecution.ts`, and browser presentation
  helpers under `src/ts/`.
- Added the canonical prepared-input token analyzer, structured output-reference
  diagnostics, presentation-only Empty status, and localized field/recovery
  issue contracts. Runtime no-op, scope collection, and resolver readiness
  semantics are unchanged.
- Passed `pnpm test -- packages/shared-core/src/agentPresetInputReferences.test.ts`
  (3 tests), `pnpm test -- src/ts/agentPresetResolver.test.ts` (13 tests),
  `pnpm test -- src/ts/agentPresetPresentation.test.ts` (2 tests),
  `pnpm test -- src/ts/agentAuthoringIssues.test.ts` (2 tests), and
  `pnpm test -- server/fastify/__tests__/agentPresetExecution.test.ts` (26
  tests).
- Passed `pnpm check:shared-core`, `pnpm check`, focused Prettier, and
  `git diff --check`.
- Fixture limit: these pure fixtures pin diagnostic states but do not constitute
  DOM interaction or browser geometry evidence. Next slice: certified deletion
  impact and the Phase 0 DOM/browser baseline.

### 2026-09-10 — Phase 0 deletion-impact slice

- Source base: `6fd14a0c9`.
- Changed owners: `src/ts/agentPresetDeletionImpact.ts` and
  `src/ts/agentPresets.ts`.
- Added a fail-closed projection for global-default, explicit chat, and loadout
  references. It predicts chat fallback to a different surviving global default,
  names affected owners with stable-ID fallbacks, and reports unavailable owners
  instead of undercounting malformed, ambiguous, loading, or failed projections.
  The projection reads chat metadata/settings only and does not inspect transcript
  messages.
- Passed `pnpm test -- src/ts/agentPresetDeletionImpact.test.ts` (5 tests) and
  `pnpm test -- src/ts/agentPresets.test.ts` (39 tests).
- Fixture limit: the projection is not yet exposed in the confirmation UI; that
  is Phase 2 work. Next slice: Phase 0 safety DOM assertions and browser journey
  scaffold.

### 2026-09-10 — Phase 0 safety and browser-baseline slice

- Source base: `d5b98e643`.
- Changed owners: Agent and Preset drawers, Input Hook DOM tests, responsive
  workspace DOM tests, and
  `server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`.
- Pinned drawer footer placement outside the scroll body, responsive dialog
  inertness and focus restoration, Input Hook Saving/queued/failed/accepted
  presentation with retained newer text, and the existing nested modal behavior.
- Added a dedicated temporary-Fastify/temporary-SQLite Chromium scaffold with
  deterministic ready, Empty, invalid, stale-output, prepared-input mismatch,
  Input Hook, and zero-document BardWiki data. It opens writer navigation and all
  reviewed routes at 550×775 and 655×691 without sleeps or command mutations.
- Passed `pnpm test -- src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts`
  (21 tests), `pnpm test -- src/lib/Setting/Pages/InputHookSettings.svelte.test.ts`
  (9 tests), `pnpm test -- src/lib/Workspace.svelte.test.ts` (32 tests),
  `pnpm test -- src/ts/gui/modalFocusTrap.test.ts` (7 tests),
  `pnpm test -- src/ts/server/settingsOwner.svelte.test.ts` (52 tests), and
  `pnpm test -- src/lib/ChatScreens/BardWikiWorkspace.svelte.test.ts` (16 tests).
- Passed `pnpm build:smoke` and
  `pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`
  (Chromium, 1 test). The build retained its existing CSS Highlight API and
  browser-externalization warnings.
- Fixture limit: Phase 0 proves route reachability and safety baselines, not the
  complete keyboard/zoom/lifecycle matrix owned by Phase 6. Existing component
  fixtures cover one-document, failed-job, pending-job, and running-job BardWiki
  states; the browser scaffold intentionally starts at zero documents.
- Phase 0 accepted. Next slice: truthful effective/Empty states and field-linked
  authoring validation in Phase 1.

### 2026-09-10 — Phase 1 truthful preset-state slice

- Source base: `adbd7bce8`.
- Changed owners: `src/lib/Setting/Pages/AgentPresetSettings.svelte`,
  `src/ts/agentPresetPresentation.ts`, and localized Agent Preset copy.
- Preset cards now reserve Ready for executable plans, show
  **Empty — no Agents configured** for valid no-op presets, retain blocked-state
  precedence, keep plain-language phase/use summaries visible, and move raw IDs
  and concurrency metadata into a Technical details disclosure.
- Passed `pnpm test -- src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts`
  (22 tests), including rendered Ready/Empty/Disabled/Invalid/Incomplete/model
  status assertions.
- Next slice: no-Agent creation workflow and editor issue/save feedback.

### 2026-09-10 — Phase 1 Agent authoring-feedback slice

- Source base: `a5636116b`.
- Changed owners: `src/lib/Setting/Pages/AgentEditorDrawer.svelte`,
  `src/ts/agentAuthoringIssues.ts`, their focused tests, and localized Agent
  Preset copy.
- The Agent editor now presents field-linked warning/error summaries. Prepared
  inputs have one-step Insert, Deselect, and Enable repairs; empty instructions
  and generated names remain nonblocking; blank names, invalid ChatML, strict
  text output, model selection, and undefined toggle/lorebook definitions block
  Save. Issue actions move focus to the relevant authoring field.
- The sticky footer now explains disabled Save as **No changes**, **Fix N
  issues**, or **Waiting for the current change**. Escape uses the same
  dirty-draft confirmation as backdrop and Cancel dismissal.
- Passed `pnpm test -- src/ts/agentAuthoringIssues.test.ts` (3 tests),
  `pnpm test -- src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts` (25
  tests), and `pnpm check` with no diagnostics.
- Next slice: nested Agent creation from an empty Preset and Preset footer
  validation feedback.

### 2026-09-10 — Phase 1 nested creation and stale-save slice

- Source base: `ad73d3d3b`.
- Changed owners: Agent/Preset settings, both editor drawers, their component
  tests, and localized Agent Preset copy.
- An empty Preset now explains the create-then-add workflow and opens a nested
  Agent drawer. The parent Preset draft remains mounted, focus returns to the
  invoking control, and accepted or later-reconciled queued Agents are selected
  in the refreshed picker.
- Preset metadata uses the canonical planner for blocking validation and its
  sticky footer now reports **No changes**, **Fix N issues**, or **Waiting for
  the current change**. Agent and Preset saves retain a newer draft/issue state
  when an older accepted request resolves instead of closing the drawer.
- Passed `pnpm test -- src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts`
  (30 tests). Nested accepted/queued reconciliation, focus restoration, parent
  draft retention, waiting feedback, and stale-save fencing are covered.
- Next slice: expose BardWiki effective values beside inherited choices without
  persisting them as overrides.

### 2026-09-10 — Phase 1 inherited BardWiki settings slice

- Source base: `06e87d186`.
- Changed owners: `src/lib/ChatScreens/BardWikiWorkspace.svelte`, its focused
  component test, and localized BardWiki copy.
- Every inherited chat override now names its current effective value directly
  from `chatResource.effectiveSettings`, including the numeric token-budget
  placeholder. Effective labels react to resource refresh while an unrelated
  draft choice stays unchanged, and blank/inherit values are still submitted as
  `null` rather than materializing the inherited values.
- Passed `pnpm test -- src/lib/ChatScreens/BardWikiWorkspace.svelte.test.ts` (17
  tests). The focused fixture changes effective settings after mount, retains a
  separate explicit draft, and asserts the exact sparse override payload.
- Phase 1 accepted. Next slice: dependency-aware destructive confirmations and
  deletion safety in Phase 2.

### 2026-09-10 — Phase 2 destructive-impact and dependency slice

- Source base: `1cd3cb1ec`.
- Changed owners: Agent/Preset settings, a focused Preset deletion dialog,
  localized destructive copy, and component interaction tests. The Phase 0
  impact projector and existing command/rollback paths remain the data owners.
- Preset deletion now shows a target-bearing alert dialog with bounded global
  default, explicit-chat, and loadout categories plus each post-delete
  fallback. Submission rechecks the certified projection and requires another
  review if it changed. Unavailable or malformed owners disable deletion and
  expose a retry action.
- Cancellation performs no mutation and restores trigger focus. Accepted
  deletion announces authoritative cleanup counts; queued deletion says pending
  sync and never claims server success; failed deletion stays in the dialog with
  the retained command error. Danger actions have text/icon treatment,
  target-bearing accessible names, and a visual separator.
- Agent cards now disclose every blocking Preset and use count, with an action
  that opens that Preset. The still-disabled delete control names the Agent and
  dependency count; the server hard rejection is unchanged.
- Passed `pnpm test -- src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts`
  (37 tests), `pnpm test -- src/ts/agentPresets.test.ts` (39 tests), `pnpm test
  -- src/ts/agents.test.ts` (7 tests), `pnpm test --
  server/fastify/__tests__/agentPresetDeletionSafety.test.ts` (13 tests),
  `pnpm test -- src/lib/Setting/Pages/InputHookSettings.svelte.test.ts` (9
  tests), and `pnpm check` with no diagnostics.
- Existing Input Hook tests confirm named cancellation, accepted/queued/failed
  feedback, Retry, focus recovery, and a newer edit winning over an older
  settlement; no working autosave abstraction was replaced.
- Phase 2 accepted. Next slice: responsive navigation and consolidated compact
  row actions in Phase 3.

### 2026-09-10 — Phase 3 responsive-drawer geometry slice

- Source base: `05315ee4c`.
- Changed owners: the shared shell geometry helper, writer and connected-reader
  navigation adapters, navigation rail, and focused geometry/workspace tests.
- Responsive geometry now preserves configured rail columns when a usable panel
  fits, reduces them only when necessary, caps the panel at the viewport, and
  reserves a 56px scrim target at 550×775 and 655×691. The 1024px breakpoint and
  all desktop geometry remain unchanged.
- Writer and reader drawers now include a visible 44px-high **Close Menu**
  action inside the panel, use a stronger scrim, and retain backdrop/Escape
  dismissal, focus restoration, and inert main content. The rail has bottom
  padding and a narrow overflow scrollbar instead of clipping its final item.
- Passed `pnpm test -- src/ts/gui/shellGeometry.test.ts` (6 tests) and `pnpm
  test -- src/lib/Workspace.svelte.test.ts` (32 tests).
- Next slice: consolidate chat/folder secondary actions and strengthen hierarchy,
  names, targets, and avatar fallbacks.

### 2026-09-10 — Phase 3 action-density and hierarchy slice

- Source base: `7cdf3feb3`.
- Changed owners: writer and reader chat navigation, shared popup controls,
  avatar/pinned-chat presentation, the modal focus trap, localized navigation
  copy, and the compact browser journey.
- Chat selection remains the primary row action. Copy, persona binding, rename,
  export, organization, and deletion now live in a target-named keyboard menu;
  deletion is the final action in a visually separated danger section. Folder
  actions use the same pattern. Responsive row, menu, footer, disclosure, and
  avatar targets are at least 44px.
- Folder trees now expose disclosure chevrons, semantic list/group structure,
  indentation/connectors, current-state cues beyond color, and named empty
  states. Missing character imagery renders initials; truncated chat labels
  retain full hover and accessible names. Writer and reader adapters share the
  presentation without adding reader mutations.
- The browser journey found that the global popup host was outside the drawer's
  focus scope. `modalFocusTrap` now admits only dynamically opened, explicitly
  marked focus extensions while keeping every other sibling inert; menus can
  receive focus and Escape restores the drawer trigger.
- Passed `pnpm test -- src/lib/SideBars/SideChatList.svelte.test.ts` (72 tests),
  `pnpm test -- src/lib/SideBars/PinnedChatsRail.svelte.test.ts` (5 tests),
  `pnpm test -- src/lib/UI/PopupList.svelte.test.ts` (6 tests), `pnpm test --
  src/ts/gui/modalFocusTrap.test.ts` (8 tests), `pnpm test --
  src/lib/SideBars/Sidebar.keyboard.dom.test.ts` (26 tests), `pnpm test --
  src/lib/SideBars/Sidebar.charList.test.ts` (6 tests), and `pnpm check` with no
  diagnostics.
- Passed `pnpm build:smoke` and the dedicated Chromium browser journey at
  550×775 and 655×691. It proves a 56px visible scrim, 44px Close action, no
  horizontal drawer overflow, target-named menu reachability, End/Escape focus
  behavior, focus restoration, and no command requests. The build retained its
  existing CSS Highlight API and browser-externalization warnings.
- Phase 3 accepted. Next slice: outcome-first Input Hook and Agent/Preset
  authoring assistance in Phase 4.

### 2026-09-10 — Phase 4 outcome language and authoring slice

- Source bases: `a1cf26a5e`, `aca612c2e`, `e9a68c2bf`, `6f93bbbe4`,
  `18c21cba4`, and `4df6e7e7a`.
- Changed owners: the shared `TextAreaInput`, Agent and Preset editor drawers,
  the module-integration authoring helper, Input Hook settings, localized copy,
  focused component/helper tests, and the compact Chromium journey.
- Agent authoring is ordered as **Basics**, **Instructions**, **Context**,
  **Model & limits**, and **Advanced**. Empty advanced controls collapse; runtime
  fields state bounds and effects; selected prepared inputs, Agent toggles, and
  lorebook inputs can be inserted or autocompleted at the live caret; valid
  ChatML renders as ordered role rows without exposing hidden thought bodies.
- Preset module integration is a deduplicating chip editor backed by live module
  IDs and namespaces. Unknown custom namespaces are retained with a warning and
  persist through the compatibility-spelled `moduleIntergration` field. Final
  output values are caret-insertable, missing/disabled references explain and
  offer repair, and explicit sample values drive a provider-free preview.
- Preset composition asks for Before Main/After Main before add, chooses a valid
  default destination, reopens a reconciled new use, and announces add/reorder
  position. Human position is primary; Agent/Preset IDs, output keys, module
  values, and phase metadata remain copyable in Technical details.
- Draft/BTW values remain unchanged while options and cards supplement them with
  **Before send** and **On-demand result**. Collapsed prompts expose the complete
  text on hover/focus, and Translation mode states its input → model → reviewed
  text → stored/sent result flow.
- Passed `pnpm test -- src/lib/UI/GUI/TextAreaInput.svelte.test.ts` (20 tests),
  `pnpm test -- src/ts/agentPresetModuleIntegration.test.ts` (2 tests), `pnpm
  test -- packages/shared-core/src/agentPresetOutputReferences.test.ts` (14
  tests), `pnpm test -- src/ts/agentPresetResolver.test.ts` (13 tests), `pnpm
  test -- src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts` (43 tests),
  `pnpm test -- src/lib/Setting/Pages/InputHookSettings.svelte.test.ts` (10
  tests), and `pnpm check` with no diagnostics.
- Passed `pnpm build:smoke` and the dedicated Chromium browser journey at
  550×775 and 655×691. It verifies ordered Agent sections, collapsed Advanced,
  caret insertion, phase-before-add, final-output insertion, Hook outcome/full
  prompt access, footer reachability, no horizontal drawer overflow, and no
  command requests. The build retained its existing CSS Highlight API and
  browser-externalization warnings.
- Phase 4 accepted. Next slice: coherent zero-document BardWiki guidance and
  list/detail mobile navigation in Phase 5.
