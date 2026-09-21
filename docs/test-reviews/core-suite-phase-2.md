# Core suite Phase 2: promotion, hollow-case repair, and mutation proof

Completed on 2026-09-22. Baseline `ece967d80`, result `fastify` at the commit
that adds this report. Input: [core-suite-gap-analysis.md](core-suite-gap-analysis.md).
Only test files, `util/core-test-contract.ts`, and documentation changed. No
production source changed.

## Outcome

| Measure | Before | After |
| --- | ---: | ---: |
| Frontend core cases | 122 | 137 |
| Server core cases | 241 | 295 |
| Browser `@core` journeys | 4 | 9 |
| Core contract files (frontend / server / browser) | 10 / 15 / 4 | 21 / 50 / 5 |
| `pnpm test:agent` wall time | 83 s | 93 s |
| Saved production mutations caught by the merged core lanes | 3 of 80 | 79 of 80 |

The one survivor, `persistence-commands/D1`, removes `PRAGMA foreign_keys = ON`
from `openDatabase`. `node:sqlite` on Node 24 enables foreign keys by default
(verified with a direct probe), so the edit does not change behaviour. It is an
equivalent mutation, not a gap. `db.test.ts` now asserts `foreign_keys = 1`,
which protects the runtime contract if that default ever changes.

## Method

Ten file-disjoint batches ran as GPT-5.6 Sol sub-agents (effort xhigh), one git
worktree each, under a shared protocol:

1. **Step A.** Before any test edit, apply each production mutation alone and
   run the full original core lane. Save the mutation as a patch.
2. **Step B.** Tag the named existing cases as core, or strengthen the named
   hollow core cases. Assertions must observe outcomes: persisted rows, response
   bodies, bytes, user-visible state. Commit.
3. **Step C.** Re-apply every mutation against the lane with the promoted files.
   A failure at import, setup, or timeout does not count. A promoted case that
   still misses its mutation is strengthened or reported.
4. A hollow case built only on mocks of the repository's own modules is not
   faked. It is reported as `needs-boundary-test`.

The integrator reviewed every diff (61 test files, no production paths, no file
shared between batches), cherry-picked the 13 commits, added the contract files
in one commit, and replayed all 80 saved patches against the merged lanes in a
clean scratch worktree. The replay is the Phase 4 gate rehearsal: 79 CAUGHT,
1 SURVIVES (the equivalent mutation above). The four browser-journey mutations
were proven in the Playwright lane by their batch and are also caught by the
merged server Vitest lane.

## Batch summary

| Batch | Promoted | Hollow strengthened | Covered by promotion | Needs boundary test | Mutations | Survive final lane |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| access-egress | 10 | 2 | 1 | 0 | 11 | 0 |
| secrets-credentials | 9 | 0 | 1 | 0 | 8 | 0 |
| ownership-bardwiki | 9 | 1 | 0 | 0 | 9 | 0 |
| persistence-commands | 9 | 4 | 0 | 0 | 12 | 1 |
| generation-ops | 5 | 0 | 1 | 0 | 8 | 0 |
| generation-prompt | 5 | 2 | 0 | 0 | 7 | 0 |
| assets-restore | 7 | 1 | 0 | 0 | 9 | 0 |
| client-ownership | 7 | 0 | 0 | 5 | 6 | 0 |
| client-commands | 6 | 0 | 0 | 0 | 6 | 0 |
| browser-journeys | 5 | 2 | 0 | 0 | 4 | 0 |
| **Total** | **72** | **12** | **3** | **5** | **80** | **1** |

Three mutations were already caught by the original core lane, so those gaps
were narrower than the gap analysis claimed: `access-egress/A1` (the real gap
was the Hub wildcard missing from the route-protection loops, now repaired),
`generation-prompt/hollow-2` (alternate-row writes were protected at the store,
not at the regenerate route), and `assets-restore/HOLLOW-import-asset-metadata`.

## Corrections made during the final mutation runs

- `generation-ops` H20: the promoted tool-call case covered only the positive
  path and missed both mutations. It now rejects an unsupplied tool name from
  the provider and from a browser tool round.
- `browser-journeys`: two mutations failed only through a generic exception or
  a poll timeout. The bundle journey now asserts the asset entry exists; the
  reroll journey reads the alternate rows from SQLite before the reload.
- `persistence-commands` C2: the legacy chat-id repair case now fails at a named
  assertion instead of an uncaught uniqueness error.
- Invalid first probes were replaced and recorded: `secrets-credentials/A9`,
  `access-egress/A3b`, `generation-prompt/H25`, `browser-journeys/A1`.

## Hollow core cases

| Batch | File | Outcome | Note |
| --- | --- | --- | --- |
| access-egress | `routeProtection.test.ts` | strengthened | Materializes Fastify root wildcard entries as /api/v1/hub/*, asserts all seven Hub methods are discovered, and supplies x-risu-node-path for conditional auth. The manifest decision and bidirectional uniqueness sibling loops use the same checked route list. A1  |
| access-egress | `auth.test.ts` | covered-by-promotion | Left unchanged because it mocks global fetch and observes verification counts; promoted proxy.test.ts observes A2 at a real local HTTP upstream boundary. |
| access-egress | `auth.test.ts` | strengthened | Now issues two tokens, requires distinct values, verifies each secret decodes to 32 bytes, and expires both. HAuthToken fails the uniqueness assertion. |
| secrets-credentials | `imageGeneration.test.ts` | covered-by-promotion | The existing outcome assertions already caught the wrong-provider stored-key mutation, so no assertion rewrite was needed. |
| ownership-bardwiki | `events.test.ts` | strengthened | The existing SSE setup-window case still uses an eventSnapshot spy for its own ordering purpose. An adjacent core inject case now exercises the missing owner-class route boundary with real SQLite and proves it by killing B3. |
| persistence-commands | `messageStore.test.ts` | strengthened | Now asserts the original db.json is absent and db.json.migrated exists; C1 fails both the promoted migration case and this strengthened core case. |
| persistence-commands | `commandMutationReceipts.test.ts` | strengthened | Adds a sibling character with deliberately noncanonical serialized bytes and asserts those bytes remain identical after create, fork, append, and their replays. |
| persistence-commands | `commandMutationReceipts.test.ts` | strengthened | Now asserts the persisted preset id, name, agentUses, and steps instead of only collection length and receipt count. |
| persistence-commands | `db.test.ts` | strengthened | Now asserts foreign_keys=1 in addition to WAL and synchronous=NORMAL. Removing the explicit pragma line is behaviorally neutral under Node SQLite and therefore survives. |
| generation-ops | `durableGeneration.test.ts` | covered-by-promotion | Left unchanged as directed. H17 survived the original lane but fails the promoted alternate-persistence case, which observes durable hydration rather than only active transcript replacement. |
| generation-ops | `providerTransport.test.ts` | left-unchanged | Optional batch observation only: this remains a pre-aborted-signal case; no mutation or test change was requested. |
| generation-prompt | `generation.chat.test.ts` | strengthened | Now asserts ordered MAIN, selected-character DESC, and seeded user content in provider-bound rows, and excludes a second character's description. The description-slot mutation fails this case. |
| generation-prompt | `generation.chat.test.ts` | strengthened | Now hydrates the reroll-alternate buffer and verifies the displaced old reply is retrievable. The alternate-write mutation fails this assertion. |
| assets-restore | `risuSaveCodec.test.ts` | strengthened | Seeds a real asset metadata row, preserves it through applyImport for all four codecs, closes and reopens SQLite, and asserts the reloaded metadata. The deletion mutation now fails this exact assertion; an existing core backup case also caught the wholesale de |
| client-ownership | `src/ts/bootstrap.test.ts` | needs-boundary-test | The suite mocks the ownership, outbox, replay, resource, and event modules and observes invocation order. A browser/Fastify boundary test must change database lineage while encrypted pending rows exist and prove that old-lineage rows are never dispatched befor |
| client-ownership | `src/ts/bootstrap.test.ts` | needs-boundary-test | The initialization command and bootstrap reads are repository-module mocks. A browser/Fastify test must race two real first-run clients, prove only one initialization wins, and prove the loser refetches and applies the winner's authoritative runtime metadata. |
| client-ownership | `src/ts/bootstrap.resourceEvents.dom.test.ts` | needs-boundary-test | Ownership fetch, projection discard, and replacement refresh are mocked, so the case only proves orchestration. A browser/Fastify test must miss a real restore event, receive replay-unavailable, and prove no old-lineage snapshot is applied before the new linea |
| client-ownership | `src/ts/process/__tests__/streamResponse.test.ts` | needs-boundary-test | replayGapTruncated is supplied directly as test input. A boundary test must create an actual truncated replay window, exercise the producer that detects the gap, and prove the terminal authoritative snapshot wins. |
| client-ownership | `src/ts/server/pendingMutationReplay.test.ts` | needs-boundary-test | The encrypted outbox and durable dispatch modules are mocked throughout. Boundary coverage must use real IndexedDB encryption/storage plus a real dispatch boundary to prove storage or crypto faults retain intent, and that committed ordering and dependency bloc |
| browser-journeys | `fastifyBrowserSmoke.spec.ts` | strengthened | Seeds a distinctive OpenAI secret and rejects it in captured shell/settings bodies; seeds a referenced asset, asserts exact ZIP bytes and manifest membership, removes live reference/metadata/bytes, and proves bundle re-import restores the exact bytes. |
| browser-journeys | `importRestoreRecovery.spec.ts` | strengthened | Seeds distinctive assets/ and save/ files before backup, changes/removes them, and asserts exact bytes after restore and after the follow-up browser reload. |

## Open items for Phase 3

The five `needs-boundary-test` cases need browser or Fastify tests:

1. `src/ts/bootstrap.test.ts`: database lineage changes while encrypted pending
   rows exist; old-lineage intent must not replay.
2. `src/ts/bootstrap.test.ts`: two real first-run clients race initialization;
   the loser refetches and applies the winner's state.
3. `src/ts/bootstrap.resourceEvents.dom.test.ts`: a missed restore event leads
   to replay-unavailable and no old-lineage snapshot is applied.
4. `src/ts/process/__tests__/streamResponse.test.ts`: a real truncated replay
   window, with the authoritative terminal snapshot winning.
5. `src/ts/server/pendingMutationReplay.test.ts`: real IndexedDB encryption and
   a real dispatch boundary under storage and crypto faults.

Limits of what was promoted: the six `client-commands` cases mock HTTP
transport, and the draft case mocks dispatch and outbox. They protect client
state, rollback, and access fences, not the Fastify or crypto boundary. The
`providerTransport.test.ts` abort case still covers only a pre-aborted signal.
Two unpromoted browser journeys take 33 s and 35 s and matter for the later
`test:all` speed work.

Everything marked `W` in the gap analysis, the golden cells, and the compat
golden lane in `test:agent` remain Phase 3 work. Deletion has not started.

## Promoted cases

### Batch access-egress

| File | Case | Decision |
| --- | --- | --- |
| `hub.test.ts` | rejects unauthenticated upstream URL overrides on otherwise public methods | promoted |
| `hub.test.ts` | rejects proxy overrides before a persisted Realm token can be injected | promoted |
| `hub.test.ts` | rejects query variants of the secret-injecting Realm removal route | promoted |
| `proxy.test.ts` | strips risu-* and host-class headers from the upstream request | promoted |
| `pluginNetwork.test.ts` | rejects a public-looking hostname if any DNS answer is private | promoted |
| `pluginNetwork.test.ts` | blocks a public redirect that pivots to the metadata service before the second connection | promoted |
| `remoteDiagnostics.test.ts` | requires independent explicit enablement and valid credentials in every application auth state | promoted |
| `mcpOAuthRefresh.test.ts` | loads the raw SQLite row without returning refresh credentials | promoted |
| `requestHistory.test.ts` | redacts secret-shaped metadata, error text, and known credential values before persistence | promoted |
| `clientDiagnostics.test.ts` | exposes useful request/error metadata without bodies, URLs, credentials, or free text | promoted |

### Batch secrets-credentials

| File | Case | Decision |
| --- | --- | --- |
| `commands.modelProfiles.test.ts` | creates, renames, rotates, and deletes provider credentials with masked placeholder semantics | promoted-trimmed |
| `resourceReads.test.ts` | returns the exact versioned coherent shell projection | promoted |
| `resourceReads.test.ts` | returns an allowlisted, masked settings group without collection-owned memory presets | promoted |
| `resourceReads.test.ts` | returns aggregate and allowlisted targeted collections with masked secrets | promoted |
| `staleInlineModelProfileSecrets.test.ts` | durably scrubs settings and preset rows before reads, exports, or extraction | promoted |
| `chatDispatchProfileOptions.test.ts` | dispatches first-class LLM Gateway profiles through its fixed OpenAI-compatible endpoint | promoted |
| `tts.test.ts` | rejects an endpoint override before a stored character credential reaches egress | promoted |
| `providerOperations.test.ts` | resolves only matching model-profile secrets and preserves the same-provider flat fallback | promoted |
| `imageGeneration.test.ts` | returns bounded binary image bytes without exposing the raw SQLite key | promoted |

### Batch ownership-bardwiki

| File | Case | Decision |
| --- | --- | --- |
| `chatOccupancyEnforcement.test.ts` | rejects database replacement before publication and retains lineage and rows | promoted |
| `chatOccupancyEnforcement.test.ts` | rejects backup restore inside its publication transaction while a chat is occupied | promoted |
| `activeWriter.test.ts` | lets only one acquisition use the same no-owner snapshot, preserving the winning disconnected writer | promoted |
| `activeWriter.test.ts` | persists writer ownership and epochs across a server restart | promoted |
| `chatOccupancy.test.ts` | requires durable owner identity for owner admission and preserves idempotent epochs | promoted |
| `bardWikiRebuildHandler.test.ts` | publishes a new derived document while preserving a manually edited previous rebuild document | promoted |
| `bardWikiLifecycle.test.ts` | preserves later manual Markdown and escalates every affected live document to needs_review | promoted |
| `bardWikiVault.test.ts` | requires an exact version and hash fence before replacement | promoted |
| `events.test.ts` | rejects owner-class escalation from a chat-only session at the route boundary | extended |

### Batch persistence-commands

| File | Case | Decision |
| --- | --- | --- |
| `legacyDatabaseImport.test.ts` | checkpoints and retires a successful migration, then a second boot is a no-op | promoted |
| `legacyDatabaseImport.test.ts` | repairs missing and duplicate chat ids before extracting transcript and Hypa rows | promoted |
| `commands.coldStorage.test.ts` | rejects character archives with missing chat arrays before changing live rows | promoted |
| `commandMutationReadNarrowing.test.ts` | rejects chat-scoped reads combined with writeDatabase (data-loss guard) | extended |
| `commandMutationReadNarrowing.test.ts` | single-chat commands preserve noncanonical target metadata and sibling rows | promoted |
| `commandMessageFreeCeiling.test.ts` | DELETE modules/:id uses targeted collection writes and strips references across every table | promoted |
| `commands.lorebooks.test.ts` | applies sparse lorebook entry patches in every scope without replacing unchanged fields or siblings | promoted |
| `commands.scripts.test.ts` | replaces only the owned definition field on sparse raw character and module rows | promoted |
| `commands.messages.test.ts` | updates, deletes, truncates, and replaces target chat rows without touching unrelated chats | promoted |

### Batch generation-ops

| File | Case | Decision |
| --- | --- | --- |
| `durableGeneration.test.ts` | keeps scoped Stop authority with the originating session while preserving legacy owner handoff | promoted |
| `durableGeneration.test.ts` | preserves reroll alternates while durable regenerate keeps its target authoritative | promoted |
| `generationInputLoaders.test.ts` | holds fixed selected read/output scope across unrelated characters, collections and assets | promoted |
| `generationOperationsStartup.test.ts` | rebuilds after append/launch/finalization loss without redispatching provider work | promoted |
| `generation.completion.test.ts` | round-trips only supplied tool calls and browser results through server-owned OpenAI dispatch | promoted |

### Batch generation-prompt

| File | Case | Decision |
| --- | --- | --- |
| `generation.chat.test.ts` | unsafe imported regex stops before provider dispatch and assistant persistence | promoted |
| `generation.chat.test.ts` | persists lorebook @@keep_activate_after_match and uses it on the next send | promoted |
| `generation.chat.test.ts` | keeps unsupported trigger families as no-ops and warns once per effect type | promoted |
| `generation.chat.test.ts` | emits a final prompt overflow error when pinned rows exceed the context window | promoted |
| `generation.chat.test.ts` | prefetches live Hypa query vectors and selects similar memory through the generation route | promoted |

### Batch assets-restore

| File | Case | Decision |
| --- | --- | --- |
| `assetGc.test.ts` | preserves references from settings, collection rows, character rows, chat rows, and messages | promoted |
| `assetGcScheduling.test.ts` | invalidates discovery on a deduplicated upload that only refreshes file mtime | promoted |
| `backups.test.ts` | recovers forward on boot after the database commits but old-directory cleanup crashes | promoted |
| `realmImport.test.ts` | removes new CharX assets but preserves deduplicated assets when character append fails | promoted |
| `risuSaveBundleImportRoute.test.ts` | restores the database and bundled assets into a fresh instance | promoted |
| `risuSaveBundleImportRoute.test.ts` | takes pre-import safety snapshots for zip and legacy .bin replacements | promoted |
| `risuSaveBoundedInflate.test.ts` | aborts an oversized inflate at the cap instead of materializing the payload | promoted |

### Batch client-ownership

| File | Case | Decision |
| --- | --- | --- |
| `src/ts/server/connectedTabIdentity.test.ts` | deduplicates copied sessionStorage while the originating page is suspended with its lock held | promoted |
| `src/ts/server/activeWriterSession.test.ts` | latches a 423 takeover without scheduling a reload and gates server commands | promoted |
| `src/ts/server/writerDraftRecovery.test.ts` | clones mounted inputs synchronously after revocation and before reader subscribers unmount them | promoted |
| `src/ts/server/resourceInvalidation.test.ts` | retries inconsistent full reads and applies only a common revision | promoted |
| `src/ts/server/resourceInvalidation.test.ts` | fails after bounded revision mismatches without applying any response | promoted |
| `src/ts/server/chatMessageHydration.completion.dom.test.ts` | checks $name in the downloaded completion | promoted |
| `src/ts/server/resourceCache.test.ts` | does not advertise an IndexedDB entry whose bytes do not match its key | promoted |

### Batch client-commands

| File | Case | Decision |
| --- | --- | --- |
| `src/ts/chatCommands.messages.dom.test.ts` | failed scoped message update restores attempted fields and preserves newer same-chat metadata | promoted |
| `src/ts/characterCommands.test.ts` | failed permanent delete reinserts only the missing deleted row at the previous index, restores order placement, and preserves sibling edits/appended rows | promoted |
| `src/ts/server/characterDraft.svelte.test.ts` | refreshes clean fields from an authoritative row while retaining a dirty field | promoted |
| `src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts` | does not mutate after its owner aborts while access confirmation is pending | promoted |
| `src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts` | rejects setCharacterInfo when the character row is replaced while access is pending | promoted |
| `src/ts/process/mcp/risuaccess/tests/modules.optimisticProjection.test.ts` | rejects setModuleInfo when the module object is replaced while access is pending | promoted |

### Batch browser-journeys

| File | Case | Decision |
| --- | --- | --- |
| `durableMutationRecovery.spec.ts` | failed local staging plus failed transport rolls back the visible setting and reports failure | promoted |
| `rerollSwipePersistence.spec.ts` | rerolled candidates survive a reload and stay swipe-recoverable | promoted |
| `fastifyBrowserSmoke.spec.ts` | a connected reader keeps receiving updates through a writer takeover | promoted |
| `acceptedSendProtocol.spec.ts` | two concurrent chats keep stable-target UI, recovery, and jobs isolated | promoted |
| `acceptedSendProtocol.spec.ts` | viewer transport loss reconnects boundedly and terminal snapshot stays canonical | promoted |

## Mutation evidence

"Original lane" is the core lane at `ece967d80`. "Agent final lane" is the
batch's own lane with its promoted files. "Merged replay" is the integrator's
replay against the merged contract. Patches were kept outside the repository
during the work and are not committed; each row names the behaviour broken.

| Batch | Id | Behaviour broken | Original lane | Agent final lane | Merged replay |
| --- | --- | --- | --- | --- | --- |
| access-egress | A1 | Make Hub requiresLocalAuth always return false. | already caught | caught | CAUGHT (server 5 failed) |
| access-egress | A2 | Remove risu-auth from the generic proxy request-header strip set. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | A3a | Accept a mixed DNS result when any answer is public by rejecting only when every answer is private. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | A3b | Resolve the prior hop again instead of resolving the redirect destination. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | A7 | Allow any ordinary risu-auth header to bypass the dedicated support diagnostics credential. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | A12 | Include the stored refresh token in the MCP OAuth refresh response. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | H30a | Permit x-risu-node-path on the token-injecting Realm removal route. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | H30b | Compare only the pathname and accept query variants of the token-injecting Realm removal route. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | H31 | Skip caller-supplied known credential values during recursive request-history redaction. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | H33 | Allow arbitrary diagnostic error names and project the raw error message into diagnostics. | survives | caught | CAUGHT (server 1 failed) |
| access-egress | HAuthToken | Replace the random 32-byte fallback-session secret with a fixed zero buffer. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A4 | Persist the incoming masked provider-credential literal instead of resolving the stored API key during rename. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A5a | Return raw provider settings without applying provider-secret masking. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A5b | Add raw openAIKey to the shell settings projection outside the shell allowlist. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A6 | Skip the startup SQLite repair of legacy inline model-profile secrets. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A8 | Honor the durable providerOptions.baseUrl for a first-class LLM Gateway profile instead of its fixed endpoint. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A9 | Permit and honor a caller OpenAI TTS baseUrl/config override while retaining a stored-character credential. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | A10 | Remove the profile/provider match fence before dereferencing a model-profile credential. | survives | caught | CAUGHT (server 1 failed) |
| secrets-credentials | H28 | Resolve a stored DALL-E request from the Stability key rather than the OpenAI key. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | B1a | RisuSave database replacement must reject publication while any chat is occupied. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | B1b | Backup restore must reject publication inside its transaction while any chat is occupied. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | B2 | Conditional writer acquisition must compare the expected epoch so only one request can win a shared no-owner snapshot. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | B3 | An owner-class occupancy claim requires the durable active-writer session at both service and HTTP route boundaries. | survives | caught | CAUGHT (server 2 failed) |
| ownership-bardwiki | H1 | The durable writer epoch must survive a server restart and continue increasing from its persisted value. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | H37 | A full BardWiki rebuild must preserve manually edited and review-state documents while replacing derived output. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | H38 | Stale-receipt reconciliation must preserve later manual Markdown while escalating affected live documents to needs_review. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | H40 | BardWiki vault replacement must reject a target fence whose content hash does not exactly match the live document. | survives | caught | CAUGHT (server 1 failed) |
| ownership-bardwiki | H40v | BardWiki vault replacement must reject a target fence whose version does not exactly match the live document. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | C1 | Retire a successfully imported legacy db.json only after the durable checkpoint so later boots do not replay it. | survives | caught | CAUGHT (server 3 failed) |
| persistence-commands | C2 | Repair missing and duplicate legacy chat ids before extracting chat, transcript, and Hypa rows. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | C3 | Validate a character cold-storage archive before deleting any live chat or transcript rows. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | C4 | Reject characterScopedRead combined with whole-database writeDatabase. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | H10 | A single-chat command must not rewrite sibling chat rows from id-only scoped projections. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | H13 | Active-message tail deletion remains constrained to the target chat_id. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | C6 | Module deletion strips module references from persisted chat rows as well as every other owner. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | H11 | Sparse lorebook entry updates merge with the existing entry instead of rebuilding it from patch fields. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | H12 | Replacing character scripts preserves the separate trigger definition field. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | R1 | Chat create and receipt replay do not broadly rewrite an unrelated sibling character row. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | R2 | Agent Preset command wrappers persist the submitted preset body while threading receipts. | survives | caught | CAUGHT (server 1 failed) |
| persistence-commands | D1 | openDatabase connections expose foreign_keys=1. | survives | survives | SURVIVES (server 0 failed) |
| generation-ops | B5 | Allow a non-originating writer session to stop a scoped generation operation. | survives | caught | CAUGHT (server 1 failed) |
| generation-ops | H16 | Append every non-target chat to the selected generation character through one row per chat. | survives | caught | CAUGHT (server 2 failed) |
| generation-ops | H16b | Append every non-target chat through one JSON-aggregated row, bypassing the query-row ceiling while widening output. | survives | caught | CAUGHT (server 2 failed) |
| generation-ops | H17 | Stop persisting the displaced regenerate target as a reroll alternate. | survives | caught | CAUGHT (server 2 failed) |
| generation-ops | H19 | Keep a dispatched owned attempt live during startup reconciliation so provider work can resume. | survives | caught | CAUGHT (server 1 failed) |
| generation-ops | H19b | Ignore the attempt dispatch-start marker when computing whether provider work may have run after restart. | survives | caught | CAUGHT (server 1 failed) |
| generation-ops | H20a | Trust an OpenAI provider-returned tool name even when it was not supplied in the request tool definitions. | survives | caught | CAUGHT (server 1 failed) |
| generation-ops | H20b | Validate browser-provided tool rounds against their own call names instead of supplied tool definitions. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | H23 | Swallow unsafe-regex complexity rejection with a harmless non-match so generation proceeds to provider dispatch. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | H24 | Ignore persisted @@keep_activate_after_match activation so sticky lore is omitted on the next send. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | H25 | Execute unsupported v2RunLLM by persisting its output variable instead of leaving it a no-op. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | H26 | Swallow pinned-row context overflow by clamping the counted input to the context limit. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | H27 | Replace selected prompt memory with the least-similar ranked summary. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | hollow-1 | Drop character-description rows from the assembled description slot. | survives | caught | CAUGHT (server 1 failed) |
| generation-prompt | hollow-2 | Stop saving all reroll-alternate rows. | already caught | caught | CAUGHT (server 8 failed) |
| assets-restore | E1-message-inlays | Asset GC includes SQLite message inlay references. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | E1-character-rows | Asset GC includes asset references projected from character rows. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | E2-deduplicated-upload-activity | A deduplicated upload advances the maintenance activity fence when it only refreshes file mtime. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | E3-boot-restore-recovery | Application boot completes a committed restore swap forward after cleanup interruption. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | E4-deduplicated-asset-cleanup | Failed CharX append cleanup unlinks only assets newly created by that attempt. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | E5-bundle-import-asset-bytes | Fresh bundle import writes the staged asset bytes as well as metadata. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | H36-inflate-cap | Streaming inflate aborts as soon as expanded output exceeds the configured cap. | survives | caught | CAUGHT (server 1 failed) |
| assets-restore | HOLLOW-import-asset-metadata | Portable database import preserves existing asset metadata through commit and reload. | already caught | caught | CAUGHT (server 2 failed) |
| assets-restore | H34-bundle-export-asset-omission | Bundle export includes a valid referenced asset file instead of silently omitting it. | survives | caught | CAUGHT (server 1 failed) |
| client-ownership | B4 | Reuse the copied stored session id without probing the held Web Lock. | survives | caught | CAUGHT (frontend 1 failed) |
| client-ownership | H3 | Recognize a 423 active_writer_stale response but do not enter the takeover flow. | survives | caught | CAUGHT (frontend 1 failed) |
| client-ownership | H4 | Defer writer-loss draft capture to a microtask after reader subscribers can unmount inputs. | survives | caught | CAUGHT (frontend 1 failed) |
| client-ownership | H5 | Apply full-resource read responses even when their revisions differ. | survives | caught | CAUGHT (frontend 2 failed) |
| client-ownership | H7 | Discard the expected resultMessageId while reconciling an accepted-send completion. | survives | caught | CAUGHT (frontend 1 failed) |
| client-ownership | H8 | Advertise IndexedDB cache bodies without recomputing and comparing their SHA-256 hashes. | survives | caught | CAUGHT (frontend 1 failed) |
| client-commands | A13-live-row | Perform the character write after confirmation without rejecting a replaced live owner row. | survives | caught | CAUGHT (frontend 1 failed) |
| client-commands | A13-confirmation-await | Continue the character write without awaiting access confirmation. | survives | caught | CAUGHT (frontend 2 failed) |
| client-commands | H14-message-snapshot | Restore the whole captured chat snapshot after a failed message update, clobbering newer same-chat metadata. | survives | caught | CAUGHT (frontend 1 failed) |
| client-commands | H14b-delete-index | Reinsert a permanently deleted character at index 0 when the delete command fails. | survives | caught | CAUGHT (frontend 1 failed) |
| client-commands | H15-dirty-draft | Treat the draft as having no dirty fields while merging an authoritative character row. | survives | caught | CAUGHT (frontend 1 failed) |
| client-commands | A13-module-live-row | Perform the module write after confirmation without rejecting a replaced live module row. | survives | caught | CAUGHT (frontend 1 failed) |
| browser-journeys | A1 | Shell projection exposes the raw openAIKey through a schema-valid projected field. | survives | caught | CAUGHT (server 1 failed) |
| browser-journeys | A2 | Bundle export omits every referenced asset ZIP entry. | survives | caught | CAUGHT (server 1 failed) |
| browser-journeys | A3 | Backup restore stages empty assets/save directories instead of copying their backed-up contents. | survives | caught | CAUGHT (server 2 failed) |
| browser-journeys | A4 | Reroll alternate persistence becomes a no-op. | survives | caught | CAUGHT (server 8 failed) |
