# Server reads review, second wave

Reviewed on 2026-09-21 from `a690473965903f0f36c68ff3ff457f87d25d5b7f` in an
isolated worktree. All temporary production mutations were restored; the final
change contains tests and this report only.

| Entry   | Suite                                                                                                       | Before | After | Outcome  |
| ------- | ----------------------------------------------------------------------------------------------------------- | -----: | ----: | -------- |
| TL-0013 | [generationInputLoaders.test.ts](../../server/fastify/__tests__/generationInputLoaders.test.ts)             |     32 |    32 | Improved |
| TL-0015 | [resourceReads.test.ts](../../server/fastify/__tests__/resourceReads.test.ts)                               |     28 |    42 | Improved |
| TL-0017 | [commandMutationReadNarrowing.test.ts](../../server/fastify/__tests__/commandMutationReadNarrowing.test.ts) |     26 |    26 | Improved |

## Findings and changes

The generation loaders already distinguish modern and legacy ownership, reject
mismatched stored identities, bound selected queries independently of unrelated
corpus growth, and preserve duplicate selection behavior. Their authoritative
message/Hypa case previously compared two loaders without conflicting legacy
bodies. It now persists different, nonempty embedded transcript and memory
values beside canonical rows. Literal expected message and memory values prove
canonical ownership; the raw chat row must remain unchanged. The existing
fallback case still verifies embedded bodies when canonical rows are absent.

The preflight module assertion used `every()` to check omitted heavy fields and
passed for an empty module array. It now also asserts the ordered selected IDs,
including matching duplicates, across persona, global, prompt, character, chat,
and Agent activation sources. The original query budgets and body exclusions
remain intact.

Resource reads already cover exact masked projections, content hashes, bulk
limits, malformed persisted owners, full/tail/generation transcript windows,
and per-chat alternate isolation. Fourteen new cases exercise malformed numeric
range syntax, unsafe integers, negative or zero values, and missing start/limit
partners. Each first proves a valid range on the same authenticated chat, then
asserts the bad query's 400 response and unchanged database rows. The existing
message-read case also checks a valid `start=0&limit=1` result.

Command read-narrowing tests intentionally assert SQL tables and loader budgets
as a performance contract. Those assertions were retained. Definition PUT and
compact PATCH tests now verify the measured operation persisted the intended
character/module field, preserved the rest of the target record, and left all
sibling rows byte-identical. These checks run outside the instrumentation
window. The message lifecycle case now checks the patched text in both indexed
columns and JSON before the subsequent DELETE can erase evidence of a lost
patch.

These additions verify effects within the existing scoped-read cases. Detailed
script/trigger CRUD already belongs to
[commands.scripts.test.ts](../../server/fastify/__tests__/commands.scripts.test.ts),
and message storage and route semantics retain their neighboring owners. A
survivor here means a gap in the selected suite, not proof that the whole
repository lacked protection. No production defect or storage redesign was
needed, and no file split or shared helper/configuration change was justified.

## Targeted mutation evidence

Each mutation ran alone against its entire owning test file, using one worker
and no file parallelism. Baseline mutation runs used the unchanged original
suite: 32 loader cases, 28 resource cases, or 26 narrowing cases. They did not
run all 86 batch cases for each probe. Final probes used 32, 42, or 26 cases,
respectively. Failures were inspected at the intended assertions, with no
setup, import, or timeout failures.

| Temporary mutation                                                                                                                              | Original result      | Final result         | Protected assertion                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------- | ----------------------------------------------------------------------- |
| In `hydrateGenerationTargetChat`, load canonical messages only when embedded `chat.message` is not a nonempty array.                            | 32 passed            | 1 failed / 31 passed | Canonical transcript wins over stale embedded content.                  |
| In the same function, assign canonical Hypa only when `chat.hypaV3Data === undefined`.                                                          | 32 passed            | 1 failed / 31 passed | Canonical memory wins over stale embedded content.                      |
| In `readGenerationModules`, map `records.slice(0, 0)` instead of `records` in the metadata-only branch.                                         | 32 passed            | 1 failed / 31 passed | Preflight retains selected module IDs and order.                        |
| Replace `currentChar.chaId !== target.characterId` with `false` in the selected generation loader.                                              | 1 failed / 31 passed | 1 failed / 31 passed | Existing mismatched-owner case already rejects the regression.          |
| Remove the digit-only regular-expression guards from both resource range integer parsers, retaining numeric conversion and safe-integer checks. | 28 passed            | 6 failed / 36 passed | Exponent, hex, decimal-form, and whitespace numeric syntax is rejected. |
| Replace `Number.isSafeInteger(parsed)` with `Number.isInteger(parsed)` in both resource range integer parsers.                                  | 28 passed            | 3 failed / 39 passed | Unsafe tail, start, and limit values are rejected.                      |
| Change the bulk raw-ID limit comparison from `>` to `>=`.                                                                                       | 1 failed / 27 passed | 1 failed / 41 passed | Existing exact-limit positive control already rejects the off-by-one.   |
| Replace character full-script assignment `character.customscript = scripts` with self-assignment.                                               | 26 passed            | 1 failed / 25 passed | Scoped full definition replacement must persist.                        |
| Replace compact module script assignment from `applyScriptDefinitionCollectionMutation(module.regex, mutation)` with self-assignment.           | 26 passed            | 1 failed / 25 passed | Scoped compact definition creation must persist.                        |
| Pass `{}` instead of `patch` to the message route's `updateActiveMessageById` call.                                                             | 26 passed            | 1 failed / 25 passed | Scoped message PATCH persists text before DELETE.                       |

Eight baseline survivors are now caught. Two controls were already caught and
remain caught. This is a targeted experiment set, not an exhaustive mutation
score. The three final resource mutations were repeated after adding the
per-case successful controls, with the same failures and counts.

## Validation and conservation

Dependencies were installed with `pnpm install --offline --frozen-lockfile` in
the isolated worktree; no root dependency-directory symlink was used.

The baseline and restored final batch commands differ only in output filename:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/generationInputLoaders.test.ts server/fastify/__tests__/resourceReads.test.ts server/fastify/__tests__/commandMutationReadNarrowing.test.ts --reporter=json --outputFile=/tmp/wave2-reads-baseline.json
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/generationInputLoaders.test.ts server/fastify/__tests__/resourceReads.test.ts server/fastify/__tests__/commandMutationReadNarrowing.test.ts --reporter=json --outputFile=/tmp/wave2-reads-final.json
```

Baseline: **3 files, 86 passed**. Restored final: **3 files, 100 passed**.
The file/full-test-name multiset comparison retained all 86 original identities
and added 14 resource-range cases. No cases were renamed, moved, deleted,
skipped, or retagged. Runtime routing and test configuration are unchanged.

Every mutation used this command, substituting its owning file and artifact
prefix:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts --no-file-parallelism --maxWorkers=1 server/fastify/__tests__/<owning-suite>.test.ts --reporter=json --outputFile=/tmp/wave2-reads-<phase>-<mutation>.json
```

Baseline/final JSON reports and logs use `/tmp/wave2-reads-baseline.*` and
`/tmp/wave2-reads-final.*`. Per-mutant JSON/log artifacts and summary JSONL files
use the same prefix. `/tmp/wave2-reads-mutations.py` records the exact temporary
replacements and restores each source in a `finally` block. These `/tmp`
artifacts are session evidence; the table above is the durable result.

Additional validation:

```sh
pnpm exec prettier --write server/fastify/__tests__/generationInputLoaders.test.ts server/fastify/__tests__/resourceReads.test.ts server/fastify/__tests__/commandMutationReadNarrowing.test.ts
pnpm exec prettier --ignore-path /dev/null --write docs/test-reviews/wave-2-server-reads.md
pnpm exec prettier --ignore-path /dev/null --check server/fastify/__tests__/generationInputLoaders.test.ts server/fastify/__tests__/resourceReads.test.ts server/fastify/__tests__/commandMutationReadNarrowing.test.ts docs/test-reviews/wave-2-server-reads.md
pnpm check:docs
git diff --check
```

The coordinator owns the integrated typecheck and architecture-inventory check.
This batch adds no client aggregate fixture references. No aggregate or browser
suite was run in this worktree: production behavior and shared contracts were
unchanged, and the focused tests cover the local changes.

## Limits

This review does not exhaust every query-parser branch or every malformed JSON
shape. Resource HTTP ownership combinations and cross-chat generation-message
selectors retain additional possible focused probes; they were not mutation
scored here. Definition outcomes cover existing full-replace and create cases,
not a second copy of the neighboring CRUD matrix. The existing query-budget,
legacy-fallback, malformed-owner, and sibling-preservation cases were reviewed
and retained; this batch makes no repository-wide coverage claim.
