# Phase 1: Access and Readiness Model

## Outcome

Introduce one derived workspace presentation/access model and explicit local
versus persisted navigation semantics while preserving the current visible
ObserverShell path.

## Preconditions

- Phase 0 is accepted with current baseline evidence and numeric thresholds.
- The rollout mechanism and reader-route promotion handoff are decided.
- Current command, session, readiness, route, draft, and generation guards have
  named test owners.

## Work

1. Add a derived presentation mode equivalent to `booting`, `read-only`,
   `promoting`, and `writer`. Derive it from authenticated client-session state,
   coherent projection readiness, established reader disposition, current
   writer access, and startup capabilities.
2. Publish explicit capability selectors for local browsing, persisted writer
   route/selection application, ordinary mutation, and generation. Preserve the
   existing stricter generation dependencies.
3. Ensure an early coherent projection during an initial automatic acquisition
   is not itself an established reader disposition. An established reader must
   remain readable throughout explicit promotion and recoverable interruption.
4. Define an explicit route-display target independent of writer
   `selectedCharID`, `currentChar`, and `chatPage`. Adapt local reader intent so
   it cannot be consumed through the persisted `character.selected` path during
   promotion without a new writer action.
5. Retain generation/session/revision/lineage fences on every asynchronous
   transition. A stale mode snapshot or delayed listener cannot grant a newer
   session access.
6. Add focused selector/state-machine tests for startup, established reading,
   explicit promotion, writer recovery, writer loss, offline/interrupted state,
   cancellation/failure, auth loss, and lineage replacement.
7. Add negative route-intent tests proving no selection, `lastInteraction`,
   command, outbox, or later automatic replay occurs from reader navigation.
8. Keep current visible rendering behind its existing path; Phase 1 establishes
   contract and enforcement prerequisites, not the unified UI.

## Acceptance

- One canonical derived workspace access snapshot covers all required modes and
  capabilities without becoming an authorization source.
- Initial resolving and established-reader promotion are distinguishable without
  exposing protected content early or blanking a valid reader.
- `canBrowse`, writer route application, mutation, and generation remain
  independently testable and fail closed.
- Reader route/display state uses stable IDs and never writes writer selection
  stores or durable intent.
- Promotion cannot retroactively update reader `lastInteraction` or dispatch a
  selection command.
- Existing current-path ObserverShell, writer startup, command, draft, and
  generation behavior remains green under focused tests.

## Focused Verification

Run the affected client-session, startup-readiness, observer/read-only route
intent, router/App route-effect, character-selection, command-client-session,
and outbox denial suites. Run the smallest relevant TypeScript/Svelte check if a
shared exported type changes. Record exact commands and outcomes in `status.md`.

## Handoff

Phase 2 may consume the new access model only after its transition table and
negative route-intent guarantees pass. Do not alter bootstrap ordering in this
phase as an unreviewed side effect of selector work.
