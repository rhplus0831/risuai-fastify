# Character command pilot review

Reviewed 2026-09-21. Worklist entry **TL-0009**; batch **pilot-characters**.
Baseline commit: `949e401cfbd7dcb37f45c57db485eb938d2ee001`.
Outcome: **improved**, with all 88 original cases retained and two selection-race
cases added. The resulting suite passes **90/90** cases.

## Scope and findings

The review covered [characterCommands.test.ts](../../src/ts/characterCommands.test.ts),
its [command implementation](../../src/ts/characterCommands.ts),
[selection/removal callers](../../src/ts/characters.ts), and
[store runtime effects](../../src/ts/stores/runtimeEffects.svelte.ts).
No production behavior, shared harness, configuration, test tags, or runtime
routing changed. No scenario was removed or moved to another file.

Four weaknesses were corrected:

1. The empty imported starter-chat expectation shared its `localLore` object
   with the input. An in-place production mutation could destroy both the input
   and expected value while the test passed. The test now clones input from an
   independent expected fixture and checks payload, acceptance, and retained
   local data.
2. The successful deletion test for `char-trash` used a mock accepting only
   `char-b`; its optimistic assertions passed before the unexpected 404 settled.
   The mock now accepts an explicitly configured identity. Both pointer
   normalization tests verify the exact DELETE URL, method, authentication,
   revision body, accepted outcome, and final surviving row identity.
3. Negative selection tests changed the selected indices, allowing index guards
   to mask missing stable-ID or interaction-time guards. Two new cases keep
   both indices fixed while separately replacing the selected row or updating
   the same row's interaction timestamp. Each awaits rejection, checks retained
   state, and releases its deferred response in `finally`.
4. All six Hypa auto-enable no-op fixtures used obsolete object-map presets and
   `hypaV3PresetId`, so they stopped at preset lookup instead of exercising the
   named gates. They now use the current preset array and stable
   `selectedHypaV3PresetId` contract. Removing the Hypa-enabled gate now fails
   the intended no-network assertion.

The create acceptance checks and no-op rollback assertions for import creation,
replacement deletion, and delayed selection now await mutation outcomes rather
than only request capture or four event-loop turns. Other existing tests retain
state-change or durable-outbox completion evidence where that already proves
their protected behavior. This is a targeted correction, not a claim that every
asynchronous call in the suite now exposes a settlement handle.

## Invariant review and conservation

| Original describe group               | Before → after | Review outcome                                                                                                                                                                                   |
| ------------------------------------- | -------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| character create command payloads     |          3 → 3 | Improved independent starter-chat oracle and accepted settlement; embedded chat exclusion retained.                                                                                              |
| character list create/delete rollback |        14 → 14 | Improved successful DELETE fixture/identity and no-op rollback settlement; sibling edits, appended rows, folder metadata, selection compaction, and retained predecessor order remain protected. |
| character select command rollback     |          6 → 8 | Improved settled rejection checks; added independent same-index identity and timestamp guards. Durable staging failure, writer loss, and cross-target ordering remain protected.                 |
| character order command helpers       |        24 → 24 | Verified unchanged: explicit normalized orders, invalid drags, stable folder targeting, newer metadata, terminal rollback, and durable replay.                                                   |
| character command projection helpers  |          1 → 1 | Verified unchanged: exact authenticated one-field Supa-memory PATCH and accepted outcome.                                                                                                        |
| select supa memory flag patch         |          6 → 6 | Improved all six no-op fixture rows; retained scalar snapshots, clone bounds, concurrent edits, transient retention, and replay.                                                                 |
| character-row snapshot kit            |        12 → 12 | Verified unchanged: ready/unique owner gating, stable IDs after index shifts, scalar/row clone bounds, sibling preservation, and field deletion.                                                 |
| character-row scoped dispatch         |          2 → 2 | Verified unchanged: target-row rollback and no full-array clone.                                                                                                                                 |
| kept-key character diff               |        12 → 12 | Verified unchanged: explicit sanitized patches, supported deletion sentinel, excluded collections, transcript clone bounds, retained outcomes, and terminal nested-array rebase.                 |
| removeChar trashTime field rollback   |          8 → 8 | Verified unchanged: confirmation races, original target identity, scalar rollback, exact timestamps, retained replay, and sibling data preservation.                                             |

**Original-to-current mapping:** every original full test name remains in
`src/ts/characterCommands.test.ts` with the same tags. A multiset comparison of
Vitest JSON reports found **88 retained, zero missing, two added**, with unchanged
empty tag arrays. The file remains in the existing `frontend-dom` / `happy-dom`
routing and remains outside the core-tagged file inventory.

The two additions under `character select command rollback` are:

- `preserves a newer interaction at unchanged selection indices when an older selection fails`
- `preserves a replacement owner at unchanged selection indices when an older selection fails`

Full original and final names, tags, and comparison results were captured in
`/tmp/pilot-characters-conservation.json` during this review. The SHA-256 of the
sorted, newline-joined original full names is
`8a4ccf72ef36dfdf1920be410fbf95a5eee2234d4aed5ee50924108dade5f722`.
The temporary JSON/log files are execution evidence on the review host; the
scope mapping, findings, mutation outcomes, and reproducible commands below are
the durable record.

## Targeted mutation evidence

Each experiment changed one production behavior, ran the named test selection,
and restored the source before the next experiment. All seven final experiments
failed at the intended behavioral assertion; none is credited for a build,
setup, or module-load failure. Mutations M1 and M2 each survived the complete
original 88-case suite. M3 survived the original no-op case before its fixture
correction. Those three survivors were actual test gaps, subsequently closed.
M4–M7 were checked against the final suite; no pre-improvement survival claim is
made for them.

| ID  | Temporary mutation                                                                                   | Final detecting assertion                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Remove the attempted `lastInteraction` comparison from `restoreCharacterSelectionAttempt`.           | Newer-interaction case receives selected index 0 instead of retained index 1. The independent replacement-owner case still passes. |
| M2  | Clear `chat.localLore` in place before returning `initialCharacterChatSnapshot`.                     | Imported starter-chat payload loses the independent expected local-lore entry.                                                     |
| M3  | Remove `memorySettings?.hypaV3` from the store auto-enable gate.                                     | `Hypa V3 disabled` fixture observes an unexpected bootstrap request instead of zero network calls.                                 |
| M4  | Remove the live selected-character ID comparison from `restoreCharacterSelectionAttempt`.            | Replacement-owner case receives selected index 0 instead of retained index 1. The independent newer-interaction case still passes. |
| M5  | Replace permanent DELETE's `character-owner` dependency with an empty list.                          | Existing durable ordering case sees DELETE first instead of the predecessor PATCH.                                                 |
| M6  | Restore old selection scalars instead of the newer live selected ID after permanent-delete rollback. | Existing index-compaction rollback case receives index 1 instead of index 2.                                                       |
| M7  | Return `failed` for every non-accepted compatible mutation, ignoring retained disposition.           | Existing writer-loss selection and retained character-patch cases receive `failed` instead of `queued`.                            |

Exact mutation replacements, commands, failure names, and assertions were
captured in `/tmp/pilot-characters-mutations.py` and
`/tmp/pilot-characters-mutations.json`; individual JSON/log pairs use
`/tmp/pilot-characters-m1-after.*` through `m7-after.*`. Sources were restored
byte-for-byte and checked with:

```sh
git diff --exit-code -- src/ts/characterCommands.ts src/ts/stores/runtimeEffects.svelte.ts
```

## Adjacent coverage and refactoring decision

Neighboring tests were inspected by responsibility:

- [characters.changeChar.test.ts](../../src/ts/characters.changeChar.test.ts)
  owns navigation after hydration/import, accepted versus rejected imports, and
  writer-session freshness.
- [characterDraft.svelte.test.ts](../../src/ts/server/characterDraft.svelte.test.ts)
  owns mounted drafts, debounce, coalescing, dirty refresh, and mocked dispatch.
- [durableMutationTerminalRejection.test.ts](../../src/ts/server/durableMutationTerminalRejection.test.ts)
  owns generic outbox storage, transport, retention, and terminal cleanup.
- [selectedCharacterRefresh.test.ts](../../src/ts/server/selectedCharacterRefresh.test.ts)
  owns stable resource refresh identity without mutation dispatch or rollback.
- [commands.characters.test.ts](../../src/ts/server/commands.characters.test.ts)
  owns command wire adapters and accepted local effects.

These layers do not replace character-domain rollback and dependency assertions.
No exact duplication justified deletion. The ten existing describe groups remain
useful ownership boundaries, and the observed gaps did not require a mechanical
split. Keeping the file also avoids expanding this pilot into shared routing and
core-inventory changes.

## Validation and limits

Baseline and final execution used the root Vitest configuration and one worker:

```sh
pnpm exec vitest run src/ts/characterCommands.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/pilot-characters-baseline.json
pnpm exec vitest run src/ts/characterCommands.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/pilot-characters-final.json
```

Baseline: **88/88 passed**. Final after all mutations were restored: **90/90
passed**. Intermediate corrected-suite runs also passed. Mutation commands use
the same runner/file/worker flags plus `-t` for the identifying title(s) in the
evidence table and separate JSON output paths.

The measured interval from baseline start to final completion was about **5 min
31 sec**, including assertion edits and mutation runs; initial discovery and
report preparation are outside that interval. The baseline test body took about
1.45 seconds and the final test body about 1.33 seconds. These single-run timings
are workload observations, not performance claims.

`pnpm exec prettier --check src/ts/characterCommands.test.ts` and
`pnpm check:docs` passed (50 documentation files). The report was also formatted
explicitly because repository defaults ignore Markdown. No broader application suite is required for these localized test-only changes;
`test:all` was not run. The integration coordinator owns any combined typecheck
and topology validation across pilots.

HTTP and server responses remain mocked here. This review does not establish
SQLite persistence or rendered UI recovery, and the seven selected experiments
are not an exhaustive mutation score. No current production defect was found;
no demonstrated test gap remains unresolved within this pilot's reviewed scope.
