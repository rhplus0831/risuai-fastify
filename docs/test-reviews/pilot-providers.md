# Provider execution pilot review

Reviewed 2026-09-21 from baseline `949e401cfbd7dcb37f45c57db485eb938d2ee001`.
This report records the provider pilot in the [priority worklist](../../.archived-docs/performance-and-stability/test-suite-reduction-2026-09/TEST-REVIEW-WORKLIST.md).

## Outcomes and ownership

| Entry   | Outcome            | Current test owner                                                                                      | Baseline → final cases |
| ------- | ------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------: |
| TL-0007 | Verified unchanged | [chatDispatchProfileOptions.test.ts](../../server/fastify/__tests__/chatDispatchProfileOptions.test.ts) |              103 → 103 |
| TL-0008 | Improved           | [generation.completion.test.ts](../../server/fastify/__tests__/generation.completion.test.ts)           |               96 → 106 |

The baseline passed all 199 cases. The final batch passes all 209 cases.
No production behavior, test configuration, tags, or shared helpers changed.

The dispatch review covered profile-versus-flat credential/model/endpoint
precedence, missing credentials and readiness failures, provider runtime controls,
prompt privacy, tool request mapping, response frames, and fixed provider endpoints.
Its explicit conflicting fixtures and literal wire expectations already detect
wrong credential and wire-model selection. The common dispatch helper consumes
the async iterator and checks the complete token/done result.

The completion review covered authenticated HTTP dispatch, server-owned settings,
legacy provider mapping, request history, tools, buffered output, streaming/error
envelopes, and deadline/backpressure behavior. New cases close six demonstrated
mutation gaps:

- Reject each supplied `provider`, `model`, and `options` independently, including
  `null`. The original combined-field case remains intact.
- Reject streaming tool requests before provider dispatch.
- Require supplied tools for `toolRounds`, including an empty tool list. Empty
  rounds isolate this requirement from unavailable-tool or malformed-result checks.
- Accept output exactly at the UTF-8 byte cap, including a subsequent empty token,
  and finalize the iterator. The existing overflow case remains intact.

Every new HTTP rejection first proves its valid counterpart succeeds using the
same authenticated app, persisted settings, and provider response. The mock is
then cleared; rejection must return the specific 400 response with zero fetches.
These controls prevent authentication, initialization, provider readiness, or
another malformed field from masking the intended check.

## Mutation evidence

Each mutation ran separately against the entire two-file batch with one worker.
The runner restored the source in `finally` before applying the next mutation.
All reported failures were behavioral assertions, not compilation or harness
failures. A final source-restored batch passed.

| Mutation                                                                  | Original 199-case batch | Improved 209-case batch | Failure evidence / classification                                                                                                   |
| ------------------------------------------------------------------------- | ----------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Omit the `provider` disjunct from the server-intent forbidden-field guard | 199 pass, 0 fail        | 207 pass, 2 fail        | Isolated provider/value and provider/null requests return 200 instead of 400. Original survivor was masked by the other two fields. |
| Omit the `model` disjunct from the same guard                             | 199 pass, 0 fail        | 207 pass, 2 fail        | Isolated model/value and model/null assertions fail for the same reason.                                                            |
| Omit the `options` disjunct from the same guard                           | 199 pass, 0 fail        | 207 pass, 2 fail        | Isolated options/value and options/null assertions fail for the same reason.                                                        |
| Change buffered-output overflow from `>` to `>=`                          | 199 pass, 0 fail        | 208 pass, 1 fail        | Exact-cap success rejects with `CompletionOutputLimitError`. Original survivor was a missing inclusive-boundary case.               |
| Prefer `db.openrouterKey` over the profile key                            | 197 pass, 2 fail        | 207 pass, 2 fail        | Existing OpenRouter authorization assertions see the conflicting/flat key instead of the selected profile key. Already protected.   |
| Return `profile.modelId` instead of the resolved provider request model   | 171 pass, 28 fail       | 181 pass, 28 fail       | Existing request-body, endpoint, and metric assertions detect registry IDs replacing provider wire IDs. Already protected.          |
| Disable the streaming-tools rejection                                     | 199 pass, 0 fail        | 208 pass, 1 fail        | Streaming tools return 200 instead of the required JSON 400. Original survivor was missing HTTP validation coverage.                |
| Remove the empty-list part of the supplied-tools requirement              | 199 pass, 0 fail        | 208 pass, 1 fail        | Empty supplied tools with empty rounds return 200 instead of 400. Original survivor was missing independent route coverage.         |

No mutation survived the improved batch. These eight probes are selected
regressions, not an exhaustive mutation score.

### Reproduction

From the repository root, the baseline, improved, mutation, and restored runs all
used this batch command, with a distinct JSON output filename per run:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts \
  server/fastify/__tests__/chatDispatchProfileOptions.test.ts \
  server/fastify/__tests__/generation.completion.test.ts \
  --maxWorkers=1 --reporter=json --outputFile=/tmp/pilot-providers-result.json
```

To reproduce mutations, use an isolated worktree and apply exactly one replacement
below, run the batch, and restore that source file before the next replacement.
Use the baseline commit above to reproduce the original survivors; use the
reviewed version for the improved results.

| Source owner                                                       | Exact original expression                                                                           | Replacement                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [generation.ts](../../server/fastify/src/routes/generation.ts)     | `body.provider !== undefined \|\| body.model !== undefined \|\| body.options !== undefined`         | `body.model !== undefined \|\| body.options !== undefined`                  |
| Same owner                                                         | Same original expression                                                                            | `body.provider !== undefined \|\| body.options !== undefined`               |
| Same owner                                                         | Same original expression                                                                            | `body.provider !== undefined \|\| body.model !== undefined`                 |
| Same owner                                                         | `if (resultBytes > maxBytes)`                                                                       | `if (resultBytes >= maxBytes)`                                              |
| [chatDispatch.ts](../../server/fastify/src/prompt/chatDispatch.ts) | `const apiKey = asString(options.apiKey)`                                                           | `const apiKey = asString(db.openrouterKey) ?? asString(options.apiKey)`     |
| Same owner                                                         | `if (profile) return resolveProfileRequestModel(profile)`                                           | `if (profile) return profile.modelId`                                       |
| Generation route                                                   | `if ((tools?.length ?? 0) > 0 && body.stream === true)`                                             | `if (false && (tools?.length ?? 0) > 0 && body.stream === true)`            |
| Generation route                                                   | `if (!tools \|\| tools.length === 0) return badRequest(reply, 'toolRounds require supplied tools')` | `if (!tools) return badRequest(reply, 'toolRounds require supplied tools')` |

## Coverage preservation and overlap decisions

All original expanded full test names remain in the same file and describe group:
103 of 103 dispatch cases and 96 of 96 completion cases. There are ten new
completion cases and no deleted, renamed, moved, skipped, or focused cases.
Comparison used Vitest JSON `assertionResults[].fullName`, rather than counts
alone. SHA-256 of each sorted original-name array serialized as compact JSON:

- Dispatch: `6e04e1bb55549283ec2459ead90f0865f3d87c729916a5d77acd4159ebc168ae`.
- Completion: `d581d50f722aefc51f2802a20d36569b9c22b54e63b578b8c38b63d16459044e`.

The session artifact `/tmp/pilot-providers-case-conservation.json` contains both
full inventories and the ten added names. Neither original suite contains `core`
tags; they remain extended tests in the unchanged Fastify Node/forks project.
The test diff contains additions only. No discovery changes are necessary.

Inspected neighboring owners remain complementary:

- [modelProfileResolver.server.test.ts](../../server/fastify/__tests__/modelProfileResolver.server.test.ts)
  tests resolver/migration behavior; the dispatch suite proves resolved settings
  reach the wire despite conflicting flat fields.
- [openaiResponses.test.ts](../../server/fastify/__tests__/openaiResponses.test.ts)
  tests native message/tool sanitation; completion and dispatch cases prove
  route/profile inputs actually reach that adapter.
- [vertexAuth.test.ts](../../server/fastify/__tests__/vertexAuth.test.ts) owns JWT
  signature verification and token lifecycle. The profile suite's issuer,
  project, region, token-exchange URL, and bearer assertions protect selection
  without copying the cryptographic unit tests.
- [serverTool.test.ts](../../packages/protocol/src/serverTool.test.ts) validates
  tool definitions/calls/results but cannot prove the completion route enforces
  buffered tool operation or requires supplied tools.
- [generationBodyCap.test.ts](../../server/fastify/__tests__/generationBodyCap.test.ts)
  bounds upstream response bodies, while
  [streamBackpressure.test.ts](../../server/fastify/__tests__/streamBackpressure.test.ts)
  bounds outgoing buffered bytes. Neither owns the completion collector's decoded
  UTF-8 output cap.

No tests were consolidated. Existing provider describe groups remain readable,
and the focused batch is inexpensive, so extracting another shared fixture or
mechanically splitting files would add maintenance work without a demonstrated
benefit in this pilot. Production resolvers are used to construct dispatch inputs,
not to compute expected wire URLs, credentials, payloads, or outputs.

## Validation and limits

Validation includes the 199-case baseline, the 209-case improved run, eight
mutations before and after improvement, and a final restored 209-case run.
Prettier, `git diff --check`, documentation validation, and expanded-name
conservation also passed. Source restoration was checked with a clean production
diff before commit.

The initial baseline reported approximately 2.7 seconds for dispatch and 4.3
seconds for completion; full command runs including import/collection overhead
took roughly 14–15 seconds. Eight sequential mutations in each version required
about four minutes of runner time. Review of the large provider matrix, rather
than execution, dominates this batch; future batches should be limited by
behavioral breadth as well as case counts. One worker and one process at a time
were sufficient.

No product defect or required unresolved check remains for these changes. The
review does not claim complete mutation coverage, live-provider conformance, or
browser integration. Provider adapters, protocol validators, credential command
tests, and browser consumers retain their own review obligations. `test:agent`
and `test:all` were not run: this change adds local tests without altering shared
runtime behavior, contracts, configuration, or coverage routing.

A separate coverage opportunity remains: the legacy Kobold and Ooba completion
route branches have adapter and profile-dispatch coverage, but no direct HTTP
cases in this completion suite. This pilot did not establish a behavioral defect
or run a mutation probe for those branches; a later legacy-route review can
decide whether that additional boundary coverage is valuable.
