# Connected Reader Phases

Start at [status](../status.md), read [PLAN.md](../PLAN.md), then the active phase.
The [inventory](../inventory.md) maps current source/test owners.

| Phase | Document                                                                                |
| ----- | --------------------------------------------------------------------------------------- |
| 0     | [Contract and inventory](phase-0-contract-and-inventory.md)                             |
| 1     | [Capabilities and mutation protection](phase-1-capabilities-and-mutation-protection.md) |
| 2     | [Connected read-only browsing](phase-2-connected-read-only-browsing.md)                 |
| 3     | [Explicit writer switching](phase-3-explicit-writer-switching.md)                       |
| 4     | [Live generation observation](phase-4-live-generation-observation.md)                   |
| 5     | [Verification and rollout](phase-5-verification-and-rollout.md)                         |

Each implementation slice confirms the source, names its observable outcome,
changes one cohesive boundary, and finishes with focused evidence. Shared
bootstrap/resource owners are edited sequentially. Use the project-mandated
read-only parallel research for broad architectural cross-checks.

A phase can span multiple tasks and commits. Record completed and remaining
slices only in status. Create separate slice documents when needed for a
bounded handoff; do not pre-create empty execution logs or duplicate the phase
acceptance table. Keep incomplete behavior behind the rollout boundary.

Tests are part of every phase. Apply the current aggregate/docs workflow after
the implementation batch is complete. At the end of every phase, run
`pnpm test:all` without additional user consent before phase acceptance or
handoff, and record its final-source evidence in status as required by the
[plan](../PLAN.md#verification-and-completion). Phase 5 combines the feature's
contracts and records release evidence; it is not the first correctness check.
