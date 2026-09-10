# Phase 4 — Outcome Language and Authoring Tools

Depends on accepted [Phase 1](phase-1-effective-state-and-validation.md) and may follow Phase 3 to reuse its action presentation. Read the [plan](../PLAN.md) and [status](../status.md).

## Outcome

Users author Agents, Presets, and Hooks through outcome-oriented controls with insertion, completion, diagnostics, and preview assistance; internal IDs and syntax remain available without dominating the task.

## Bounded Slices

1. Reorganize the Agent drawer into Basics, Instructions, Context, Model & limits, and Advanced sections. Keep the most common path expanded, collapse empty advanced sections, retain the sticky action footer, and stack to one column at compact width and 200% reflow.
2. Replace the plain Agent instruction textarea with the existing shared authoring path where practical. Add click-to-insert prepared-input, toggle, and lorebook tokens; preserve caret position; provide autocomplete; and render valid ChatML as a compiled role-row preview with actionable parser errors.
3. Show numeric min/max and plain-language effects for timeout, input/output limits, temperature, and concurrency. Keep HTML constraints and server normalization authoritative.
4. Replace comma-only Module Integration entry with token/chip editing backed by available module IDs and namespaces. Allow documented namespace values, warn on unknown values without inventing a false hard error, deduplicate on save, and retain the compatibility-spelled persisted field.
5. Make final-output values insertable controls, not static code. Highlight unavailable/stale `{{agent::key}}` references, explain whether the Agent/use is absent, disabled, in the wrong phase, or not ordered as a dependency, and offer a preview using explicit sample outputs without making provider calls.
6. Ask for Before Main/After Main when adding an Agent to a Preset. Set a phase-valid default destination, return to the new use, and announce its position. Reuse stable reorder commands and add accessible position feedback.
7. Supplement Draft/BTW option and card names with **Before send** and **On-demand result** outcomes. Add full prompt-preview access on focus/hover and clarify Translation mode as input → model → reviewed text → stored/sent result without changing Hook runtime values.
8. Move raw Agent/Preset IDs, output keys, module namespaces, and low-level phase metadata into consistent Technical details disclosures while keeping copyable values available.

## Acceptance

- Token insertion and autocomplete update the intended draft at the caret and cannot commit to a stale/unmounted editor.
- Every reference error explains the missing relationship and provides a direct repair or navigation action.
- Module and CBS tools round-trip existing persisted values, including unknown-but-allowed namespaces, without a schema migration.
- Phase selection happens before add; keyboard reorder announces the new position and preserves dependency validity.
- Compact/zoom layouts retain label-control associations, footer reachability, and authored text through validation, cancel, queued, failure, and writer-loss paths.

Use focused tests for `AgentPresetSettings.svelte`, `TextAreaInput.svelte`, `PopupEditor.svelte`, shared Agent record/resolver/output-reference helpers, module integration helpers, and Input Hook settings. Extend server execution tests only when a shared parser/normalizer changes.
