# Phase 1 — Effective State and Validation

Depends on accepted [Phase 0](phase-0-shared-contracts-and-baseline.md). Read the [plan](../PLAN.md) and [status](../status.md).

## Outcome

Users can distinguish valid, effective, empty, inherited, unchanged, and invalid state before saving or generating.

## Bounded Slices

1. Update Agent Preset cards to show **Empty — no Agents configured** when appropriate. Keep disabled/incomplete/invalid/model-not-ready labels, and use **Ready** only for an executable plan. Put raw IDs and low-level phase keys in a Technical details disclosure; keep a plain-language before/after and usage summary visible.
2. Turn the no-Agent state into a workflow: explain create → add to preset, provide **Create Agent**, preserve the current Preset draft while the Agent drawer is open, return focus to the invoking control, and refresh the Agent picker after accepted or queued reconciliation.
3. Add Agent editor issue presentation:
   - selected-but-unused and used-but-unselected prepared inputs;
   - empty instruction and generated default-name warnings;
   - invalid ChatML, undefined local references, and incompatible strict-output errors;
   - field-linked messages and an issue summary that moves focus to the target.
4. Make Agent and Preset footers explain disabled Save as **No changes**, **Fix N issues**, or **Waiting for the current change**. Keep Save/Cancel outside the scroll body and protect unsaved drafts on backdrop, Escape, nested creation, and writer loss.
5. In BardWiki overrides, render the effective value beside every inherited choice from `chatResource.effectiveSettings`. Preserve `inherit`/blank in the draft and ensure saving an unrelated override does not materialize inherited values.

## Acceptance

- Empty, ready, and blocked preset cards match the shared resolver plus enabled-use count in component tests.
- Empty/generic Agent warnings do not block legal records; actual grammar/reference errors do block save with a field-specific recovery path.
- Selected prepared context cannot be silently ineffective without an on-screen warning and one-step repair.
- Disabled Save always has one current reason, and stale async outcomes cannot replace a newer issue state.
- BardWiki inherited labels update after resource refresh while the user's unrelated override draft remains intact.

Use focused tests for `src/lib/Setting/Pages/AgentPresetSettings.svelte`, the shared Agent record/resolver helpers, `src/ts/agents.ts`, `src/ts/agentPresets.ts`, and `src/lib/ChatScreens/BardWikiWorkspace.svelte`. Add server tests only if a canonical validator changes; presentation-only warnings require no command schema change.
