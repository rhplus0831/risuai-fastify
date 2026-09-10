# Phase 2 — Destructive Safety and Persistence Feedback

Depends on accepted [Phase 1](phase-1-effective-state-and-validation.md). Read the [plan](../PLAN.md) and [status](../status.md).

## Outcome

Destructive actions disclose their actual dependency consequences, remain visually separate from routine actions, and preserve queued/failure recovery semantics.

## Bounded Slices

1. Replace the generic Agent Preset deletion prompt with the Phase 0 impact model. Name the preset, show default/chat/loadout categories, list a bounded set of affected owners, explain each post-delete fallback, and require an explicit destructive confirmation.
2. If reference owners are loading, stale, malformed, or unavailable, disable deletion and show how to retry the impact read. Do not issue the delete command with a partial preview.
3. After submission, retain the current optimistic rollback and authoritative refresh path. Announce Saving, Pending sync, accepted cleanup counts, and failure. A queued command keeps its intent and never presents server success.
4. For Agent cards, replace the unexplained disabled trash icon with **Used by N presets** details and links/actions that identify the blocking preset uses. Preserve the server-side hard rejection.
5. Preserve Input Hook's existing named confirmation, retained failed draft, Retry, Saving/Pending sync/Saved/error messages, and focus recovery. Add any missing interaction assertions, including a newer edit winning over an older settlement; do not replace this working path with a speculative shared abstraction.
6. Define the danger section used later by row overflow menus: target-bearing accessible name, visual separator, cancellation without mutation, and focus restoration to the trigger.

## Acceptance

- A user can predict every reference change before preset deletion, including fallback to a remaining global default.
- Cancel performs no command or optimistic mutation; accepted, queued, failed, and stale completion cases retain their current data-integrity guarantees.
- Agent deletion explains dependencies instead of relying on a disabled control alone.
- Hook autosave and deletion cases from the review are closed with DOM interaction evidence.
- Destructive labels and announcements do not rely on red alone.

Use focused tests for `src/lib/Setting/Pages/AgentPresetSettings.svelte`, `src/ts/agentPresets.ts`, `src/ts/agents.ts`, `server/fastify/__tests__/agentPresetDeletionSafety.test.ts`, `src/lib/Setting/Pages/InputHookSettings.svelte`, and the shared alert/popup owner if it changes.
