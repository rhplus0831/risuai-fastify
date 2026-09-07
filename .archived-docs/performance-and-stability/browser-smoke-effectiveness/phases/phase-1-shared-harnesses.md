# Phase 1: Shared Harnesses

Dependency: Phase 0 accepted. Progress belongs in [status](../status.md).

## Outcome

Every shared control has an accurate contract, and confirmed common bypasses or
unreliable assertions are repaired before their consumers are treated as proof.

## Bounded Slices

| Slice                       | Source owners                                                                                                     | Review and possible repair                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hook controls               | `src/ts/server/browserSmoke.ts`, hook types and consumers                                                         | Classify every call. Preserve read-only observations. A direct setter may establish unrelated setup; a claimed user action needs the relevant real UI/production transition. `patchRuntimeSettings` already uses the durable dispatch path; confirm its callers rather than replacing it mechanically. |
| Harness and fixtures        | `server/fastify/browser-smoke/fastBootstrapHarness.ts`, embedded harnesses, auth/setup/teardown, fixture builders | Trace import/schema/storage provenance, per-test ownership, reset behavior, cleanup, and differences from production. An import fixture does not prove UI authoring. A shared server is acceptable only with explicit state ownership and reproducible cases.                                          |
| Faults and browser controls | Request holds/failures, synthetic events, viewport/clipboard/visibility overrides, scheduler controls             | Preserve application processing between the external condition and assertion. Review whether the control pre-completes the transition, serializes away a race, or replaces the result under test.                                                                                                      |
| Assertions and execution    | Integration artifact readers, render/readiness helpers, Playwright/focused/aggregate/CI wiring                    | Reject missing/stale evidence and empty samples when they would manufacture success. Distinguish built versus executed tests and reviewed versus skipped matrices.                                                                                                                                     |

The [inventory](../inventory.md) owns the full list. Inspect
`src/appStartup.ts`, `src/ts/observerShellFlag.ts`,
`src/ts/storage/fastifyStorage.ts`, and
`src/ts/process/generationPersistenceState.ts` for smoke-only installation,
observer, auth, and refresh behavior. Document actual exclusions; do not make a
blanket production-equivalence claim.

## Repair Rules

- Change helpers only for a demonstrated consumer problem. Avoid a new universal
  browser fixture framework or wholesale migration to UI-driven setup.
- Check negative conditions: a wait must fail when its event never arrives; an
  evidence reader must fail on missing required observations; an empty sampled
  set must not pass a promised visibility/anchoring check vacuously.
- For required final artifacts, define completeness from the expected scenario
  identities and invocation mode, including current-run provenance. Check the
  recovery artifact's array-only validation against that contract. Preserve
  legitimate focused/partial diagnostics without treating them as full-suite
  evidence; avoid arbitrary universal minimum counts.
- Prefer observable barriers for state transitions. Keep controlled delays or
  continuous input where they are the condition needed to reproduce the race.
  Tracing/profiling can alter scheduling; preserve the regression's documented
  measurement conditions and useful failure artifacts.
- A shared helper change requires a consumer inventory and focused execution of
  each affected spec, not only a unit test that repeats the helper's algorithm.
- Protect read-only and fault controls from unintentionally changing application
  semantics. Never weaken production invariants to simplify test setup.

## Exit Criteria

- Each shared owner and each behavior-driving call has a classification and
  known limits in the inventory.
- Material helper/assertion repairs have relevant fault-detection evidence and
  focused consumer passes tied to the same source.
- Remaining controls are retained with a reason, rather than declared safe from
  their name or number of consumers.
- Execution wiring accurately identifies focused, agent-aggregate, full-browser,
  and conditional owners. No unnecessary new runner or gate was introduced.

After a completed implementation batch, follow the plan's aggregate and
documentation validation rules. Record confirmed production defects separately
from helper cleanup and repair them with focused regressions.
