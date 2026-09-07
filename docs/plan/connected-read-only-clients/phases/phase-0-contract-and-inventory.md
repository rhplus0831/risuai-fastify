# Phase 0: Contract and Inventory

Dependency: planning baseline only. Progress belongs in [status](../status.md).

## Outcome and Owners

Turn the [product contract](../PLAN.md#product-contract) and seed
[inventory](../inventory.md) into an executable boundary map. This phase does
not enable connected-reader behavior.

Read [server resources](../../../structure/server-resources-and-bridges.md),
[mutation recovery](../../../structure/durable-mutations-and-recovery.md),
[client runtime](../../../../src/docs/client-runtime.md), and the source owners
listed in inventory B01–B13 as needed for each boundary.

## Bounded Slices

### 0a. Current behavior and transition map

- Confirm the current source and existing observer-flag behavior, including its
  continued writer acquisition and writer-loss offline path. Record where
  current documentation describes only the visible shell rather than live sync.
- Map cold startup, same-session resume, foreign-owner startup, first-run setup,
  explicit promotion, demotion, connectivity recovery, auth loss, and database
  replacement. For each transition name the authoritative signal, services
  admitted/stopped, and conditions that enable mutation.
  Translate the plan's finite lifecycle table into selector/transition assertions,
  including each state under interrupted connectivity and delayed async work.
- Choose the live role/connectivity owner and rollout boundary. Startup
  milestones must not act as a repeatedly reset role state machine. Ensure old
  and new browser builds preserve server guard compatibility during rollout.
- Determine how a read-only startup learns the current writer without sending
  writer intent. A failed or delayed writer snapshot is not proof of no owner.
  Check same-origin tabs, duplicated session storage, and pending-owner adoption
  so a newly opened reader cannot implicitly assume another live tab's identity;
  preserve stable identity for a legitimate same-tab reload.

### 0b. Mutation, selection, and draft inventory

- Expand the inventory by actual calls, including auth-only operations and local
  mutation fallbacks. Identify allowed reader routes, blocked authoring routes,
  safe display/runtime dependencies, and the read/write admission boundaries.
- Specify local reader selection independent from shared selected-character and
  chat-page fields. Cover full refresh, resource deletion, and promotion.
- Inventory unsaved data in mounted editors. Identify existing draft owners and
  any missing preservation before demotion/unmount. Define handling for pending
  optimistic overlays without dropping intent or freezing reader hydration.
- Trace delayed commands, lifecycle keepalive, plugin effects, and generation
  finalization across a role change. Assign each to a concrete later slice.
- Assign memory/BardWiki live events and reconnect snapshots to reader-safe
  projection consumers or gated UI. Receiving an operational event must not
  start a rebuild, retry, cancellation, provider call, or durable mutation.

### 0c. Proof and implementation sequence

- Name focused tests for every risky boundary and a real two-session browser
  journey for read startup, independent browsing, and explicit switching.
- Use disposable fixtures and deterministic provider boundaries. Existing smoke
  controls may create unrelated setup; they must not bypass the role transition
  claimed by the test.
- Record the first Phase 1 slice, its owners, and its exit criteria. Refine later
  phases only where current evidence changes a dependency; retain the agreed
  six-phase scope.

## Exit Criteria

- Every named transition has an authority source and a read/write/runtime policy.
- Every in-scope mutation/side-effect family has a reader disposition and test
  owner; no required path depends on global CSS freezing for correctness.
- The bounded entry-point set is recorded with no unclassified in-scope entries;
  each later phase can identify which entries it closes or deliberately gates.
- Draft preservation, dormant intent, local selection, initial ownership
  discovery, and flag compatibility have concrete implementation decisions.
- The status and inventory distinguish verified current behavior from proposed
  behavior and unexecuted test coverage. Phase 1 has a bounded starting slice.

Run narrowly focused baseline tests only for concrete uncertainty, record their
limits, and validate changed documents. At the end of Phase 0, run
`pnpm test:all` without additional user consent before accepting the phase, as
required by the [plan](../PLAN.md#verification-and-completion). No
production-server access or data is needed for this phase.
