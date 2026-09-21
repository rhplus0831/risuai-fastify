# Persistence pilot review

Reviewed on 2026-09-21 for priority worklist entries `TL-0012` and `TL-0016`.
The review changed tests only; all temporary production mutations were restored.

| Entry   | Current file                                                                | Baseline cases | Final cases | Outcome  |
| ------- | --------------------------------------------------------------------------- | -------------: | ----------: | -------- |
| TL-0012 | [db.test.ts](../../server/fastify/__tests__/db.test.ts)                     |             33 |          33 | Improved |
| TL-0016 | [messageStore.test.ts](../../server/fastify/__tests__/messageStore.test.ts) |             27 |          32 | Improved |

## Findings and changes

The migration suite already detects failed-migration commits: five existing
rollback cases fail on the persisted data when `ROLLBACK` is replaced with
`COMMIT`. Those cases, the schema fixtures, and revision checks remain in place.

Translator migration fixtures now contain explicit canonical bodies with stable
step identities, differently sized response limits, unknown extension data, and
noncompact JSON. They no longer call the production normalizer. Assertions check
selected-owner compatibility fields and unchanged preset bytes after migration,
failed migration, retry, and reopen. Distinct response limits expose choosing the
first preset's limit while selecting another preset.

Current-version idempotence now starts with persisted settings, a memory chunk,
and writer metadata before reopening and directly reapplying migrations. Future
version rejection checks both startup and the direct migration API, retaining
the original version/revision and a populated future-only table.

The memory-job rejection fixtures omitted the required `instance_id`; generic
`toThrow()` assertions therefore accepted a NOT NULL failure even when the
intended kind or JSON constraints were removed. Each invalid insert now changes
one field of an otherwise valid row, asserts the relevant CHECK failure, and
verifies that only the positive-control rows remain. Job-status rejection is
also checked within the original case.

Message JSON reads were insufficient to verify the separate indexed/stub
columns. Literal SQL-row expectations now protect message identity, role, text,
disabled value, JSON, sequence, and active status. The append test compares its
new row against a literal expectation instead of another production writer's
output. Existing prefix rows must remain byte-identical.

SQLite reused rowids after delete/reinsert, allowing all 27 original message
tests to pass when every generic diff rewrote its prefix. Connection-local audit
triggers now observe actual inserts, updates, and deletes. Append permits only
the added row; unchanged and rejected operations permit no message writes;
truncation permits only trailing deletions. Middle deletion/resequencing checks
the resulting transcript and contiguous sequence values and confines all writes
to the affected active tail. It allows an UPDATE-based implementation. Fixtures
also retain another chat and alternate rows to distinguish scope violations.

Active range reads now explicitly exclude reroll alternates. Five new cases
separate identity-, role-, and metadata-only stale prefixes from text changes,
and reject requested tails with zero growth or a shorter desired transcript.
The stale-prefix cases keep unrelated chat and alternate rows and compare the
complete persisted message table before and after rejection.

## Targeted mutation evidence

Each mutation ran separately in the isolated pilot worktree with one Vitest
worker. Failures below were inspected at the intended assertions; none are
import, setup, or timeout failures. "Before" means before the relevant assertion
change; the two memory-job probes ran after unrelated improvements but before
changing that original constraint case.

| Temporary mutation                                                                 | Before               | After                | Evidence                                                                                                        |
| ---------------------------------------------------------------------------------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Set generic diff `prefix = 0` immediately before the unchanged check               | 27 passed            | 4 failed / 28 passed | Append, unchanged, resequence, and truncation tests detect unwanted prefix writes/identity replacement.         |
| Replace `toRow`'s `disabled: disabledColumn(message)` with `disabled: null`        | 27 passed            | 2 failed / 30 passed | CRUD and fast-append raw-row expectations detect lost disabled values.                                          |
| Replace append's deep prefix equality check with transcript-length equality        | 1 failed / 26 passed | 4 failed / 28 passed | Original stale-text assertion already detects this regression; new identity/role/metadata cases also reject it. |
| Compare only message `data` arrays in append's deep prefix equality check          | 27 passed            | 3 failed / 29 passed | Identity-, role-, and metadata-only stale appends incorrectly return true.                                      |
| Remove `alternate = 0` from `getChatMessagesRange`'s SQL filter                    | 27 passed            | 1 failed / 31 passed | The active range contains a reroll candidate.                                                                   |
| Replace migration error-path `db.exec('ROLLBACK')` with `db.exec('COMMIT')`        | 5 failed / 28 passed | 5 failed / 28 passed | Stop-string, model, persona, Hypa, and translator cases detect changed persisted data after failure.            |
| Set translator compatibility `maxResponse` from `presets[0]` instead of `selected` | 33 passed            | 1 failed / 32 passed | Selecting translator-b produces 500 instead of its independent 750 limit.                                       |
| Remove memory-job `CHECK (kind IN ('chunk', 'embed', 'summarize'))`                | 33 passed            | 1 failed / 32 passed | The isolated invalid-kind insert no longer throws.                                                              |
| Remove memory-job `CHECK (json_valid(payload_json))`                               | 33 passed            | 1 failed / 32 passed | The isolated malformed-payload insert no longer throws.                                                         |

Seven pre-fix survivors represented assertion gaps; all nine probes are detected
after strengthening, including two controls already caught before changes. This
is a targeted experiment set, not an exhaustive mutation score. The append
function explicitly requires a caller-proven append-only desired array; changing
that caller contract was not part of this review.

## Coverage ownership and conservation

All 60 original `(repository-relative file, collected full test name)` pairs
remain in their original files. No cases were moved, renamed, deleted, skipped,
or retagged. Both files retain `@module-tag core`, the Fastify Node/forks config,
and their existing inventory ownership. No shared test configuration changed.

The five added full names all belong to `messageStore.test.ts`:

- `applyChatMessageDiff surgical writes > rejects a stale append when only prefix identity changes`
- `applyChatMessageDiff surgical writes > rejects a stale append when only prefix role changes`
- `applyChatMessageDiff surgical writes > rejects a stale append when only prefix metadata changes`
- `applyChatMessageDiff surgical writes > rejects a non-growing append of 0 rows without writing`
- `applyChatMessageDiff surgical writes > rejects a non-growing append of 1 rows without writing`

Neighboring suites were inspected to keep ownership clear:

- [migrationFoundation.test.ts](../../server/fastify/__tests__/migrationFoundation.test.ts)
  owns catalog/runner foundations and damaged-database refusal;
  [legacyDatabaseImport.test.ts](../../server/fastify/__tests__/legacyDatabaseImport.test.ts)
  owns legacy import rollback/retry and identity normalization.
- [commands.messages.test.ts](../../server/fastify/__tests__/commands.messages.test.ts)
  owns HTTP command identity, metadata, mutation/revision behavior and non-message
  write isolation. Its command boundary is distinct from these direct SQL helpers.
- [generationIgpCommit.test.ts](../../server/fastify/__tests__/generationIgpCommit.test.ts)
  and [serverMessageTranslation.test.ts](../../server/fastify/__tests__/serverMessageTranslation.test.ts)
  own atomic message/effect/translation failure and retry behavior.
- [repositoryWriterKit.test.ts](../../server/fastify/__tests__/repositoryWriterKit.test.ts)
  and [serverLoadCostHarness.test.ts](../../server/fastify/__tests__/serverLoadCostHarness.test.ts)
  own broader targeted writes and query-cost contracts.

Those suites were inspected, not claimed as completed worklist reviews. No
consolidation or file split was justified: the suites have coherent storage and
migration ownership, and focused execution is already inexpensive. Message-store
helpers rely on surrounding command/repository transactions; this pilot does
not invent helper-level transaction guarantees.

## Validation

Baseline and final restored-source validation used the same exact command:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts server/fastify/__tests__/db.test.ts server/fastify/__tests__/messageStore.test.ts --maxWorkers=1
```

Baseline: **2 files, 60 cases passed**. Final: **2 files, 65 cases passed**.
Each mutation used the command below for its owning file:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts server/fastify/__tests__/db.test.ts --maxWorkers=1
pnpm exec vitest run --config server/fastify/vitest.config.ts server/fastify/__tests__/messageStore.test.ts --maxWorkers=1
```

Runner discovery before and after compared file/full-name multisets, producing
60 retained cases, 0 removed cases, and the 5 additions listed above:

```sh
pnpm exec vitest list --config server/fastify/vitest.config.ts server/fastify/__tests__/db.test.ts server/fastify/__tests__/messageStore.test.ts --maxWorkers=1 --json=/tmp/risu-pilot-persistence-baseline-cases.json
pnpm exec vitest list --config server/fastify/vitest.config.ts server/fastify/__tests__/db.test.ts server/fastify/__tests__/messageStore.test.ts --maxWorkers=1 --json=/tmp/risu-pilot-persistence-final-cases.json
```

Formatting and documentation checks:

```sh
pnpm exec prettier --write server/fastify/__tests__/db.test.ts server/fastify/__tests__/messageStore.test.ts docs/test-reviews/pilot-persistence.md
pnpm exec prettier --check server/fastify/__tests__/db.test.ts server/fastify/__tests__/messageStore.test.ts docs/test-reviews/pilot-persistence.md
pnpm check:docs
git diff --check
```

These are localized test/documentation changes. No production source, shared
configuration, UI, or API behavior changed, so focused validation is sufficient;
`test:agent`, `test:all`, and browser suites were not run for this batch.

## Limitations and pilot lessons

The experiments do not cover every schema version, every migration interruption
point, or every message-store branch. Embedded/malformed translator preset
migration inputs remain outside this fixture matrix. Broader command transaction,
import, recovery, and performance boundaries retain their neighboring owners.
There are no outstanding failures or known product defects from this pilot.

The baseline and restored focused runs took about five seconds each. Review and
mutation interpretation dominated the work; keeping these two related files in
one batch made comparison of serialization, identity, and persistence assumptions
useful without a mechanical split. Future batches should budget time for finding
masked negative assertions and for checking actual SQLite writes rather than
using rowids as proof that no write occurred.
