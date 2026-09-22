# Generation transport second-wave review

Reviewed 2026-09-21 from baseline `a69047396` in an isolated worktree.
This report records TL-0010 and TL-0025 in the
[priority worklist](../../.archived-docs/performance-and-stability/test-suite-reduction-2026-09/TEST-REVIEW-WORKLIST.md).

## Outcomes

| Entry   | Outcome  | Test owner                                                                              | Baseline → final cases |
| ------- | -------- | --------------------------------------------------------------------------------------- | ---------------------: |
| TL-0010 | Improved | [serverChat.test.ts](../../src/ts/process/request/tests/serverChat.test.ts)             |                86 → 90 |
| TL-0025 | Improved | [serverCompletion.test.ts](../../src/ts/process/request/tests/serverCompletion.test.ts) |                11 → 13 |

The baseline passed 97 cases. The final batch passes 103 cases. Changes are
limited to these two tests and this report; production behavior, test routing,
tags, fixtures shared with other suites, and architecture inventory references
remain unchanged.

The chat review covered request/auth intent, prompt and generation SSE parsing,
recovery after a lost response, replay gaps and canonical terminals,
half-streaming, cancellation, reader/writer/occupancy fences, stale attempts,
progress isolation, provider errors, persistence disposition, and viewer
retirement. Existing assertions already catch duplicated token accumulation
on reconnect. Strengthened tests now also check:

- A replayed side effect appears once while a distinct later effect survives.
  The existing reconnect test retains all its cumulative token assertions.
- A stale-attempt redirect cannot move to another operation. Four successive
  stale responses exhaust the initial GET plus three permitted redirects and
  retain an authority-reconciliation result without cancellation or adoption.
- A terminal reference for another job fails before a snapshot fetch or
  successful terminal application, preserving the original job for recovery.
  The existing valid-reference test remains its positive counterpart.
- Caller abort issues Stop for the exact operation while its viewer still
  receives the canonical cancelled terminal and retained partial text. The
  pre-existing viewer callback is also exercised.
- An error frame's retained text replaces the optimistic partial, preserves
  post-generation metadata, closes the token stream, and remains a terminal
  failure rather than becoming successful generation.

The completion review covered intent-only wire payloads, model intent, tool
history/call allowlists, HTTP/provider errors, SSE parsing, and cancellation.
The successful request now checks POST and the exact caller signal. The SSE
fixture retains two token frames and coalesced-frame parsing, also divides all
bytes (including multibyte Korean and emoji characters), ignores malformed/non-token
frames, and excludes content
after `done`. The tool rejection case first proves the identical buffered tool
request succeeds, then asserts the streaming request fails before fetch.

The abort case starts with a queued token and disables stream prefetch with
`highWaterMark: 0`. Its next `pull` marks the pending read after that token was
consumed. Caller abort must cancel the underlying reader and return `Aborted`,
not successful partial output. Cleanup closes a broken implementation's reader
so a missing abort listener does not leak an unresolved test task. This checks
stream-read cancellation; it does not claim to test abort during pending fetch
or a no-dispatch guarantee for an already-aborted caller.

## Mutation evidence

Each mutant ran independently against the entire two-file batch. Sources were
restored in `finally` before the next mutant. For the two additional chat probes,
the exact original test files were temporarily restored from the baseline, then
the improved files restored in `finally`. No result below is based solely on a
selected test name.

| Probe                                         | Original batch  | Improved batch   | Protected assertion                                          |
| --------------------------------------------- | --------------- | ---------------- | ------------------------------------------------------------ |
| G1: omit same-operation redirect guard        | 97 pass         | 102 pass, 1 fail | Foreign operation redirect causes an unexpected second GET.  |
| G2: remove the three-redirect bound           | 97 pass         | 102 pass, 1 fail | A fifth GET exceeds bounded immediate recovery.              |
| G3: omit terminal reference href validation   | 97 pass         | 102 pass, 1 fail | Wrong-job terminal reference must fail before another fetch. |
| G4: accept duplicate replayed side effects    | 97 pass         | 102 pass, 1 fail | Terminal side-effect list contains a duplicate.              |
| G5: retain token accumulator on reconnect     | 96 pass, 1 fail | 102 pass, 1 fail | Existing replay assertion detects duplicated partial text.   |
| G6: skip operation Stop on caller abort       | 97 pass         | 102 pass, 1 fail | Exact-operation Stop call is absent.                         |
| G7: discard retained text from error frames   | 97 pass         | 102 pass, 1 fail | Canonical retained partial is missing from the token stream. |
| C1: decode each byte chunk independently      | 97 pass         | 102 pass, 1 fail | Fragmented UTF-8 result is corrupted.                        |
| C2: cancel the reader without marking aborted | 97 pass         | 102 pass, 1 fail | Cancelled completion returns successful partial text.        |
| C3: omit stream abort listener registration   | 97 pass         | 102 pass, 1 fail | Underlying reader is not cancelled.                          |
| C4: allow streaming tool requests             | 97 pass         | 102 pass, 1 fail | Invalid streaming request reaches transport.                 |
| C5: omit caller signal from fetch             | 97 pass         | 102 pass, 1 fail | Captured fetch signal differs from the caller's signal.      |
| C6: ignore the done event boundary            | 97 pass         | 102 pass, 1 fail | Text after the terminal is incorrectly included.             |
| C7: make rejected HTTP intents retryable      | 96 pass, 1 fail | 102 pass, 1 fail | Existing HTTP failure loses `noRetry: true`.                 |

The selected probes demonstrate twelve original survivors and two boundaries
already protected. They are not an exhaustive mutation score. Assertions use
literal input/output fixtures and public transport results rather than computing
expected values with production helpers.

### Reproduction

Install isolated workspace dependencies with
`pnpm install --offline --frozen-lockfile`. All baseline, final, and mutation runs
use this command, with a distinct JSON output filename:

```sh
pnpm exec vitest run \
  src/ts/process/request/tests/serverChat.test.ts \
  src/ts/process/request/tests/serverCompletion.test.ts \
  --no-file-parallelism --maxWorkers=1 \
  --reporter=json --outputFile=/tmp/wave2-generation-final.json
```

Apply one replacement below in an isolated worktree, run the full batch, and
restore the source before the next probe. The original-survivor results require
the baseline test files.

| Probe | Source                                                                  | Original                                                                                                 | Replacement                                                |
| ----- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| G1    | [serverChat.ts](../../src/ts/process/request/serverChat.ts)             | `authority.disposition === 'redirected' && authority.stream.operationId === operationStream.operationId` | `authority.disposition === 'redirected'`                   |
| G2    | Same                                                                    | `staleAttemptRedirects < 3`                                                                              | `true`                                                     |
| G3    | Same                                                                    | `reference.version !== 1 \|\| reference.href !== expectedHref`                                           | `reference.version !== 1`                                  |
| G4    | Same                                                                    | `if (!seenSideEffects.has(signature))`                                                                   | `if (true)`                                                |
| G5    | Same                                                                    | `tokenResult = ''` immediately before reconnect resets `replayGapPending`                                | `tokenResult += ''`                                        |
| G6    | Same                                                                    | `void stopGenerationOperation(authoritativeOperationStream.operationId)`                                 | `void authoritativeOperationStream.operationId`            |
| G7    | Same                                                                    | `const retainedResult = event.result`                                                                    | `const retainedResult = undefined`                         |
| C1    | [serverCompletion.ts](../../src/ts/process/request/serverCompletion.ts) | `decoder.decode(value, { stream: true })`                                                                | `decoder.decode(value)`                                    |
| C2    | Same                                                                    | `aborted = true`                                                                                         | `aborted = false`                                          |
| C3    | Same                                                                    | `signal.addEventListener('abort', onAbort, { once: true })`                                              | `void onAbort`                                             |
| C4    | Same                                                                    | `validatedTools.value.length > 0 && useStreaming`                                                        | `false && validatedTools.value.length > 0 && useStreaming` |
| C5    | Same                                                                    | `signal: signal ?? undefined`                                                                            | `signal: undefined`                                        |
| C6    | Same                                                                    | `if (evt.event === 'done')`                                                                              | `if (evt.event === 'never_done')`                          |
| C7    | Same                                                                    | `return { type: 'fail', result: reason, noRetry: true }`                                                 | `return { type: 'fail', result: reason, noRetry: false }`  |

## Coverage preservation and validation

All original expanded `assertionResults[].fullName` values remain in their same
file and describe group: 86 chat and 11 completion cases. Four chat and two
completion cases were added; no original cases were deleted, renamed, moved,
skipped, or focused. Sorted original-name arrays serialized as compact JSON have
these SHA-256 values:

- Chat: `b65bfad0a70adc42871dfdb7bb118aaddf768f05f0bba861ea80e1154cfedfa7`.
- Completion: `73c55ef1ef720f3248fb96f820497a4d9f615a36c3b2b6d50e39a9b2f9bc629c`.

Local evidence is retained in `/tmp/wave2-generation-baseline.json`,
`/tmp/wave2-generation-final.json`, and the matching logs. Probe JSON/log files
use `/tmp/wave2-generation-{original,original-extra,improved}-{probe}.json`
(with the corresponding `.log` suffix); aggregate mutation summaries have the
`-mutations.json` suffix. The isolated runner is
`/tmp/wave2-generation-mutations.py`. These temporary artifacts supplement the
reproducible committed report and are not durable repository inputs.

The focused source-restored batch, client typecheck, documentation validator,
Prettier, and `git diff --check` passed. Supporting commands were:

```sh
pnpm check
pnpm check:docs
pnpm exec prettier --check src/ts/process/request/tests/serverChat.test.ts src/ts/process/request/tests/serverCompletion.test.ts
pnpm exec prettier --check --ignore-path /dev/null docs/test-reviews/wave-2-generation-transport.md
git diff --check
```

No complete frontend/server/browser or
aggregate suite was rerun for these local test-only changes; the parent task
owns integration validation.

Adjacent suites retain shared SSE iterator, operation-state, provider-route,
and live browser coverage. Completion has a private LF-framed parser, unlike
the shared iterator's broader CRLF coverage; live server frames use LF, and this
review does not establish CRLF interoperability. Other transport edge cases,
including abort during a pending fetch and every malformed JSON/error variant,
remain outside these selected mutation probes. No production fix is included.
