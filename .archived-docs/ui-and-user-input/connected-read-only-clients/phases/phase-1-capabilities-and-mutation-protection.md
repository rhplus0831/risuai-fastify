# Phase 1: Capabilities and Mutation Protection

Dependency: Phase 0 accepted. Progress belongs in [status](../status.md).

## Outcome and Owners

Reading/navigation and writer authority have independent admission rules.
Reader-reachable actions cannot mutate shared data or start writer effects.
Keep new public behavior behind the selected rollout boundary.

Primary inventory owners: B01, B03, B05–B09. In particular,
`src/ts/startupReadiness.ts`, `src/ts/server/activeWriterSession.ts`,
`src/ts/server/commands.ts`, `src/ts/server/ownerMutationLifecycle.ts`,
`src/App.svelte`, and plugin mutation adapters.

## Bounded Slices

### 1a. Live role and capabilities

- Implement the Phase 0 role/connectivity owner and narrow selectors. An
  observer may render/load/navigate supported read surfaces while ordinary
  mutation and generation submission remain false. Writer readiness still
  requires server ownership, pending recovery, and coherent resources.
- Revoke mutation synchronously on authoritative writer loss or stale-writer
  rejection. A later callback cannot restore it from an earlier bootstrap.
- Preserve first-run/recovery transport exceptions without granting ordinary
  UI access. Update shared startup telemetry types/tests if public capability
  shapes change; keep package dependency direction intact.

### 1b. Mutation and background boundaries

- Guard command admission and execution, direct mutation transports, debounced
  owners, lifecycle flushes, hotkeys, and programmatic mutation paths.
- Separate reader-safe refresh subscriptions from owner flush/replay services.
  Define cancellation/epoch checks before service separation exposes them to
  permanent readers. Preserve already-staged work and accepted receipts.
- Replace reader-reachable command-unavailable local mutation fallbacks with
  explicit read-only behavior. Inventory plugin storage, character setters,
  script hooks, provider/media operations, and callbacks already in flight.
- Allow display dependencies only under a proven observer-safe contract.
  Server read permission and a non-mutating HTTP verb alone do not establish
  that invoking a feature has no side effects.

### 1c. UI and teardown contract

- Give mutating controls explicit disabled/hidden states and a route-level
  write-access affordance where necessary. Keep text selection, scrolling,
  links, and permitted navigation usable; remove reliance on global interaction
  freeze only as the guarded path becomes complete.
- Provide draft capture/retention hooks needed by later demotion before changing
  editor mounting behavior. Do not clear unsaved content to simplify role changes.
- Ensure role-specific startup/teardown is idempotent. Tests should exercise
  delayed callbacks, not only selectors set to a reader value.

## Exit Criteria and Proof

- Read readiness never implies mutation, generation submission, replay, or
  effect-claim authority. Same-session writer recovery continues to work.
- Reader attempts through visible controls, shortcuts, plugin APIs, and queued
  callbacks produce no forbidden command, durable mutation, or misleading local
  success. Independently verify stale server mutations remain rejected.
- A command waiting in a queue or owner timer cannot start after demotion;
  already-dispatched acceptance is retained for later settlement.
- Permitted controls remain keyboard/pointer accessible, and existing drafts
  survive the lifecycle hooks needed for role transitions.

Use the inventory's capability/command/plugin tests and relevant mounted UI
tests. Add concrete fault cases at the actual entry points; a test that merely
repeats a capability expression is insufficient. Record uncovered families
before Phase 2 can expose the associated surface.
Every Phase 0 entry must now have an implemented guard/read disposition or an
unreachable gated surface, with its behavioral test owner. No unclassified or
unguarded reachable entry may cross the Phase 2 boundary.
