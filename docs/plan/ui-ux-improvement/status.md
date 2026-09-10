# UI/UX Improvement Status

## Current Cursor

- State: **Phase 1 in progress — truthful preset status implemented.**
- Next action: add nested Agent creation, field-linked issues, save reasons, and BardWiki inherited values.
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
| [1. Effective state and validation](phases/phase-1-effective-state-and-validation.md) | Pending | Make no-op, inherited, unchanged, invalid, and ineffective configurations explicit. |
| [2. Destructive safety and persistence feedback](phases/phase-2-destructive-safety-and-persistence.md) | Pending | Preview dependency consequences and preserve the existing accepted/queued/failed contract. |
| [3. Compact navigation and action density](phases/phase-3-compact-navigation-and-actions.md) | Pending | Clarify the responsive drawer, reduce row-action crowding, and strengthen hierarchy and overflow cues. |
| [4. Outcome language and authoring tools](phases/phase-4-outcome-language-and-authoring.md) | Pending | Replace implementation-first copy with outcomes and add insertion, completion, and preview assistance. |
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
