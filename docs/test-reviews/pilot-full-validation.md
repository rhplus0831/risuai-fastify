# Full repository validation after the pilot wave

On 2026-09-21, the user requested one full `pnpm test:all` run after the
[three pilot reviews](../TEST-REVIEW-WORKLIST.md#completed-pilot-wave). The run
started at `2026-09-21T13:12:03.641Z` on clean revision
`03c66265a116eb33432869dd520d55af4ad67b72` and finished in 9.46 minutes.
No tracked files changed during that run.

## Results

The aggregate command exited 1 because the architecture inventory inside
`pnpm check:server` was stale. Every other lane passed, and no test runner
reported a failed test.

| Lane                                                              | Result                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Frontend tests                                                    | 787 files; 9,799 passed, 3 skipped                                                        |
| Server tests                                                      | 260 files; 4,662 passed, 3 skipped                                                        |
| Full browser smoke suite                                          | 170 passed                                                                                |
| UI coverage gate                                                  | 8 files; 249 passed; coverage gate passed                                                 |
| Current compatibility harness                                     | 2 files; 18 passed                                                                        |
| Realm import scale gate                                           | 1 passed; 29 unselected cases skipped by the name filter                                  |
| Isolated frontend performance gates                               | 2 files; 6 passed                                                                         |
| Frontend check                                                    | Passed with zero errors and warnings                                                      |
| Browser-smoke build                                               | Passed                                                                                    |
| Test topology, documentation, compatibility registers, formatting | All passed                                                                                |
| Server and browser-smoke typecheck lane                           | Initially stopped at stale architecture inventory; corrected and rerun as described below |

Lane counts are reported separately because the coverage and dedicated gate
commands have their own selection rules. This run does not complete any pending
worklist audit or establish exhaustive behavioral or mutation coverage.

## Inventory correction

The live inventory still referred to the original bootstrap and chat-command
test files from before their earlier splits. The generated observation moves
those references to the current suites and helper, with a net increase of five
`getDatabase` references: four in bootstrap tests and one in chat-command tests.
The chat-command `setDatabaseLite` references move between files while their
total stays at 18. These changes predate the three pilots.

Regenerated the consumer records in
[`client-resource-baseline.json`](../../.archived-docs/architecture-and-migration/client-resource-ownership/client-resource-baseline.json)
using `pnpm exec tsx util/architecture-inventory.ts --print-client-resources`,
reviewed the diff, and updated the corresponding
[`owner-api-gap-matrix.json`](../../.archived-docs/architecture-and-migration/client-resource-ownership/owner-api-gap-matrix.json)
reference count from 4,284 to 4,289. All changed records remain test fixtures.
The nine policies, 30 consumer groups, zero bridge families, 16 reviewed seam
markers, owner mappings, and review metadata are unchanged. Production code,
test behavior, and inventory enforcement are unchanged.

## Follow-up validation

The affected `pnpm check:server` lane was rerun after the correction and exited
`0`. Protocol, shared-core, Fastify, and browser-smoke typechecks all passed, as
did the architecture inventory. The inventory reports 4,289 test-fixture
references across the same 30 groups and nine owner-gap rows.

The original aggregate log remains `latest-test-all.log` in the repository root;
it correctly retains the failed aggregate status. The follow-up log is
`/tmp/risuai-check-server-after-inventory.log`. Both are local execution artifacts;
this report preserves the findings in version control. The full aggregate is
not repeated for this inventory-only correction: the failed lane is rerun,
alongside documentation and formatting validation for these records.
