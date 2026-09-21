# Bootstrap and reader authentication review

Reviewed 2026-09-21. Batch **wave-2-bootstrap-auth**, from baseline
`a690473965903f0f36c68ff3ff457f87d25d5b7f`.

| Entry   | Test file                                                                                    | Outcome  | Passing cases before → after |
| ------- | -------------------------------------------------------------------------------------------- | -------- | ---------------------------: |
| TL-0011 | [bootstrap.svelte-node.test.ts](../../src/ts/server/bootstrap.svelte-node.test.ts)           | Improved |                      47 → 50 |
| TL-0014 | [readerReadAuth.svelte-node.test.ts](../../src/ts/server/readerReadAuth.svelte-node.test.ts) | Improved |                      30 → 40 |
| TL-0018 | [connectedClientStartup.test.ts](../../src/ts/connectedClientStartup.test.ts)                | Improved |                      22 → 28 |

All **99 original cases** retain their full names, files, tags, and runtime
routing. The final batch passes **118/118** cases, with no skips. No tests were
split, removed, or moved. Production code, shared helpers, configuration, and
architecture inventories are unchanged.

## Review and changes

The review followed the transport and session transitions in
[bootstrap.ts](../../src/ts/server/bootstrap.ts),
[connectedClientStartup.ts](../../src/ts/connectedClientStartup.ts),
[clientSession.ts](../../src/ts/clientSession.ts),
[resourceReads.ts](../../src/ts/server/resourceReads.ts), and
[hydrationReads.ts](../../src/ts/server/hydrationReads.ts).

**TL-0011:** Existing cases cover ownership single-flight, cancellation/deadline
settlement while fetch or JSON remains held, late-body isolation, conditional
writer acquisition, reader transport, malformed ownership, telemetry negotiation,
and runtime recovery metadata. The request fixture used production header
constants to find sent headers, allowing a misspelled conditional epoch header
to satisfy the same expectation. It now normalizes request headers with `Headers`
and checks independent literal wire names. Numeric revision cases separately
reject `-1` and `1.5` while retaining the accepted revision and telemetry state.
Their other metadata is valid. A positive revision is accepted before each
rejection, and a separate new case accepts and caches revision zero with valid
no-owner metadata. Rejecting every revision cannot satisfy these controls.

**TL-0014:** Existing cases cover authentication loss before a held error body
finishes, generation and abort fences, authentication/cache-negotiation delays,
character transport isolation, and old bootstrap configuration/cache suppression.
The suite previously exercised only HTTP 401 for current resource failures.
New HTTP 403 and 503 cases run across shell, chat, bulk-chat, lorebook, and
bulk-lorebook readers. They require the request to occur and return its error,
while preserving the complete authenticated session snapshot and avoiding the
projection-discard boundary. Existing current-401 cases provide the opposite
control: real session revocation and an `auth-loss` discard request must occur.
The discard implementation remains mocked, so these assertions establish its
admission policy, not actual projection/cache clearing.

**TL-0018:** Existing cases cover exclusive/nonexclusive identity, foreign and
absent owners, conditional acquisition, initialization confirmation, race losers,
held discovery/preference/acquisition supersession, and startup recovery without
ordinary write authority. New cases require HTTP 401 to clear authenticated
ownership during both acquisition and the subsequent conflict reread. Companion
HTTP 503 cases retain authenticated ownership while failing startup, keeping
error classification independent of generic error handling. Another case
requires `active_writer_stale` to reread and settle as the observed new writer's
Reader, with no recovery/write authority. A held conflict reread returning 401
after a newer authenticated Reader starts must preserve that Reader's entire
snapshot and report supersession. This tests the session outcome before the
specific rejection message.

Adjacent resource/hydration tests and the writer-lifecycle/switching suites were
inspected for ownership. Their direct resource parsing, foreground recovery,
promotion, and browser-level responsibilities do not replace these startup
helper branches. No duplication warranted deletion or a mechanical split.

## Targeted mutation evidence

Each experiment independently changed one production behavior, ran all three
selected suites with one worker, and restored the source in `finally` before the
next experiment. **Seven mutants survived all 99 original cases; all ten were
detected after the improvements.** The other three were already detected by the
original suite. Failures were assertion failures at the described behavior,
not compilation or module-loading errors. The hydration revocation probe fails
its existing bounded wait for `auth-required` and its discard assertions.

| ID  | Temporary behavior change                                                     | Original result | Detecting final behavior                                                              |
| --- | ----------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| M1  | Misspell `EXPECTED_WRITER_EPOCH_HEADER` as `risu-expected-writer-epoch-typo`. | Survived        | Conditional acquisition and epoch-zero wire checks find the required header missing.  |
| M2  | Accept any numeric bootstrap revision instead of an integer ≥ 0.              | Survived        | Both invalid numeric fixtures return success instead of `Invalid bootstrap revision`. |
| M3  | Remove the generation guard from bootstrap configuration application.         | Already caught  | Old reader/writer responses unexpectedly invoke diagnostic configuration.             |
| M4  | Skip authentication revocation for an acquisition HTTP 401.                   | Survived        | Startup retains authenticated resolving state instead of clearing ownership.          |
| M5  | Skip authentication revocation for a conflict-reread HTTP 401.                | Survived        | The reread retains authenticated resolving state instead of clearing ownership.       |
| M6  | Remove `active_writer_stale` from recoverable acquisition conflicts.          | Survived        | Startup rejects instead of returning the newly observed Reader.                       |
| M7  | Skip the current-operation fence immediately after conflict reread.           | Survived        | A late 401 clears the newer Reader's authenticated snapshot.                          |
| M8  | Revoke resource-read authentication on any non-OK response.                   | Survived        | Shell HTTP 403/503 incorrectly calls the projection-discard boundary.                 |
| M9  | Ignore generation when handling resource-read HTTP 401.                       | Already caught  | Old character/cache-negotiated requests discard the newer session.                    |
| M10 | Return before hydration authentication revocation.                            | Already caught  | Current hydration 401s leave the session reading and omit discard.                    |

M1 was repeated after normalizing the request fixture with `Headers`; M7 was
repeated after putting session-state preservation before error-message checking.
Both still fail their intended assertions. All production files were restored
byte-for-byte and verified with:

```sh
git diff --exit-code -- src/ts/server/bootstrap.ts src/ts/server/resourceReads.ts src/ts/server/hydrationReads.ts src/ts/connectedClientStartup.ts
```

These ten selected faults are evidence for the reviewed boundaries, not an
exhaustive mutation score or complete coverage of optional projection fields and
every resource adapter.

## Validation and retained evidence

Baseline and final restored-source commands:

```sh
pnpm exec vitest run src/ts/server/bootstrap.svelte-node.test.ts src/ts/server/readerReadAuth.svelte-node.test.ts src/ts/connectedClientStartup.test.ts --no-file-parallelism --maxWorkers=1 --reporter=json --outputFile=/tmp/wave2-bootstrap-auth-baseline.json
pnpm exec vitest run src/ts/server/bootstrap.svelte-node.test.ts src/ts/server/readerReadAuth.svelte-node.test.ts src/ts/connectedClientStartup.test.ts --no-file-parallelism --maxWorkers=1 --reporter=json --outputFile=/tmp/wave2-bootstrap-auth-final.json
```

Both passed: **99/99** baseline and **118/118** final. Full-name/tag comparison
records **99 retained, zero missing, 19 added** in
`/tmp/wave2-bootstrap-auth-conservation.json`. The existing Node and Svelte/Node
routing remains unchanged; no new core tags were introduced.

Exact mutation replacements and per-run JSON/log paths are retained locally in
`/tmp/wave2-bootstrap-auth-mutants.py`,
`/tmp/wave2-bootstrap-auth-original-mutations.json`, and
`/tmp/wave2-bootstrap-auth-improved-mutations.json`. Final confirmation records
are `/tmp/wave2-bootstrap-auth-normalized-header-mutations.json` and
`/tmp/wave2-bootstrap-auth-state-first-mutations.json`. These temporary files are
host-local execution evidence; this report preserves the scope, mutations,
outcomes, and commands durably.

Prettier, `git diff --check`, and `pnpm check:docs` passed. The integration
coordinator owns combined client/server typechecks and inventory validation.
No aggregate fixture accessor references were added or removed. No full
repository aggregate was rerun for this localized test-only batch.

HTTP/bootstrap responses, tab identity, preferences, and projection discard are
mocked at their existing boundaries. This review does not establish mounted UI
behavior, real authentication/network handling, or SQLite persistence. No
production defect was found and no selected mutation remains undetected.
