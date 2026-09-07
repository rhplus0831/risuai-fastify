# Browser Smoke Phases

Read [status](../status.md) for the current slice, [plan](../PLAN.md) for scope,
[inventory](../inventory.md) for coverage, and [findings](../findings.md) for
decisions and evidence. Read only the phase needed for the current work.

| Phase | Document                                                          |
| ----- | ----------------------------------------------------------------- |
| 0     | [Inventory and pilot](phase-0-inventory-and-pilot.md)             |
| 1     | [Shared harnesses](phase-1-shared-harnesses.md)                   |
| 2     | [Critical journeys](phase-2-critical-journeys.md)                 |
| 3     | [Remaining scenarios](phase-3-remaining-scenarios.md)             |
| 4     | [Verification and closeout](phase-4-verification-and-closeout.md) |

Each slice confirms its source, records a testable outcome before editing,
repairs one cohesive boundary, and ends with focused proof and a finding
disposition. Keep implementation edits sequential for shared owners. Create
additional slice files only when needed for independent review; do not duplicate
the status cursor, finding register, or execution command inventory.

At the end of every phase, run `pnpm test:all` without additional user consent
before phase acceptance or handoff, and record its final-source evidence in
status as required by the [plan](../PLAN.md#validation-and-completion).
