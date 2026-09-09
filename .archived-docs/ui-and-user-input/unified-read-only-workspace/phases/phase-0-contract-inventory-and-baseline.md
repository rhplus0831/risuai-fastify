# Phase 0: Contract, Inventory, and Baseline

## Outcome

Ratify the product state/action matrices, verify every current source and test
owner, reproduce the observer-to-writer cost, select one rollout mechanism, and
freeze performance comparison rules before runtime behavior changes.

## Preconditions

- Read [status](../status.md), [PLAN.md](../PLAN.md), and
  [inventory](../inventory.md).
- Treat the three completed reader workstreams as closed predecessor evidence.
- Start from a clean understanding of the current source revision; do not assume
  the ignored local performance artifact is current.

## Work

1. Recheck the complete initial startup path from App mount through ownership
   discovery, early reader projection, automatic acquisition, writer recovery,
   post-replay shell, event subscription, route application, chat readiness, and
   background readiness.
2. Confirm which automatic-writer cases currently issue two shell requests and
   which reader, error, authentication, initialization, takeover-denial,
   reconnect, and recovery cases require a different sequence.
3. Audit every UI and alternate entry point in the inventory. Expand the matrix
   for any control, delegated handler, hotkey, drop, plugin/script callback,
   timer, or held asynchronous continuation that can persist selection, mutate,
   generate, open a restricted surface, or create/restore a draft.
4. Record the current interface/data dependencies of writer Sidebar,
   SideChatList, Home, grid, ChatScreen, DefaultChatScreen, ReaderNavigation,
   ReaderTranscript, Chats, Chat, ChatBody, and promotion/status owners. Identify
   the smallest presentation extractions and the controller boundary for each.
5. Decide the concrete derived workspace mode/capability API and the established
   reader-versus-initial-resolving signal. Confirm no proposed field duplicates
   writer authority.
6. Decide the exact route-display handoff that preserves a reader URL after
   promotion without retroactively dispatching selection or updating
   `lastInteraction`.
7. Select one whole-path rollout mechanism, its old/new cohorts, smoke control,
   telemetry dimension, and removal trigger. Avoid independently combinable
   subfeature flags.
8. Regenerate small/large, cold/warm startup evidence with identical fixtures and
   environment. Record role/readiness timings, shell/resource requests,
   JavaScript transfer/decoded sizes, cache state, mount counts, long tasks, and
   role-transition geometry/shift evidence.
9. Ratify numeric median/tail regression thresholds, repetition count, variance
   handling, and any expected first-paint tradeoff before implementation.
10. Add only semantic diagnostic/test hooks needed to make the baseline
    reproducible. Do not change user-visible startup or reader behavior.

## Acceptance

- The source/action/test inventory is complete and each entry has an explicit
  future guard/presentation owner.
- The established-reader versus initial-resolving state is defined without a
  mutable read-only authority flag.
- Reader route handoff has an implementation-ready design that cannot update
  `lastInteraction` without a new writer-mode action.
- One rollout mechanism and retirement rule are recorded.
- Reproducible baseline artifacts record environment, fixtures, repetitions,
  raw outputs, shell request counts, readiness timings, bundles, mounts, long
  tasks, and transition geometry.
- Numeric comparison thresholds are recorded before Phase 1 begins.
- At least one deterministic assertion reproduces the duplicated automatic-writer
  shell read or the relevant current transition behavior.
- No production behavior change is included beyond minimal semantic measurement
  hooks.

## Focused Verification

Run the existing startup/readiness/App tests needed to prove the baseline and
the smallest fast-bootstrap measurement/browser commands that generate the
recorded artifacts. Planning and measurement-hook documentation also requires
the explicit plan validation from [the phase index](README.md#plan-document-validation),
`pnpm check:docs`, formatting, and whitespace checks. Record exact commands and
results in `status.md`.

## Handoff

Phase 1 begins only after the state contract, route-handoff rule, rollout choice,
and performance thresholds are fixed. Any protocol, server, or durable-schema
need discovered here must be recorded and evaluated against the plan's
replanning triggers before implementation.
