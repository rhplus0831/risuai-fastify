# UI/UX Improvement Status

## Current Cursor

- State: **Phase 0 in progress — shared diagnostics implemented.**
- Next action: add the certified preset-delete impact projection and baseline UI/browser fixtures.
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
| [0. Shared contracts and acceptance baseline](phases/phase-0-shared-contracts-and-baseline.md) | Pending | Lock the presentation contracts, pure diagnostics, fixtures, and measurable acceptance baseline. |
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
