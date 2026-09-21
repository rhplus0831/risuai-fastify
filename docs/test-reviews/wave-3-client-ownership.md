# Client ownership and readiness review

Reviewed 2026-09-21. Batch **wave-3-client-ownership**, from baseline
`bf99853b10f491f5cb56ccbb51a771f1fecf7658`.

| Entry   | Test file                                                                            | Outcome  | Passing cases before → after |
| ------- | ------------------------------------------------------------------------------------ | -------- | ---------------------------: |
| TL-0019 | [commands.clientSession.test.ts](../../src/ts/server/commands.clientSession.test.ts) | Improved |                      18 → 19 |
| TL-0021 | [startupReadiness.test.ts](../../src/ts/startupReadiness.test.ts)                    | Improved |                      15 → 17 |
| TL-0028 | [connectedTabIdentity.test.ts](../../src/ts/server/connectedTabIdentity.test.ts)     | Improved |                        7 → 8 |
| TL-0047 | [clientSession.test.ts](../../src/ts/clientSession.test.ts)                          | Improved |                      15 → 25 |

All **55 original cases** retain their full names, files, tags, and runtime
routing. The final batch passes **69/69**, with no skips. No tests were removed,
split, or moved. Production code, shared helpers, configuration, and architecture
inventories are unchanged.

## Review and changes

The audit followed the contracts in [commands.ts](../../src/ts/server/commands.ts),
[startupReadiness.ts](../../src/ts/startupReadiness.ts),
[connectedTabIdentity.ts](../../src/ts/server/connectedTabIdentity.ts), and
[clientSession.ts](../../src/ts/clientSession.ts).

**TL-0019:** Existing tests protect reader denial before auth, recovery-only
transport, deadlines across auth/fetch/body/bootstrap/receipt boundaries, explicit
cancellation, stale queues, old receipts and revision conflicts, writer-loss
responses, and reconciliation retirement. Ordinary commands already tested a
held auth response across demotion and promotion; receipt acknowledgement had
only deadline and reader-admission checks. The added case proves an old receipt
request cannot dispatch after auth resolves under a newly promoted writer. A
fresh acknowledgement then succeeds, with independently asserted endpoint,
method, auth header, mutation ID, count, and lineage. Both promises settle; the
fresh writer remains authorized.

**TL-0021:** Existing tests cover monotonic milestones, duplicate signals,
capability dependencies, privacy-safe failures, targeted retries, writer
revocation, generation recovery, background settlement, and milestone timeouts.
The old-owner test used a completed replacement, so deleting a newer pending
step from the in-flight cache went unnoticed. It now holds the replacement
pending while the retired owner finishes, then requires another caller to share
the replacement and preserve its successful cached result. Two new cases change
the managed session before dispatch and during held work. They require rejection
of the retired step, no stale certification, and a successful fresh step whose
cached result prevents duplicate work. Every held operation is released and
awaited on the passing path.

**TL-0028:** Existing tests protect reload reuse, duplicated session storage,
reader fallback, concurrent resolution, stale lock callbacks, and insecure-origin
randomness. The Web Locks fake deliberately controls acquisition but ignores
request options. Independent assertions now require the literal lock namespace,
`mode: 'exclusive'`, and `ifAvailable: true` on initial and duplicate-page claims.
These options protect exclusive ownership and avoid waiting behind a suspended
page. The added same-page release case requires the held lock to disappear and a
subsequent resolution to acquire it again. The existing reload and fallback
cases remain. Cached identity is compared by value; call counts establish the
absence of extra acquisition without requiring object identity.

**TL-0047:** Existing cases cover reader/writer transitions, preview-versus-reader
content, interruption, explicit promotion, draft capture before UI publication,
diagnostic failure isolation, authentication loss, lineage changes, stale frames,
and superseded operations. New cases require recovery to wait for a live
connection even when ownership and projection are ready, reject copied operation
tokens, and reject eight malformed ownership fixtures: empty lineage; negative,
fractional, unsafe, and NaN epochs; and empty, blank, or overlong writer IDs.
Rejections preserve an independently cloned pending snapshot and leave the
original operation usable. Each fixture then completes valid epoch-zero writer
recovery, so rejecting every ownership value cannot satisfy the test.

Adjacent ownership remains with the bootstrap readiness/lifecycle/switching,
connected startup, workspace/App route, command queue/replay, reader sync, and
draft-recovery suites documented in
[Browser State Sync and Recovery](../tests/browser-state-sync-and-recovery.md).
No duplication justified deletion or a mechanical split.

## Targeted mutation evidence

Each experiment changed one production behavior and ran the **entire owning
file** with one worker, restoring the source in `finally` and comparing its bytes
before proceeding. All **11 selected mutants survived the original owning
files** and fail their intended assertions after improvement. This is bounded
fault evidence, not an exhaustive mutation score. No failure depended on syntax,
compilation, import, or harness errors.

| ID                  | Temporary behavior change                                              | Whole owning file, original → final cases | Final detecting assertion                                                            |
| ------------------- | ---------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| lock-mode           | Request a shared Web Lock.                                             | Tab identity, 7 → 8                       | Initial and duplicate acquisitions must request exclusive mode.                      |
| lock-no-wait        | Set `ifAvailable` to false.                                            | Tab identity, 7 → 8                       | Both acquisition paths must request immediate availability.                          |
| release-cache       | Preserve the resolved identity during release.                         | Tab identity, 7 → 8                       | Same-page resume must make a second acquisition and hold its lock.                   |
| step-generation     | Ignore the managed session generation in startup steps.                | Readiness, 15 → 17                        | Retired pre-dispatch and pending work must reject.                                   |
| step-cleanup        | Unconditionally delete the step's in-flight cache entry on settlement. | Readiness, 15 → 17                        | A concurrent caller receives the pending replacement, never the unexpected fallback. |
| operation-identity  | Accept any operation token with the current generation.                | Client session, 15 → 25                   | A copied token cannot authenticate or finish the real operation.                     |
| ownership-epoch     | Remove safe-integer validation of ownership epochs.                    | Client session, 15 → 25                   | Fractional, unsafe, and NaN epochs cannot authenticate.                              |
| ownership-writer-id | Remove writer-ID shape validation.                                     | Client session, 15 → 25                   | Empty, blank, and overlong writer IDs cannot authenticate.                           |
| ownership-lineage   | Accept an empty ownership lineage.                                     | Client session, 15 → 25                   | The empty-lineage fixture remains unauthenticated.                                   |
| recovery-live       | Allow recovery completion without a live connection.                   | Client session, 15 → 25                   | Connecting recovery must remain incomplete.                                          |
| receipt-generation  | Remove the generation fence from receipt acknowledgement.              | Commands/client session, 18 → 19          | The held old-auth acknowledgement returns false without fetching.                    |

The release-cache and four ownership/token mutants were repeated after changing
snapshot assertions to independent cloned values and avoiding cached identity
object-equality constraints. They still fail the intended assertions.

## Validation and retained evidence

Baseline and final restored-source commands:

```sh
pnpm exec vitest run --config vitest.config.ts src/ts/server/commands.clientSession.test.ts src/ts/startupReadiness.test.ts src/ts/server/connectedTabIdentity.test.ts src/ts/clientSession.test.ts --no-file-parallelism --maxWorkers=1 --reporter=json --outputFile=/tmp/wave3-client-baseline.json
pnpm exec vitest run --config vitest.config.ts src/ts/server/commands.clientSession.test.ts src/ts/startupReadiness.test.ts src/ts/server/connectedTabIdentity.test.ts src/ts/clientSession.test.ts --no-file-parallelism --maxWorkers=1 --reporter=json --outputFile=/tmp/wave3-client-final.json
```

Both passed: **55/55** baseline and **69/69** final. Runtime full-name/tag
comparison records **55 retained, zero missing, 14 added** in
`/tmp/wave3-client-conservation.json`. Existing tags and routing are unchanged.

Exact mutation replacements, selected files, commands, and per-run JSON/logs are
retained locally in `/tmp/wave3-client-mutations.py`,
`/tmp/wave3-client-mutations-baseline.json`,
`/tmp/wave3-client-mutations-final.json`, and
`/tmp/wave3-client-mutations-review.json`. These temporary files are host-local
execution evidence; this report preserves the scope and results durably.

Prettier, `pnpm check:docs`, and `git diff --check` passed. Production restoration
was verified with:

```sh
git diff --exit-code -- src/ts/server/commands.ts src/ts/startupReadiness.ts src/ts/server/connectedTabIdentity.ts src/ts/clientSession.ts
```

No aggregate fixture references changed. The integration coordinator owns
combined typechecks and architecture validation. No full repository aggregate
was run for this localized test-only batch.

Network/auth, browser diagnostics, Web Locks, session storage, and page-module
lifecycles remain controlled test boundaries. These checks do not establish real
browser suspension, actual network authentication, mounted UI behavior, or
persistence. No production defect was found and no selected mutant remains
undetected.
