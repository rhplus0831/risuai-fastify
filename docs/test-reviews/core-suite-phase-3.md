# Core suite Phase 3: boundary tests for the remaining gaps, with mutation proof

Completed on 2026-09-22. Baseline `60f94c84f` (the Phase 2 result), result
`fastify` at the commit that adds this report. Inputs:
[core-suite-gap-analysis.md](core-suite-gap-analysis.md) (`W` rows) and the
"Open items for Phase 3" section of [core-suite-phase-2.md](core-suite-phase-2.md).
Only test files, golden fixtures, `util/core-test-contract.ts`, `util/test-all.ts`,
and documentation changed. No production source changed.

## Outcome

| Measure | Before | After |
| --- | ---: | ---: |
| Frontend core cases | 137 | 140 |
| Server core cases | 295 | 310 |
| Browser `@core` journeys | 9 | 16 |
| Compatibility golden cells in `test:agent` | 0 | 16 |
| Core contract files (frontend / server / browser) | 21 / 50 / 5 | 24 / 55 / 8 |
| `pnpm test:agent` wall time | 93 s | 113 s |
| Phase 3 production mutations caught by the merged core lanes | 4 of 35 | 35 of 35 |
| Phase 2 production mutations still caught after the merge | 79 of 80 | 79 of 80 |

Twenty seconds of the wall-time growth is the compatibility harness lane,
which now runs in `test:agent` (`util/test-all.ts`, `agentQualityLanes`).
The lane compares 16 cells of what the current stack sends to OpenAI against
committed goldens. `--update-goldens` can still rewrite them in one command;
that is a review responsibility, not something a test can prevent.

## Method

Six file-disjoint batches ran as GPT-5.6 Sol sub-agents (effort xhigh), one
git worktree each outside the repository, under a written protocol:

1. **Step A.** Before writing anything, apply each production mutation alone,
   run the full current core lane, and run any existing candidate file the
   batch named. Save the patch. A mutation the current lane already catches
   closes the item without a new test. A mutation only a non-core
   real-boundary case catches leads to promotion instead of writing.
2. **Step B.** Write the smallest test that observes the behaviour at a public
   boundary: Fastify `inject` or a listening Fastify over real SQLite,
   Playwright against the smoke build, or client modules driven against a real
   Fastify server with `fake-indexeddb`. No `vi.mock`, `vi.doMock`, or
   `vi.spyOn` on repository modules. Global `fetch` or an injected DNS lookup
   may be stubbed only when that process edge is the boundary under test. Each
   new case ran three times on the clean tree. Commit.
3. **Step C.** Re-apply every mutation against the lane with the new files.
   Each must fail at a behavioural assertion.

The integrator reviewed every diff, redirected two batches (below),
cherry-picked the commits, added the contract files in one commit, fixed one
`svelte-check` narrowing error the frontend Vitest lane had not surfaced, added
the compatibility lane to `test:agent`, and replayed all 115 saved patches
(80 from Phase 2, 35 from Phase 3) against the merged lanes in a clean scratch
worktree with a fresh smoke build. That replay is the Phase 4 gate.

## Batch summary

| Batch | Written | Promoted instead | Already core | Not done | Mutations | Survive final lane |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| server-fences | 2 | 5 | 0 | 0 | 9 | 0 |
| plugins-vault | 2 | 0 | 0 | 0 | 4 | 0 |
| golden-wire | 5 | 1 | 0 | 0 | 7 | 0 |
| browser-lifecycle | 3 | 0 | 0 | 0 | 6 | 0 |
| browser-ownership | 4 | 0 | 1 | 0 | 5 | 0 |
| client-replay | 2 | 0 | 2 | 1 | 4 | 0 |
| **Total** | **18** | **6** | **3** | **1** | **35** | **0** |

## What was written

| Batch | Item | Outcome | File | Case | Wall s |
| --- | --- | --- | --- | --- | ---: |
| server-fences | A11 | written | `luaRuntime.test.ts` | blocks localhost, private, link-local, and metadata targets through the Lua request() binding |  |
| server-fences | B6 | promoted-existing-instead | `generationEffects.test.ts` | rejects a foreign-session chat-only IGP commit without mutation |  |
| server-fences | B6 | promoted-existing-instead | `generationEffects.test.ts` | rejects a stale-target chat-only IGP commit without mutation |  |
| server-fences | H18 | written | `durableGeneration.test.ts` | rejects a stale regenerate target at submit without creating an operation or changing messages |  |
| server-fences | H32 | promoted-existing-instead | `requestTrace.test.ts` | appends API request trace entries as JSONL |  |
| server-fences | H32 | promoted-existing-instead | `requestTrace.test.ts` | records route metadata, explicit caller, and redacted query params |  |
| server-fences | H32 | promoted-existing-instead | `requestTrace.test.ts` | inlines small JSON request and response bodies with body redaction |  |
| plugins-vault | H41 | written | `src/ts/plugins/pluginPermissions.test.ts` | binds persisted runtime grants to the exact installed script hash | 0.023 |
| plugins-vault | H42 | written | `src/ts/plugins/pluginDatabaseBridge.core.test.ts` | blocks protected server-mode keys while persisting an unprotected plugin key | 0.033 |
| golden-wire | G1 | written | `providerWireGoldens.core.test.ts` | anthropic-messages |  |
| golden-wire | G2 | written | `providerWireGoldens.core.test.ts` | gemini-generate-content |  |
| golden-wire | G3 | written | `providerWireGoldens.core.test.ts` | ollama-chat-ndjson |  |
| golden-wire | G4 | written | `providerWireGoldens.core.test.ts` | bedrock-converse-sigv4 |  |
| golden-wire | G5 | written | `providerWireGoldens.core.test.ts` | profile-ignores-attacker-baseurl |  |
| golden-wire | G6 | promoted-existing-instead | `generation.chat.test.ts` | resolves browser language and screen dimensions from request-local client context |  |
| browser-lifecycle | C5 + H43 + H46 | written | `browser-smoke/coreLifecycle.spec.ts` | mobile message edit and delete persist by exact id while the composer remains usable | 5.5 |
| browser-lifecycle | C6 + C7 | written | `browser-smoke/coreLifecycle.spec.ts` | chat create and delete stay scoped to character A while character B moves to trash | 5.1 |
| browser-lifecycle | H35 | written | `browser-smoke/coreLifecycle.spec.ts` | v2 chat import re-keys colliding chat and message ids without changing the existing chat | 4.3 |
| browser-ownership | H6 | written | `browser-smoke/coreLineage.spec.ts` | a connected reader discards an old-lineage projection before rendering replacement updates | 5.3 |
| browser-ownership | H9 | written | `browser-smoke/coreOwnership.spec.ts` | a 401 ownership probe clears the signed-in projection and refuses a later write | 4.1 |
| browser-ownership | client-1 | written | `browser-smoke/coreLineage.spec.ts` | two encrypted old-lineage edits are rejected after restore and reported to the writer | 4.5 |
| browser-ownership | client-3 | already-covered-by-core | `browser-smoke/fastifyBrowserSmoke.spec.ts` | Fastify-served browser loads bootstrap, subscribes to events, and refreshes after a command | 2.2 |
| browser-ownership | client-3-writer | written | `browser-smoke/coreLineage.spec.ts` | a writer restore rejects its old-lineage settings cache and paints the restored value without reload | 4.2 |
| client-replay | client-2-server | written | `stateInitializeRace.core.test.ts` | serializes concurrent first-run initialization into one canonical database | 6.72 |
| client-replay | client-2 | not-done | `browser-smoke/bootstrapInitializationRace.boundary.spec.ts` | two real app clients converge on the first-run winner without reloading | 30.08 |
| client-replay | client-4 | written | `src/ts/process/__tests__/streamReplayGap.boundary.dom.test.ts` | replaces a truncated replay suffix with the terminal snapshot and persists that exact text | 6.21 |
| client-replay | client-5a | already-covered-by-core | `src/ts/server/pendingMutationReplay.test.ts` | propagates a retained dependency into the successor selection lane | 9.73 |
| client-replay | client-5b | already-covered-by-core | `src/ts/server/pendingMutationOutbox.test.ts` | retains but refuses to replay an intent with tampered metadata | 9.02 |

Boundaries, by batch:

- **server-fences.** The Lua `request()` case runs a real Lua script through
  `runServerLua` with an injected DNS lookup answering `169.254.169.254`,
  `10.1.2.3`, and a public address, and an injected fetch that fails the test
  if reached. The stale-regenerate case submits a regenerate operation against
  a message revision that no longer matches, asserts the 409
  `operation_target_stale` body, and reads SQLite to prove no operation row
  and no message change. The generation-effect and trace-redaction items were
  already observed by non-core `app.inject` cases that read persisted rows
  and JSONL bytes; those were promoted, one split so the foreign-session and
  stale-target fences are separate core cases, and one extended to assert
  `authorization` and `x-api-key` redaction on disk.
- **plugins-vault.** The vault case now seeds real chat messages, a turn
  receipt with an `error_summary`, document versions with provenance, and
  `bardwiki_document_sources` rows, exports through the authenticated HTTP
  route, unzips every entry, and rejects every sentinel. The permission case
  installs a plugin through the real collection owner, persists a grant for
  script A through the real `localforage` store over `fake-indexeddb`, and
  proves script B is prompted through the public alert store rather than
  granted. The database bridge case drives the real V2 bridge and resource
  projection and stubs only the outbound command transport.
- **golden-wire.** A new server core file builds the real app over SQLite,
  seeds a profile per provider with a sentinel credential through the command
  routes, stubs global `fetch` so the expected vendor host records the request
  and any other host throws, sends a real chat, and compares a normalized
  capture with a committed golden. Volatile SigV4 and date values are replaced
  by placeholders and the replaced keys are listed in the golden. Setting
  `RISU_UPDATE_PROVIDER_GOLDENS=1` rewrites the files and then fails the test,
  so a rewrite is never silent. The lorebook, trigger, and CBS cell was not
  needed: lorebook activation was already core-caught, and CBS expansion was
  caught by an existing real Fastify case that is now promoted.
- **browser-lifecycle.** Three journeys on the built smoke client: message
  edit and delete on a 390 by 844 viewport with the composer used afterwards,
  chat create and delete scoped to one character while another is trashed, and
  a v2 chat import whose ids collide with an existing chat. Every assertion
  reads SQLite by exact id after the UI action and again after reload.
- **browser-ownership.** Four journeys: a connected reader crossing a backup
  restore never repaints an old-lineage name (a `MutationObserver` counts
  repaints); a 401 on the ownership probe clears the projection and a later
  write is refused; two encrypted outbox rows written before a restore are
  rejected afterwards, SQLite keeps the restored settings, and the writer sees
  the discarded work; a writer whose resource cache holds a verified
  old-lineage settings snapshot paints the restored value without a reload.
- **client-replay.** A server core case submits two concurrent
  `state/initialize` commands and proves one canonical database. A frontend
  case runs the real generation request and reconnect path against a listening
  Fastify server with a truncated durable replay window and proves the
  terminal snapshot replaces the surviving suffix in the stream and in SQLite.

## Gaps that were narrower than claimed

- `G6a` (skip lorebook activation) was already caught by
  `generation.chat.test.ts` in core.
- `client-3` (reader applies a cached projection after a missed restore) was
  already caught by the `fastifyBrowserSmoke.spec.ts` core journey at its
  superseded-lineage cache assertion. The writer-side variant of the same
  mutation survived and now has its own journey.
- `client-5a` (ignore the outbox dependency block) and `client-5b` (drop a row
  after a decrypt failure) were already caught by the core
  `pendingMutationReplay.test.ts` and `pendingMutationOutbox.test.ts` cases;
  the latter runs real `fake-indexeddb` persistence and real WebCrypto.
- `A11c` (drop the `localhost` name check) survived the direct
  `validateEgressUrl` unit cases because real DNS still resolves `localhost`
  to a blocked address. The new runtime case injects the lookup and kills it.

## Integrator interventions

- The first `client-2` browser spec used two Playwright pages as HTTP clients
  and never loaded the application. It was rewritten as a Fastify core case,
  and a real two-tab first-run journey was attempted. The journey survived the
  server mutation, because the client's writer protocol sends only one
  initialization command, and failed once in four clean runs when the losing
  tab stayed below `background-ready` for 25 s with no retry dialog. It was
  deleted rather than tagged. The client half of `client-2` is therefore not
  done, and the stuck losing tab is worth a manual look.
- The `browser-ownership` batch had replaced a surviving writer-side
  `client-3` mutation with a reader-side one that core already caught. The
  writer mutation was restored as `client-3-writer` and a journey written for
  it.
- The merged replay let `client-3-writer` survive although the batch had
  killed it: the journey kept only the last settings request after the
  restore, and a later request that advertised no cache hashes masked the
  first one that offered the stale snapshot. Three mutant runs of the original
  journey gave one failure and two passes. The journey now records every
  replacement request and rejects the seeded hash anywhere; it then killed
  the mutation three times out of three, passed three times clean, and the
  replay of that patch at the fixed commit is CAUGHT. That is the only
  Phase 3 row whose merged replay ran at a later commit than the others.

## Open items after Phase 3

- `client-2`, client half: two real first-run tabs racing initialization.
- The `pluginDatabaseBridge.core.test.ts` case stubs the command transport,
  like the Phase 2 `client-commands` cases; the server-side protected-key
  fence is not exercised by it.
- Vertex authentication has no golden cell; the Bedrock cell covers SigV4.

## Promoted cases

| Batch | File | Case | Decision |
| --- | --- | --- | --- |
| server-fences | `generationEffects.test.ts` | rejects a foreign-session chat-only IGP commit without mutation | promoted-trimmed |
| server-fences | `generationEffects.test.ts` | rejects a stale-target chat-only IGP commit without mutation | promoted-trimmed |
| server-fences | `requestTrace.test.ts` | appends API request trace entries as JSONL | extended |
| server-fences | `requestTrace.test.ts` | records route metadata, explicit caller, and redacted query params | promoted |
| server-fences | `requestTrace.test.ts` | inlines small JSON request and response bodies with body redaction | promoted |
| plugins-vault | `src/ts/plugins/plugins.test.ts` | blocks pluginV2 database writes in server mode instead of dropping or shadowing them | not-promoted |
| golden-wire | `generation.chat.test.ts` | resolves browser language and screen dimensions from request-local client context | promoted |

## Strengthened hollow case

- plugins-vault `bardWikiVault.test.ts` strengthened: Now exports through authenticated Fastify app.inject after seeding transcript messages, receipt error metadata, version provenance, source rows, and two exact documents; every unzipped entry is checked for all sentinels and frontmatter fields are decoder-bounded.
- client-replay `src/ts/bootstrap.test.ts` left-unchanged: The mocked call-count case remains unchanged. A separate Fastify/SQLite case proves the server's concurrent initialization fence, but the attempted real-client boundary was removed after a clean run left the losing tab below background-ready indefinitely.
- client-replay `src/ts/process/__tests__/streamResponse.test.ts` left-unchanged: The synthetic replayGapTruncated input case remains unchanged; a separate listening-Fastify boundary now creates an actual replay-window truncation and reconnect.

## Mutation evidence

| Batch | Id | Behaviour broken | Core lane before | Agent final lane | Merged replay |
| --- | --- | --- | --- | --- | --- |
| server-fences | A11a | Lua request() blocks IPv4 link-local and cloud metadata addresses. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | A11b | Lua request() classifies a single DNS answer before allowing fetch. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | A11c | Lua request() rejects localhost by name before DNS or fetch. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | B6a | Generation-effect commit control rejects a foreign originating session. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | B6b | Generation-effect IGP commit rejects a drifted target transcript without mutating state. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | H18 | Regenerate operation submission rejects a stale target with 409 and creates no operation or message mutation. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | H32a | Persisted request traces redact Authorization and X-API-Key headers. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | H32b | Persisted request trace URLs redact sensitive query parameters. | survives | caught | CAUGHT (server 1 failed) |
| server-fences | H32c | Persisted JSON request bodies redact sensitive fields. | survives | caught | CAUGHT (server 1 failed) |
| plugins-vault | H39 | BardWiki vault export excludes raw source transcript text. | survives | caught | CAUGHT (server 1 failed) |
| plugins-vault | H39b | BardWiki vault manifest excludes receipt error_summary text. | survives | caught | CAUGHT (server 1 failed) |
| plugins-vault | H41 | Plugin runtime grants bind both in-memory and persisted identities to the exact script hash. | survives | caught | CAUGHT (frontend 1 failed) |
| plugins-vault | H42 | The plugin database bridge blocks protected pluginV2 writes in server-backed mode. | survives | caught | CAUGHT (frontend 1 failed) |
| golden-wire | G1 | Remove the required anthropic-version request header. | survives | caught | CAUGHT (server 1 failed) |
| golden-wire | G2 | Serialize Gemini assistant history with role assistant instead of model. | survives | caught | CAUGHT (server 1 failed) |
| golden-wire | G3 | Persist only the final non-empty Ollama NDJSON content chunk. | survives | caught | CAUGHT (server 1 failed) |
| golden-wire | G4 | Omit host from the Bedrock SigV4 SignedHeaders set. | survives | caught | CAUGHT (server 1 failed) |
| golden-wire | G5 | Allow a first-class OpenAI profile's stored baseUrl to override the fixed vendor endpoint. | survives | caught | CAUGHT (server 1 failed) |
| golden-wire | G6a | Skip async lorebook activation during prompt assembly. | already caught | caught | CAUGHT (server 1 failed) |
| golden-wire | G6b | Skip CBS expansion for the character description. | survives | caught | CAUGHT (server 1 failed) |
| browser-lifecycle | C5-edit | Message edit persists the patch to the exact targeted message id. | survives | caught | CAUGHT (browser 1 failed) |
| browser-lifecycle | C5-delete | Message delete removes the exact targeted message id while preserving its ordered neighbours. | survives | caught | CAUGHT (browser 1 failed) |
| browser-lifecycle | C7-create | Chat creation attaches the new chat row to the selected character only. | survives | caught | CAUGHT (browser 1 failed) |
| browser-lifecycle | C7-delete | Chat deletion removes the exact requested chat and its dependent rows. | survives | caught | CAUGHT (browser 1 failed) |
| browser-lifecycle | C6-delete | The supported character removal flow marks the exact selected character as trashed. | survives | caught | CAUGHT (browser 1 failed) |
| browser-lifecycle | H35 | Version 2 chat import assigns a fresh chat id and fresh message ids before persistence. | survives | caught | CAUGHT (browser 1 failed) |
| browser-ownership | H6 | The ownership probe reports the current database lineage after restore so a connected reader replaces old-lineage state before applying later updates. | survives | caught | CAUGHT (browser 1 failed) |
| browser-ownership | H9 | An ownership probe with a revoked credential returns 401, causing the browser to discard its authenticated projection and refuse later writes. | survives | caught | CAUGHT (browser 1 failed) |
| browser-ownership | client-1 | Commands carrying a superseded database lineage are rejected so encrypted old-lineage pending mutations cannot alter restored data. | survives | caught | CAUGHT (browser 1 failed) |
| browser-ownership | client-3 | A connected reader discards superseded-lineage resource-cache identities before its authoritative replacement refresh. | already caught | caught | CAUGHT (browser 2 failed) |
| browser-ownership | client-3-writer | A writer-initiated database replacement clears superseded-lineage resource-cache identities before its authoritative refresh and renders the restored  | survives | caught | CAUGHT (browser 1 failed) |
| client-replay | client-2 | Concurrent first-run initialization is conditional, so exactly one client initializes and both converge on revision 1 and one canonical database linea | survives | caught | CAUGHT (frontend 0 failed, server 3 failed) |
| client-replay | client-4 | After a real truncated durable replay, the authoritative terminal snapshot replaces the surviving token suffix instead of being appended to it. | survives | caught | CAUGHT (frontend 1 failed, server 0 failed) |
| client-replay | client-5a | Pending mutation replay blocks successors whose semantic lane or dependency lane is retained. | already caught | caught | CAUGHT (frontend 4 failed, server 0 failed) |
| client-replay | client-5b | A pending mutation row that cannot be authenticated or decrypted remains queued for later recovery. | already caught | caught | CAUGHT (frontend 14 failed, server 0 failed) |
