> This snapshot predates the Phase 5 deletion; `docs/test-reviews/core-suite-phase-5.md` records what was removed.

# Priority Test Review Worklist

The [worklist data](TEST-REVIEW-WORKLIST.json) is the authoritative progress record
for reviewing and improving the selected entries in the
[test priority inventory](TEST-LIST.md). Edit the JSON when claiming or completing
work; this guide explains how to use it.

Created 2026-09-21 from the inventory's 2026-09-19 snapshot at `528c6d62b`.
Selection is **all Critical entries**, including Occasionally, plus **High
entries whose Frequency is Frequently or Often**.

## Starting scope

| Snapshot selection        | Original entries | Registered cases |
| ------------------------- | ---------------: | ---------------: |
| Critical, every frequency |              202 |            4,966 |
| High, Frequently or Often |              241 |            4,898 |
| Total                     |              443 |            9,864 |

At creation, six previously completed reviews are imported as `improved`; the
remaining 437 entries are `pending`. The 443 original entries map to 508 distinct
current files after the documented splits. These are starting figures, not live
progress counters or passing-test totals. Counts and ratings belong to the
historical inventory; no test cases were recollected or executed to create this
worklist.

The original entry is the unit of progress. Moving its cases into several files
does not create several new review obligations. Conversely, running an adjacent
suite as validation does not complete that suite's own review. For example,
`TL-0006` includes the hydration refactor, while `TL-0297` (reactive consumers)
remains pending. The outbox's reader and cross-tab suites also remain separate
pending entries.

The outbox work-cost file is both a destination for moved cases and a pre-existing
Low-priority inventory entry (rank 961). Listing it under `TL-0001` records where
selected coverage moved; it does not add that separate Low-priority entry to the
campaign or claim its entire independent review is complete.

## Record fields

Each object in `entries` has these fields:

| Field          | Meaning and maintenance rule                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`           | Stable `TL-` identifier derived from the original snapshot rank. Never renumber it when files move or priorities change.                                                                                                                   |
| `original`     | Snapshot rank, path, severity, frequency, registered case count, and protected-behavior description copied from the inventory. Keep these immutable; the description is an inherited coverage claim to verify, not a new audit conclusion. |
| `currentFiles` | Explicit repository-relative files that now own the original coverage. Update after splits, moves, or consolidation. Helpers that register no tests do not belong here.                                                                    |
| `status`       | One of the states below. A passing baseline alone does not complete a review.                                                                                                                                                              |
| `batchId`      | Named batch responsible for this entry, or `null` until assigned. The `completed-` values identify imported historical work.                                                                                                               |
| `owner`        | Current responsible task/person, or `null` when unassigned. Include a task or worktree reference when work is parallel.                                                                                                                    |
| `review`       | `null` until there is evidence to record; otherwise record the outcome, evidence, validation, and remaining gaps.                                                                                                                          |

`source.mappingRevision` identifies the checkout used to establish the initial
file mapping. Pending entries initially point to their original files, all of
which existed at that revision; their behavior has not been re-audited.

Review records use `completedOn`, `summary`, `reportedFamilyCases`, `evidence`,
`validation`, and `remainingGaps`. Use `completedOn: null` while unresolved.
`reportedFamilyCases` is optional evidence from a collection or review, not an
automatically maintained total; use `null` when unknown. Evidence contains
`commits`, `documents`, and `tasks`. Validation records its `basis`, `checks`,
and `limitations`. Put outstanding issues and the next action in `remainingGaps`.
An empty list on an imported completed review means no outstanding issue was
carried forward from those records; it does not assert exhaustive coverage.

## Status and completion rules

| Status               | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `pending`            | Not yet audited.                                                                                         |
| `in_progress`        | Claimed by an owner in a named batch.                                                                    |
| `verified_unchanged` | Reviewed and validated with evidence; no changes needed.                                                 |
| `improved`           | Assertion or maintainability improvements completed with evidence.                                       |
| `consolidated`       | Coverage intentionally transferred or removed with an explicit equivalent owner and supporting evidence. |
| `unresolved`         | Work remains; record the gap and next action.                                                            |

The completed outcomes are `verified_unchanged`, `improved`, and `consolidated`.
Before using one, record:

1. The behaviors reviewed and the boundary actually exercised, including relevant
   neighboring coverage and any implementation-coupled assertions.
2. Validation evidence appropriate to the impact. For mutation experiments,
   distinguish baseline success, the intended assertion failure under the
   mutation, and success after restoration. Explain surviving mutations rather
   than treating every survivor as a missing test.
3. Where original cases now live, including intentional additions or removals
   and preservation of tags and runtime routing. A matching total alone is not
   proof of preservation.
4. Any material gaps. Leave work `unresolved` if a required check or coverage
   decision remains open.

Use the conditional validation policy in [AGENTS.md](../AGENTS.md) and
[Testing And Operations](structure/testing-and-operations.md). The worklist is
not a new test runner or a change to suite selection. Do not change `core` tags
merely because a row is high priority.

## Imported completed reviews

These six reviews are carried forward from the
[post-snapshot updates](TEST-LIST-UPDATE.md), current coverage-ownership guides,
commit history, and the supplied related tasks. Exact current filenames and
evidence references are stored in each JSON entry. Prior validation is explicitly
marked as imported and was not rerun for this worklist.

| ID        | Original coverage family              | Current files | Coverage map                                                                                             |
| --------- | ------------------------------------- | ------------: | -------------------------------------------------------------------------------------------------------- |
| `TL-0001` | Pending mutation outbox               |             5 | [Browser state sync and recovery](tests/browser-state-sync-and-recovery.md)                              |
| `TL-0002` | Browser bootstrap                     |            11 | [Bootstrap ownership](tests/browser-state-sync-and-recovery.md#bootstrap-coverage-ownership)             |
| `TL-0003` | Fastify commands                      |            20 | [Command ownership](tests/persistence-commands-and-events.md#command-coverage-ownership)                 |
| `TL-0004` | Chat commands                         |             8 | [Chat command ownership](tests/domain-mutations-and-editing-bridges.md#chat-command-coverage-ownership)  |
| `TL-0005` | Browser command adapters              |            21 | [Browser command ownership](tests/browser-state-sync-and-recovery.md#browser-command-coverage-ownership) |
| `TL-0006` | Chat and character-lorebook hydration |             6 | [Hydration ownership](tests/browser-state-sync-and-recovery.md#chat-hydration-coverage-ownership)        |

## Completed pilot wave

The first three batches completed on 2026-09-21:

| Batch report                                           | Entries              | Baseline → final cases | Outcome                                                                     |
| ------------------------------------------------------ | -------------------- | ---------------------: | --------------------------------------------------------------------------- |
| [Provider execution](test-reviews/pilot-providers.md)  | `TL-0007`, `TL-0008` |              199 → 209 | Dispatch verified unchanged; completion assertions improved.                |
| [Character commands](test-reviews/pilot-characters.md) | `TL-0009`            |                88 → 90 | Payload, settlement, selection, and Hypa assertions improved.               |
| [Persistence](test-reviews/pilot-persistence.md)       | `TL-0012`, `TL-0016` |                60 → 65 | Migration, constraint, message-column, and write-scope assertions improved. |

Integration retained all 347 original cases and passed all 364 resulting cases:
274 in the four-file Fastify batch and 90 in the character suite. Client and
Fastify typechecks passed. The batches detected all 24 sampled mutations after
improvement; reports distinguish newly caught regressions from existing
protection. No production source, configuration, test ownership, or tags changed,
and no split or deletion was needed. These are focused results, not a full-suite
or exhaustive mutation claim.

A subsequent user-requested [full repository validation](test-reviews/pilot-full-validation.md)
ran every `pnpm test:all` lane. The report records the results and the stale
architecture inventory discovered in the server-check lane, its correction,
and follow-up validation. This integration check does not complete additional
worklist audits.

The wave completed five additional original entries, bringing recorded outcomes
to ten `improved`, one `verified_unchanged`, and 432 `pending` at that checkpoint.
Use the JSON queries below for subsequent progress. The reports retain each
batch's limitations, commands, and sizing observations. Review and mutation
interpretation dominated execution time; continue grouping by shared behavior
and fixture ownership rather than treating every file as a separate task.

## Completed second wave

Eight Critical entries completed on 2026-09-21 in three isolated batches:

| Batch report                                                                 | Entries                         | Baseline → final cases | Main improvements                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------- | ---------------------: | --------------------------------------------------------------------------------------------------------------------- |
| [Generation transport](test-reviews/wave-2-generation-transport.md)          | `TL-0010`, `TL-0025`            |               97 → 103 | Operation/job identity, replay effects, Stop, retained error text, UTF-8 framing, cancellation, and tool controls.    |
| [Bootstrap and reader authentication](test-reviews/wave-2-bootstrap-auth.md) | `TL-0011`, `TL-0014`, `TL-0018` |               99 → 118 | Independent wire headers, numeric revisions, auth-loss classification, acquisition fallback, and superseded rereads.  |
| [Server reads and mutation scope](test-reviews/wave-2-server-reads.md)       | `TL-0013`, `TL-0015`, `TL-0017` |               86 → 100 | Canonical owner conflicts, nonempty module selection, range validation, and persisted effects alongside read budgets. |

All eight outcomes are `improved`. Integration passes **321 tests**: 221 in
five frontend files and 100 in three server files, with no skips. All 282 original
file/full-name/tag identities remain and 39 cases were added. Existing multi-token
and coalesced-stream behavior was retained alongside stronger fragmentation
checks. No tests moved, and production code, shared helpers, routing, and tags
are unchanged.

All 34 sampled mutations were detected after improvement. Of those, 27 survived
the original selected suites; seven were already caught. Server-read probes ran
their owning file, while the other probes ran their entire batch. These results
describe the selected suites, not a repository-wide mutation score.

`pnpm check` and `pnpm check:server` passed, including the architecture inventory
with its existing 4,289 fixture references. No inventory refresh was needed.
The earlier [full repository validation](test-reviews/pilot-full-validation.md)
remains a separate checkpoint; this wave used focused execution and typechecks.
Temporary execution evidence uses `/tmp/wave2-*`; the reports preserve findings,
commands, mutations, and limitations in version control.

This checkpoint has **18 `improved`, one `verified_unchanged`, and 424 `pending`**
original entries. Passing neighboring tests does not change their audit status.

## Completed third wave

Eleven Critical entries completed on 2026-09-21 in three isolated batches:

| Batch report                                                | Entries                                    | Baseline → final cases | Main improvements                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------ | ---------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| [Client ownership](test-reviews/wave-3-client-ownership.md) | `TL-0019`, `TL-0021`, `TL-0028`, `TL-0047` |                55 → 69 | Receipt and startup supersession, Web Locks exclusivity, operation identity, ownership validation, and live recovery.  |
| [Access and privacy](test-reviews/wave-3-access-privacy.md) | `TL-0020`, `TL-0024`, `TL-0026`, `TL-0027` |                45 → 50 | Valid-writer controls, signed-token rejection, raw SQLite secret redaction, and populated bootstrap projections.       |
| [Storage and assets](test-reviews/wave-3-storage-assets.md) | `TL-0022`, `TL-0023`, `TL-0046`            |                41 → 44 | Binary preservation, flush-failure recovery, referenced-file retention, nested scan completeness, and distinct counts. |

All eleven outcomes are `improved`. Integration passes **163 tests**: 69 in
four frontend files and 94 in seven server files, with no skips. All 141 original
file/full-name/tag identities remain and 22 cases were added. No tests moved;
production code, shared helpers, configuration, routing, and tags are unchanged.

All 29 selected mutations were detected after improvement. Each probe ran its
entire owning file; 27 survived that original file and two were already caught.
These results are not a repository-wide mutation score. Reports identify
neighboring coverage that already protects some boundaries and retain the
limitations of mocked browser lifecycles and injected filesystem failures.

`pnpm check` passed with zero errors and warnings, and `pnpm check:server`
passed protocol, shared-core, Fastify, browser-smoke, and architecture checks.
The architecture inventory still matches its existing 4,289 fixture references;
no refresh was needed. Documentation validation, Prettier, worklist integrity,
and diff checks also passed. The earlier
[full repository validation](test-reviews/pilot-full-validation.md) remains a
separate checkpoint; no full aggregate or browser suite was rerun for these
localized test-only changes.

Temporary execution evidence uses `/tmp/wave3-*`, including integrated client
and server JSON results, three case-conservation reports, typecheck logs, and
mutation evidence. The batch reports preserve findings, commands, selected
mutations, and limitations in version control.

This checkpoint has **29 `improved`, one `verified_unchanged`, and 413 `pending`**
original entries: 30 completed of 443. The remaining entries are 172 Critical
and 241 High; neighboring suites retain their own pending review obligations.

## Finding and assigning work

Run these commands from the repository root. Show current progress:

```sh
jq '.entries | group_by(.status) | map({status: .[0].status, entries: length})' docs/TEST-REVIEW-WORKLIST.json
```

List pending entries in original priority order:

```sh
jq -r '.entries[] | select(.status == "pending") | [.id, .original.severity, .original.frequency, .original.path] | @tsv' docs/TEST-REVIEW-WORKLIST.json
```

Inspect a complete record, including its current files and prior evidence:

```sh
jq '.entries[] | select(.id == "TL-0006")' docs/TEST-REVIEW-WORKLIST.json
```

Choose related behaviors using the [Test Suite Guide](tests/README.md), then set
`batchId`, `owner`, and `status: "in_progress"` on the claimed entries. The pending
entries are intentionally unassigned. A coordinator should apply claims and
shared worklist updates when workers run in parallel.

Check the explicit file lists before assigning adjacent entries. Record overlap
and split ownership when consolidation causes two original entries to share a
current file. Use isolated worktrees for temporary source mutations. Keep
neighboring coverage available for inspection without silently claiming it.

After a review, update the same IDs with final file mappings and evidence, add
relevant coverage notes to [TEST-LIST-UPDATE.md](TEST-LIST-UPDATE.md), and run
`pnpm check:docs` for documentation changes. Preserve the historical inventory.
The documentation validator does not validate this JSON's scope or progress;
also check that IDs and original paths remain unique, selection still matches
the snapshot, and every current file and evidence reference resolves. New
coverage introduced by splitting or strengthening an entry stays attached to
that entry; additions to the campaign's scope require an explicit recorded
decision rather than silently expanding the original 443-entry selection.
