# Phase 0 — Shared Contracts and Acceptance Baseline

Read the [plan](../PLAN.md) and [status](../status.md). This phase converts the reconciled review into reusable, testable presentation contracts before surface layout changes begin.

## Outcome

The implementation has one canonical source for Agent authoring diagnostics, preset presentation state, deletion impact, and compact/browser fixtures. Already-correct modal and Input Hook behavior is pinned so later refactors cannot regress it.

## Bounded Slices

1. Add pure tests and the narrowest helpers for:
   - selected versus referenced prepared-input scopes;
   - prepared-input insertion tokens and unknown-token handling;
   - final-output Agent reference diagnostics using `agentPresetOutputReferences()` and current resolved steps;
   - presentation-only preset status that distinguishes valid **Empty** from executable **Ready** without changing resolver states;
   - preset deletion impact separated into default, chat, and loadout references with post-delete effective selection.
2. Define surface issue objects with severity, field identity, localized message key, and recovery action. Reuse shared-core token/parser owners where grammar is involved; keep UI-only presentation mapping in the browser layer.
3. Extend deterministic fixtures for empty/ready/invalid presets, no Agents, stale output references, prepared-input mismatches, named preset references, Input Hook persistence outcomes, BardWiki zero/one/many documents, and active/failed jobs.
4. Pin existing safety behavior: responsive navigation is a modal dialog; background branches become inert; focus restores; Agent/Preset footer actions remain outside the scrolling body; Input Hook failed edits remain and Retry uses the same draft; Hook deletion is named and restores focus.
5. Add the smallest dedicated browser journey scaffold for the reviewed routes and data. It must use disposable agent data and stable readiness/network barriers rather than sleeps.

## Acceptance

- Empty presentation does not change `planAgentPreset()` or generation readiness semantics.
- Diagnostics use the same scope, CBS, ChatML, output-reference, and stable-ID contracts as runtime owners.
- Delete impact never reads whole transcripts, never guesses when owner projections are unavailable, and predicts fallback behavior correctly.
- Tests demonstrate the already-implemented modal, sticky footer, Input Hook status, failure retention, confirmation, and focus behavior.
- Browser fixtures can open every reviewed surface at the exact compact viewports without mutating human data.

Use focused tests for `packages/shared-core/src/agentPresetRecords.ts`, `src/ts/agentPresetResolver.ts`, `src/ts/agentPresets.ts`, `src/lib/Setting/Pages/InputHookSettings.svelte`, `src/ts/gui/modalFocusTrap.ts`, and the new browser spec. Record exact commands and fixture limits in [status](../status.md).
