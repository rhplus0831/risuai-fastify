# UI/UX Improvement Status

## Current Cursor

- State: **Complete — Phases 0–6 accepted.**
- Final runtime source: `7f7ee34ea`; the archive-only closeout revision follows this ledger.
- Review source: `/home/codex/risuai-fastify-sandbox/artifacts/ui-ux-review/REPORT.md`, dated 2026-09-10.
- Planning baseline: current repository source inspected on 2026-09-10; the screenshot review was reconciled against shipped behavior before work was sequenced.
- Runtime behavior and current guides now include the accepted interaction, accessibility, and authoring contracts described below.

## Document Map

- [PLAN.md](PLAN.md): product contract, reconciled findings, ownership, sequencing, risks, and completion criteria.
- [Phase index](phases/README.md): bounded implementation phases and validation policy.
- [UI and user input archive](../README.md): archive index for this completed record.

## Phase Ledger

| Phase | State | Outcome |
| --- | --- | --- |
| [0. Shared contracts and acceptance baseline](phases/phase-0-shared-contracts-and-baseline.md) | Accepted | Shared diagnostics, certified deletion impact, safety DOM assertions, and a disposable-data compact browser scaffold are in place. |
| [1. Effective state and validation](phases/phase-1-effective-state-and-validation.md) | Accepted | No-op, inherited, unchanged, invalid, and ineffective configurations are explicit before save or generation. |
| [2. Destructive safety and persistence feedback](phases/phase-2-destructive-safety-and-persistence.md) | Accepted | Dependency consequences are previewed and accepted/queued/failed recovery semantics remain explicit. |
| [3. Compact navigation and action density](phases/phase-3-compact-navigation-and-actions.md) | Accepted | Responsive drawers, consolidated row menus, nested hierarchy, complete names, fallbacks, and overflow cues are verified at both compact viewports. |
| [4. Outcome language and authoring tools](phases/phase-4-outcome-language-and-authoring.md) | Accepted | Agent, Preset, and Hook authoring now expose outcomes, insertion, autocomplete, diagnostics, previews, phase choice, and technical disclosures. |
| [5. Guided BardWiki workspace](phases/phase-5-guided-bardwiki-workspace.md) | Accepted | Empty, inherited, lifecycle, activity, mobile, and modal states form one guided and safely fenced workspace. |
| [6. Accessibility, visual evidence, and closeout](phases/phase-6-accessibility-and-closeout.md) | Accepted | Theme contrast, names and targets, modal focus, keyboard/reflow browser journeys, current guides, and report disposition are complete. |

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

### 2026-09-10 — Phase 5 guided BardWiki workspace

- Source bases: `12af6ac09`, `ded13dee9`, `55cbbf31f`, and `9e2311650`.
- Changed owners: `src/lib/ChatScreens/BardWikiWorkspace.svelte`, localized
  BardWiki copy, its focused component tests, and the compact Chromium journey.
- A zero-document chat now presents one guided workflow with **Create first
  document** as the primary action and **Import vault** / **Build from chat** as
  secondary routes into the existing preview-fenced stages. Inherited controls
  show their effective server value in a responsive grid without materializing
  it as an override.
- Compact BardWiki uses list-then-detail navigation with a named Back action,
  retains unsaved document and settings drafts, and restores logical focus.
  Desktop keeps its split view. Lifecycle controls use outcome names while
  hashes, source distinctions, document replacement counts, and conflict
  strategy remain in Technical details; preview and explicit apply/confirmation
  fences are unchanged.
- Activity summarizes running, attention, and failed counts. Newly actionable
  failures/review states open the disclosure, resolved or unchanged work does
  not override a user's closed choice, and confirmation/Retry/Cancel/results
  share one polite or urgent live announcement owner.
- The workspace uses a stronger established scrim, theme-owned surface and
  border colors, a 44px Close target, and a shadowed modal surface. No shared
  theme token was changed because focused inspection found no proven global
  token weakness; modal focus trapping, background inertness, scroll lock,
  Escape/backdrop safety, nesting, and restoration remain owned by the existing
  primitives.
- Passed `pnpm test -- src/lib/ChatScreens/BardWikiWorkspace.svelte.test.ts`
  (21 tests), `pnpm check` with no diagnostics, focused Prettier, and
  `git diff --check`.
- Passed `pnpm build:smoke` and the dedicated Chromium journey at 550×775 and
  655×691. It verifies the coherent empty workflow, all three CTA destinations,
  live inherited labels, outcome-named lifecycle choices, 44px Close geometry,
  stronger scrim/shadow, programmatic background inertness, one-pane compact
  navigation, focus restoration, unsaved document/settings draft retention,
  Activity counts, no horizontal overflow, and no command requests. The build
  retained its existing CSS Highlight API and browser-externalization warnings.
- Phase 5 accepted. Next slice: cross-surface keyboard, contrast, theme, zoom,
  reduced-motion, and documentation closeout in Phase 6.

### 2026-09-10 — Phase 6 contrast, accessibility, and closeout

- Source bases: `a82c3b569`, `d8316d8d9`, `66d4415d4`, `cf7d76f7b`,
  `de0f4e428`, `5aa63c1c7`, and `7f7ee34ea`.
- Changed owners: built-in color palettes and custom-color diagnostics, the
  Fastify color default, compact Agent/Preset controls, chat-modal entry focus,
  the dedicated Chromium review journey, current UI/structure/test guides, and
  direct Korean UI copy.
- Theme verification now measures primary and muted text against page and modal
  backgrounds at 4.5:1, focus indicators and control borders at 3:1, primary
  text on selected/control backgrounds at 4.5:1, disabled text at the product's
  50% opacity at 3:1, destructive indicators at 3:1, and the modal edge against
  the black/70 scrim at 3:1. Every built-in palette passes. Exact legacy
  built-in values migrate to their repaired equivalents; edited and custom
  palettes are preserved and receive localized, role-specific warnings instead
  of silent rewriting.
- Compact Agent and Preset list, drawer, close, reorder, edit, duplicate,
  removal, use, and chip controls now have complete target-bearing names and
  44px targets where touch-oriented. Status, hierarchy, selection, and failure
  cues do not rely on color alone.
- Opening Chat List, BardWiki, or Modules from the transient chat menu now
  establishes the persistent chat-menu button as the restoration owner before
  the menu is removed. This prevents a disconnected trigger from entering the
  modal focus stack while preserving nested focus traps, inertness, Escape,
  scroll lock, and restoration.
- Passed focused final-source tests: `pnpm test --
  src/ts/gui/colorscheme.test.ts` (55 tests), `pnpm test --
  src/lib/Setting/Pages/Display/ColorSettingsAccessibility.svelte.test.ts` (7
  tests), `pnpm test --
  src/lib/Setting/Pages/AgentPresetSettings.svelte.test.ts` (44 tests), `pnpm
  test -- src/lib/ChatScreens/DefaultChatScreen.loadPages.test.ts` (107 tests),
  `pnpm test -- server/fastify/__tests__/databaseDefaults.test.ts` (32 tests),
  and `pnpm exec vitest run src/lang/index.test.ts` (22 tests).
- The required one-shot `pnpm test:agent` ran after implementation and completed
  in 2m 40.6s. Server/browser typecheck, topology, current docs, frontend check,
  all 4,365 server tests (3 skipped), and the browser-smoke build passed. Its
  frontend lane failed on the then-missing direct Korean paths; the ownership
  test reported beside it passed immediately in isolation (94 tests) and was a
  concurrency-only result. Commit `7f7ee34ea` supplied all 167 missing Korean
  paths. The repaired frontend lane was then run once, without repeating the
  aggregate: `RISU_TEST_EXCLUDE_UI_MAP=false RISU_TEST_INCLUDE_GATES=false pnpm
  exec vitest run` passed all 726 files and 9,384 tests (3 skipped). Together
  these runs cover every aggregate lane on final source; no failing check or
  product exception remains.
- Current navigation, settings, shared UI, chat, Agent/Preset, BardWiki, and
  testing guides describe the shipped contracts. Final-source `pnpm check`
  reports 0 errors and 0 warnings; `pnpm check:docs`, focused Prettier, and `git
  diff --check` pass. Existing browser build notices for the CSS Highlight API
  and browser-externalized modules remain non-failing and are unrelated to these
  surfaces.

### Phase 6 browser evidence

- Source revision: `de0f4e428` for the journey and screenshots; later revisions
  contain documentation and localization only.
- Command: `pnpm exec playwright test -c
  playwright.fastify-smoke.config.ts
  server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts
  server/fastify/browser-smoke/bardWikiLifecycle.spec.ts` — 3 Chromium tests
  passed in 11.2s.
- The disposable fixture exercises 550×775, 655×691, 640×450 reflow, and
  1280×900 desktop layouts, long navigation data, and reduced motion. The
  640-CSS-pixel case represents a 1280px desktop reflowed at 200%; Playwright
  does not drive Chromium's native chrome zoom control, and resized desktop
  Chromium is not proof of touch hardware, a screen reader, or the external
  production deployment.
- Interaction assertions cover responsive drawer focus/inertness and footer
  reachability; rail scrolling; folder disclosure; menu Home/End/Escape;
  target-bearing names; no horizontal overflow; Agent creation; nested Agent
  composition; Preset reorder announcements; fail-closed deletion impact with
  Retry and focus recovery; Hook rename/save/delete cancel/delete accept/Add
  focus; BardWiki keyboard creation, Back navigation, long lists, Escape
  restoration, desktop split view, persistence, and Activity disclosure.
  Browser deletion deliberately proves the safe unavailable/Retry state because
  that route does not load the loadout projection; the component suite proves
  the ready global/chat/loadout impact and accepted/queued/failed outcomes.
- Before screenshots are in
  `/home/codex/risuai-fastify-sandbox/artifacts/ui-ux-review/` as
  `fresh-root-sidebar-550x775.png`, `fresh-root-sidebar-655x691.png`,
  `fresh-agent-presets.png`, `fresh-edit-agent.png`, `fresh-edit-preset.png`,
  `fresh-input-hooks.png`, and `fresh-bardwiki-workspace-expanded.png`.
- After screenshots are in
  `test-results/uiUxImprovementBaseline-re-0b833-a-at-both-compact-viewports/`
  as `after-sidebar-550x775.png`, `after-sidebar-655x691.png`,
  `after-agent-presets.png`, `after-agent-editor.png`,
  `after-preset-editor.png`, `after-input-hooks.png`, and
  `after-bardwiki-workspace.png`. The Playwright attachment copies in that
  directory retain their content-addressed names.

### Final report self-review

| Reviewed surface | Findings and disposition |
| --- | --- |
| 550×775 navigation | Missing identity fallbacks and complete names, crowded actions, weak drawer affordance, clipped rail overflow, ambiguous branch hierarchy, and weak interaction contrast are **implemented**. The reference-only root grid is **retired** and was not restored. |
| 655×691 navigation | Drawer width/scrim/close geometry, secondary-action density, hierarchy, truncation access, and rail continuation are **implemented**. The image-only grid and obsolete root badges are **reference-only/retired**. |
| Agent list | Guided empty creation, certified dependency-aware deletion, Technical details, nested create-from-Preset, touch-sized named actions, density, and reorder announcements are **implemented**. Server-side dependency rejection is **intentionally preserved** as defense in depth. |
| Agent editor | Two-way prepared-input lint, nonblocking empty/generated-name warnings, grouped sections, ChatML/strict-output guidance, caret insertion/autocomplete, actionable parser/reference diagnostics, numeric effects/reflow, and focus recovery are **implemented**. Existing valid records remain valid, **intentionally preserved**. |
| Preset editor | Module chips/insertion, output-reference diagnostics and preview, stale-reference repair, phase-before-add nested creation, Save reasons, grouping/footer reachability, and keyboard names are **implemented**. Unknown documented namespaces remain allowed with warnings, **intentionally preserved**. |
| Input Hooks | Existing autosave, retained newer edits, Retry, and named deletion confirmation are **verified/preserved**. Outcome-first Draft/BTW labels, prompt disclosure, translation-flow copy, compact cards, and focus/browser coverage are **implemented**. Runtime Hook values are **intentionally preserved**. |
| BardWiki | Guided empty actions, truthful inherited values, modal isolation, responsive list/detail and desktop split views, outcome lifecycle language, Activity summaries, and measured contrast are **implemented**. Preview, version/hash fences, and explicit apply/confirmation are **intentionally preserved**. |

All high-impact report findings are closed. Semantic list/group and native
disclosure behavior were chosen over a custom ARIA tree because the interaction
model does not require tree keyboard semantics; visible indentation, connectors,
expanded state, and redundant current cues provide the reviewed hierarchy. No
finding remains open solely because it was absent from a screenshot.

Phase 6 accepted. The complete package is archived under
`.archived-docs/ui-and-user-input/ui-ux-improvement/`; current architecture and
testing guides are the source of truth for shipped behavior.
