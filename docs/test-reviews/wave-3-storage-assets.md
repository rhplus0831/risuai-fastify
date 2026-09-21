# Storage and assets review, third wave

Reviewed on 2026-09-21 from `bf99853b10f491f5cb56ccbb51a771f1fecf7658` in an
isolated worktree. The committed changes contain only the three owned test
files and this report; temporary production mutations were restored byte for
byte after each experiment.

| Entry   | Suite                                                                                   | Before | After | Outcome  |
| ------- | --------------------------------------------------------------------------------------- | -----: | ----: | -------- |
| TL-0022 | [legacyStorage.test.ts](../../server/fastify/__tests__/legacyStorage.test.ts)           |     13 |    14 | Improved |
| TL-0023 | [assetGc.test.ts](../../server/fastify/__tests__/assetGc.test.ts)                       |     12 |    13 | Improved |
| TL-0046 | [assetReferenceScan.test.ts](../../server/fastify/__tests__/assetReferenceScan.test.ts) |     16 |    17 | Improved |

## Findings and changes

Legacy storage already protects old bytes and temporary-file cleanup when a
write or rename fails. It also validates an entire removal batch before
removing anything. Its successful byte fixture previously contained only ASCII
text; it now contains every byte value from 0 through 255, checked independently
on disk and through the HTTP read response. A new file-flush failure case opens
the real temporary file and makes only its `sync()` reject. The request must
fail while preserving old and sibling bytes and removing temporary files.
Restoring that injected failure permits a later replacement, proving successful
write recovery with the same authenticated client and storage key.

The GC suite already covers metadata-backed references, shared references,
grace deferral and convergence, catalog membership, pending generation
finalization, missing files, and ordinary stray reclamation. Its new case
persists an asset reference directly in a raw settings row without an asset
metadata row. GC must preserve those exact bytes while removing an unrelated
old stray. An unrelated non-asset file also survives, and no asset metadata is
invented. This distinguishes valid references from the separate metadata index.

The scanner already checks source precedence, malformed shapes, signed SQLite
rowids, cancellation, scratch cleanup, scoped SQL, source non-mutation, and
ordinary multi-page collection scans. A new nested legacy fixture contains two
characters, two chats per character, and one more message per chat than the
configured source page size. Each message has its own asset reference and a
shared reference also present on the settings and character owners. Exact
reference membership and a distinct reference count protect both composite
cursor progress and deduplication across pages and owners. Active and alternate
message-table references for the last legacy chat remain included. Expected
IDs are constructed directly from the fixture; parity with the synchronous
walker is additional evidence. The fixture's generated IDs start at 1000,
separate from fixed shared/message IDs and the helper's forbidden ID, so normal
page-size tuning does not create accidental collisions. Raw settings bytes and
the primary connection's total-change count remain unchanged.

All original cases and source-specific read-cost assertions remain. No split,
shared helper, configuration edit, or production fix was needed.

## Targeted mutation evidence

Each mutation ran alone against its entire owning test file, with one worker
and file parallelism disabled. Original probes used the unchanged 13 legacy
storage, 12 GC, or 16 scanner cases; final probes used 14, 13, or 17 cases.
These are owning-suite results, not whole-repository mutation scores. Failures
were inspected at the intended assertions; none relied on import errors,
timeouts, or unrelated setup failures.

| Temporary mutation                                                                  | Original result      | Final result         | Protection                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcode the legacy write buffer through UTF-8 before writing it.                  | 13 passed            | 2 failed / 12 passed | Exact binary persistence, including non-UTF-8 bytes.                                                                                              |
| Omit `syncFile(tempPath)` before rename.                                            | 13 passed            | 1 failed / 13 passed | A file-flush failure cannot publish replacement bytes or report success.                                                                          |
| Omit temporary-file removal after a failed legacy write.                            | 2 failed / 11 passed | 3 failed / 11 passed | Existing mid-write/rename cleanup and new flush-failure cleanup.                                                                                  |
| Ignore reference membership when selecting and revalidating stray files.            | 12 passed            | 1 failed / 12 passed | Referenced bytes survive without metadata. Both guards were changed to model the same lost-membership rule; either guard alone still protects it. |
| Disable the global recent-upload grace flag while retaining per-file age checks.    | 1 failed / 11 passed | 1 failed / 12 passed | Existing upload-active deferral and later convergence.                                                                                            |
| Compare only the first key of a composite scan cursor, retaining parameter arity.   | 16 passed            | 1 failed / 16 passed | Nested character/chat/message references survive page boundaries.                                                                                 |
| Increment reference statistics for every attempted insertion, including duplicates. | 16 passed            | 1 failed / 16 passed | Reference counts describe distinct marked IDs across owners and pages.                                                                            |

Five baseline survivors are now caught. Two existing protections were confirmed.
The two scanner probes were repeated after separating the generated fixture IDs
from the fixed IDs, with the same results. This is a bounded set of plausible
regressions, not an exhaustive mutation campaign.

## Validation and conservation

Dependencies were installed locally with
`pnpm install --offline --frozen-lockfile`; no root dependency-directory symlink
was used.

Baseline and final batch commands:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/legacyStorage.test.ts server/fastify/__tests__/assetGc.test.ts server/fastify/__tests__/assetReferenceScan.test.ts --reporter=json --outputFile=/tmp/wave3-storage-baseline.json
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/legacyStorage.test.ts server/fastify/__tests__/assetGc.test.ts server/fastify/__tests__/assetReferenceScan.test.ts --reporter=json --outputFile=/tmp/wave3-storage-final.json
```

Baseline: **3 files, 41 passed**. Final: **3 files, 44 passed**.
The file/full-name/tag multiset comparison retained all 41 original identities
and added one case per suite. No cases were renamed, moved, deleted, skipped,
or retagged. All original and new cases are untagged, with existing server
runtime routing unchanged.

Every mutation used the following command with its owning suite and artifact
prefix substituted:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/<owning-suite>.test.ts --reporter=json --outputFile=/tmp/wave3-storage-<phase>-<mutation>.json
```

Session evidence lives under `/tmp/wave3-storage-*`: baseline/final JSON and
logs, `conservation.json`, per-mutation JSON/log files and summary JSONL files.
`/tmp/wave3-storage-mutations.py` records the exact source substitutions and
restores each original byte sequence in a `finally` block. The seven initial
final probes use phase `final`; the two repeated scanner probes use phase
`final-refined`. The table above preserves the durable results.

Additional validation:

```sh
pnpm exec prettier --ignore-path /dev/null --check server/fastify/__tests__/legacyStorage.test.ts server/fastify/__tests__/assetGc.test.ts server/fastify/__tests__/assetReferenceScan.test.ts docs/test-reviews/wave-3-storage-assets.md
pnpm check:docs
git diff --check
```

The coordinator owns the combined typecheck and architecture-inventory check.
This batch changes no inventory-relevant client fixture references. No aggregate
or browser suite was run in this worktree: production behavior and shared
contracts are unchanged, and focused validation covers these test changes.

## Neighboring owners and limits

[maintenanceStaging.test.ts](../../server/fastify/__tests__/maintenanceStaging.test.ts)
owns compatibility-write cancellation, maintenance conflicts, and finishing
post-rename durability during shutdown.
[activeWriter.test.ts](../../server/fastify/__tests__/activeWriter.test.ts)
owns stale-writer rejection for compatibility write/remove routes. These
matrices were not duplicated.

[assetGcScheduling.test.ts](../../server/fastify/__tests__/assetGcScheduling.test.ts)
owns GC fences, commit rollback, shutdown, deduplicated upload races, bounded
file-read concurrency, reclaim batches, and result limits.
[maintenanceCosts.test.ts](../../server/fastify/__tests__/maintenanceCosts.test.ts)
owns large maintenance-cost matrices.
[serverLoadCostHarness.test.ts](../../server/fastify/__tests__/serverLoadCostHarness.test.ts)
owns additional projected-load guards.
[generationConfiguration.test.ts](../../server/fastify/__tests__/generationConfiguration.test.ts)
owns accepted-generation asset retention and dependency pruning.
[risuSaveAssetReferences.test.ts](../../server/fastify/__tests__/risuSaveAssetReferences.test.ts)
owns the shared portable-save reference vocabulary.

This review does not simulate an actual power loss or prove filesystem crash
durability. It checks observable failure and recovery at the file-flush
boundary. The scanner fixture probes nested keyset completeness and shared
reference counts; it does not replace the neighboring load/scale gates or an
exhaustive owner-field mutation campaign. A selected-suite survivor does not
mean the rest of the repository lacked protection.
