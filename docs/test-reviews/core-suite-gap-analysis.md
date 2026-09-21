# Core suite gap analysis

Analysed on 2026-09-22 at `7f021c87e`. Purpose: establish what the core suite
does not protect before tests outside it are removed. No production or test
source was changed. This report is the only file added.

## Method

1. The exact core inventory was collected with `vitest list --tagsFilter core`
   over the files in `util/core-test-contract.ts`, plus the four Playwright
   `@core` journeys. It holds **366 cases in 29 files**: 122 frontend, 241
   server, and 4 browser journeys. All 363 Vitest cases pass.
2. The two core Vitest lanes were run with v8 coverage to measure what they
   execute. Execution is not protection, but a file that never runs is
   certainly unprotected. The browser journeys are not in these figures.
3. Sixteen read-only GPT-5.6 Luna workers (effort high) each mapped one risk
   domain: risk behaviours, core verdict, best non-core test, and top gaps.
4. Eight Opus sub-agents adversarially verified those reports against source
   and test bodies. They overturned about thirty Luna claims in both
   directions. Only verified findings appear below.
5. The parent session spot-checked the most consequential claims. Three are
   recorded under [Spot checks](#spot-checks).

Only Critical and High consequences from the `docs/TEST-LIST.md` rubric were
considered. Medium and Low behaviour is deliberately left out of core.

## Measured execution by the core Vitest lanes

| Area | Executable lines | Executed by core | Files never executed |
| --- | ---: | ---: | ---: |
| `server/fastify/src` | 42,806 | 31.0% | 26 of 280 |
| `src/ts` client logic | 66,044 | 10.3% | 213 of 494 |
| `src/lib` Svelte UI | 28,546 | 0.0% | 322 of 330 |

Notable near-zero server modules: `assetGc.ts` 2%, `routes/realmImport.ts` 4%,
`localFileImport.ts` 2%, `risuSave/localBackupImport.ts` 5%,
`routes/generation.ts` 2%, `routes/generationEffects.ts` 6%, every adapter in
`generation/` about 0 to 1%, `requestTrace.ts` 4%, `tts.ts` 5%,
`imageGeneration.ts` 6%, `commands/providerCredentials.ts` 0%,
`prompt/lorebook.ts` 11%, `prompt/triggerDataEffects.ts` 0%.

## Headline findings

- The core suite is a sound skeleton for the write path it was built around:
  command transactions, receipts, revisions, SSE events, message store,
  migrations, outbox encryption, durable generation cancel and finalization.
  The verifiers confirmed those cases fail under plausible regressions.
- It has **about 30 distinct Critical gaps and about 45 High gaps**. Most
  Critical gaps are in areas the contract never listed: asset garbage
  collection, import and restore, secret masking, egress and SSRF fences,
  per-chat occupancy, and every destructive delete.
- Most gaps already have a trustworthy real-boundary test outside core. About
  70 existing cases are recommended for promotion, about 14 tests must be
  written, and about 8 golden cells added. Core would grow from 366 to roughly
  460 cases, still about 3% of the suite.
- About 20 current core cases are hollow. The client bootstrap cases assert
  mocked call order only. Several server and browser cases assert status codes
  or non-emptiness only.
- The compatibility goldens are the best protection for what is sent to a
  model, but they run in `test:all` and not in `test:agent`.

## Verified Critical gaps

Paths are relative to `server/fastify/` unless they start with `src/`,
`packages/`, or `test/`. Action `P` promotes an existing case to core. Action
`W` writes a new boundary test.

### Access, egress, and secrets

| # | Behaviour | Source | Action |
| --- | --- | --- | --- |
| A1 | Unauthenticated `x-risu-node-path` override must not turn a public Hub GET into an arbitrary server fetch | `src/routes/hub.ts:50` | P `__tests__/hub.test.ts:306` |
| A2 | Generic proxy strips `risu-auth` and hop headers before forwarding | `src/proxy.ts:11` | P `__tests__/proxy.test.ts:535` |
| A3 | Plugin proxy rejects private DNS answers and re-pins every redirect hop | `src/pluginNetwork.ts:160` | P `__tests__/pluginNetwork.test.ts:132` and `:218` |
| A4 | Masked-placeholder credential edit keeps the stored key | `src/providerSecrets.ts:80`, `src/commands/providerCredentials.ts:66` | P `__tests__/commands.modelProfiles.test.ts:519`, trimmed |
| A5 | Resource projections mask provider secrets and ship only the shell allowlist | `src/routes/resourceReads.ts:408` | P `__tests__/resourceReads.test.ts:335`, `:540`, `:774` |
| A6 | Startup repair scrubs legacy inline profile secrets before read or export | `src/repository.ts:490` | P `__tests__/staleInlineModelProfileSecrets.test.ts:98` |
| A7 | Support diagnostics need separate enablement and a dedicated bearer | `src/remoteDiagnostics.ts:312` | P `__tests__/remoteDiagnostics.test.ts:405` |
| A8 | First-class profile ignores a stored `baseUrl` and uses only the selected credential | `packages/shared-core/src/modelProfileResolver.ts:1511` | P `__tests__/chatDispatchProfileOptions.test.ts:2874` |
| A9 | TTS refuses a caller `baseUrl` combined with a stored credential | `src/tts.ts:403` | P `__tests__/tts.test.ts:450` |
| A10 | Provider-operation credentials come only from a matching-provider profile | `src/providerOperations.ts:467` | P `__tests__/providerOperations.test.ts:234` |
| A11 | Lua `request()` blocks localhost, private, and metadata targets | `src/prompt/luaRuntime.ts:347` | W at `runServerLua` with a resolver returning `169.254.169.254` |
| A12 | MCP OAuth refresh returns only the access token | `src/mcpOAuthRefresh.ts:150` | P `__tests__/mcpOAuthRefresh.test.ts:394` |
| A13 | RisuAccess write tools need fresh confirmation and re-verify the live owner row | `src/ts/process/mcp/risuaccess/characters.ts:547` | P `src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts:207` and `:263` |

### Ownership and occupancy

| # | Behaviour | Source | Action |
| --- | --- | --- | --- |
| B1 | Import and backup restore fail closed while any chat is occupied | `src/chatOccupancy.ts:210` | P `__tests__/chatOccupancyEnforcement.test.ts:557` and `:585` |
| B2 | Only one of two racing tabs wins conditional writer acquisition | `src/routes/bootstrap.ts:99` | P `__tests__/activeWriter.test.ts:136` |
| B3 | Owner-class occupancy claim requires the durable active-writer session | `src/chatOccupancy.ts:722` | P `__tests__/chatOccupancy.test.ts:120` |
| B4 | A duplicated tab does not inherit the writer session id | `src/ts/server/connectedTabIdentity.ts:27` | P `src/ts/server/connectedTabIdentity.test.ts:88`, mock-heavy, medium confidence |
| B5 | Stop and retry on an accepted operation are refused for a foreign session | `src/routes/generationOperations.ts:410` | P `__tests__/durableGeneration.test.ts:1126` |
| B6 | Generation-effect claim and commit fence foreign sessions and stale targets | `src/routes/generationEffects.ts:99` | W at Fastify inject with real SQLite, medium confidence |

### Persistence and destructive writes

| # | Behaviour | Source | Action |
| --- | --- | --- | --- |
| C1 | Legacy `db.json` is retired after import, and a second boot is a no-op. A lost rename wipes SQLite back to the snapshot on every boot | `src/repository.ts:3441` | P `__tests__/legacyDatabaseImport.test.ts:113` |
| C2 | Missing or duplicate legacy chat ids are repaired before extraction | `src/repository.ts:2250` | P `__tests__/legacyDatabaseImport.test.ts:153` |
| C3 | Cold-storage recovery validates the archive before deleting live chats | `src/routes/commands.ts:6329` | P `__tests__/commands.coldStorage.test.ts:140` |
| C4 | A scoped read is never combined with a whole-database write-back | `src/commands/mutations.ts:230` | P `__tests__/commandMutationReadNarrowing.test.ts:1718` and extend. Only 2 of 7 guard combinations are tested anywhere |
| C5 | Message delete removes the captured row, not a replacement | `src/lib/ChatScreens/Chat.svelte:1115`, `src/routes/commands.ts:7659` | W browser journey. No Playwright spec clicks remove, and no core server case issues the DELETE |
| C6 | Character delete and soft-trash target the right row | `src/ts/characters.ts:1292`, `src/routes/commands.ts:6420` | W browser journey, plus P `__tests__/commandMessageFreeCeiling.test.ts:204` |
| C7 | Chat create and delete apply to the right chat | `src/lib/SideBars/SideChatList.svelte:805` | W, folded into the C6 journey |

### Assets, import, and restore

| # | Behaviour | Source | Action |
| --- | --- | --- | --- |
| E1 | Asset GC deletes only unreferenced assets across settings, collections, characters, chats, and message inlays. It runs every 15 minutes | `src/assetGc.ts:400` | P `__tests__/assetGc.test.ts:296` |
| E2 | A deduplicated re-upload cannot be reclaimed by an in-flight sweep | `src/repository.ts:3991` | P `__tests__/assetGcScheduling.test.ts:447` |
| E3 | An interrupted restore swap converges on the next boot | `src/repository.ts:4940` | P `__tests__/backups.test.ts:2602` |
| E4 | Failed Realm or CharX import removes only newly created assets | `src/routes/realmImport.ts:1595` | P `__tests__/realmImport.test.ts:1709` |
| E5 | Bundle restore brings back the database and asset bytes with a safety snapshot | `src/routes/save.ts:223` | P `__tests__/risuSaveBundleImportRoute.test.ts:929` and `:1093` |

## Verified High gaps

| # | Behaviour | Action |
| --- | --- | --- |
| H1 | Writer session and epoch persist across restart | P `__tests__/activeWriter.test.ts:319` |
| H2 | Second browser stays a reader, takeover needs confirmation, loser demotes | P `browser-smoke/fastifyBrowserSmoke.spec.ts:567` as a journey |
| H3 | A 423 stale-writer response revokes mutation and generation | P `src/ts/server/activeWriterSession.test.ts:162` |
| H4 | Unsaved drafts are captured at writer revocation | P `src/ts/server/writerDraftRecovery.test.ts:114` |
| H5 | Full refresh applies nothing unless reads converge on one revision | P `src/ts/server/resourceInvalidation.test.ts:900` and `:868` |
| H6 | A reader stops applying data after a database lineage change | W browser plus Fastify |
| H7 | Accepted-send reconciliation needs an exact operation and message match | P `src/ts/server/chatMessageHydration.completion.dom.test.ts:102` |
| H8 | Cached resource bodies are re-hashed before being advertised | P `src/ts/server/resourceCache.test.ts:141` |
| H9 | A 401 on the ownership probe discards the projection | W browser plus Fastify |
| H10 | Sparse character and chat patches preserve siblings | P `__tests__/commandMutationReadNarrowing.test.ts:1270` |
| H11 | Lorebook patches stay scoped to their owner | P `__tests__/commands.lorebooks.test.ts:522` |
| H12 | Script and trigger replacement touches only the owned field | P `__tests__/commands.scripts.test.ts:248` |
| H13 | HTTP message update, delete, truncate, and replace stay chat-scoped | P `__tests__/commands.messages.test.ts:217`, trimmed |
| H14 | Client chat and character command rollback by stable id | P `src/ts/chatCommands.messages.dom.test.ts:1559`, `src/ts/characterCommands.test.ts:687`, medium confidence |
| H15 | Character draft merge keeps dirty fields | P `src/ts/server/characterDraft.svelte.test.ts:244` |
| H16 | Generation loaders return only the requested character and chat | P `__tests__/generationInputLoaders.test.ts:382` |
| H17 | Regenerate moves the old reply into durable alternates | P `__tests__/durableGeneration.test.ts:5827` |
| H18 | Operation submit rejects a stale regenerate target with 409 | W. No test asserts this submit-time rejection |
| H19 | Restart reconciles in-flight operations without redispatching the provider | P `__tests__/generationOperationsStartup.test.ts:98` |
| H20 | Server tool rounds on `/api/v1/generate/completion`, a route at 2% coverage | P `__tests__/generation.completion.test.ts:430` |
| H21 | Two concurrent chats stay isolated | P `browser-smoke/acceptedSendProtocol.spec.ts:1131` |
| H22 | The terminal snapshot wins after a replay gap | P `browser-smoke/acceptedSendProtocol.spec.ts:1082` |
| H23 | Unsafe imported regex stops before dispatch | P `__tests__/generation.chat.test.ts:3667` |
| H24 | Lorebook activation, injection, and chat-variable delta | P `__tests__/generation.chat.test.ts:2100` |
| H25 | Unsupported V2 trigger effects stay no-ops | P `__tests__/generation.chat.test.ts:1775` |
| H26 | Pinned-row overflow returns a structured error | P `__tests__/generation.chat.test.ts:4290` |
| H27 | Hypa selects and injects the right summary | P `__tests__/generation.chat.test.ts:1176` |
| H28 | Image generation binds stored keys per provider | P `__tests__/imageGeneration.test.ts:531` |
| H29 | Non-OpenAI adapter wire formats | Add golden cells, see below |
| H30 | Realm token leaves only through the exact remove operation | P `__tests__/hub.test.ts:438` and `:461` |
| H31 | Request history redacts secrets before SQLite | P `__tests__/requestHistory.test.ts:106` |
| H32 | Trace files redact credential headers, query parameters, and bodies | W one persisted-trace audit |
| H33 | Client diagnostics stay content-free | P `__tests__/clientDiagnostics.test.ts:72` |
| H34 | Export fails closed on an asset hash mismatch | Covered by E5, or W |
| H35 | Chat import re-keys ids | W browser journey. Do not promote `src/ts/characters.importChat.test.ts:408`, which mocks the dispatch boundary |
| H36 | Inflate aborts a decompression bomb | P `__tests__/risuSaveBoundedInflate.test.ts:47` |
| H37 | Full BardWiki rebuild never deletes a user-edited document | P `__tests__/bardWikiRebuildHandler.test.ts:405` |
| H38 | BardWiki stale-receipt reconcile preserves later manual edits | P `__tests__/bardWikiLifecycle.test.ts:281` |
| H39 | BardWiki vault export never carries raw transcript text | W. The existing case is vacuous, see spot checks |
| H40 | BardWiki vault import needs an exact version and hash fence | P `__tests__/bardWikiVault.test.ts:146` |
| H41 | Plugin runtime grant is tied to the exact script hash | W at `getPluginPermission` |
| H42 | Plugin database bridge blocks protected keys in server mode | W preferred over `src/ts/plugins/plugins.test.ts:1368` |
| H43 | Message edit persists by stable id | W, folded into the C5 journey |
| H44 | A failed settings save rolls back and reports failure | P `browser-smoke/durableMutationRecovery.spec.ts:135` |
| H45 | Reroll candidates survive reload | P `browser-smoke/rerollSwipePersistence.spec.ts:32` |
| H46 | Mobile composer stays usable | Add a 390 by 844 viewport to the C5 journey |

## Browser journeys

The four `@core` journeys assert: send with cold-reload transcript render, a
settings toggle through a revision gap, and a server backup round-trip of one
boolean. `fastifyBrowserSmoke.spec.ts:129` asserts mostly API status lists and
one visible avatar, so it is not UI protection. No spec anywhere clicks message
remove, chat create or delete, or character delete.

Recommended core is **eight journeys**: keep four, promote
`durableMutationRecovery.spec.ts:135` and `rerollSwipePersistence.spec.ts:32`,
and write two. The first new journey covers message edit and delete with a
mobile viewport. The second covers chat and character lifecycle. H2, H21, and
H22 are further promotions if the browser budget allows.

All 217 test files under `src/lib` run at 0% core coverage and are presumed
deletable. One borderline exception is
`src/lib/ChatScreens/Chat.deletion.dom.test.ts:120`, which is mock-heavy but
provokes a race that is awkward in a browser.

## Golden fixtures for what reaches the model

`test/compat-harness/current.runner.ts` builds real Fastify over real SQLite,
intercepts only the OpenAI endpoint, throws on any other fetch, and stores the
URL, headers, and full ordered body for 16 cells. That is stronger than
promoting adapter unit tests. Its gaps: no `modelProfiles`, no lorebook,
triggers, CBS or Hypa content, and only the OpenAI format.

Recommended: add about eight cells covering Anthropic, Gemini, Ollama, and
Bedrock, one profile cell with an attacker `baseUrl` and a conflicting flat
key, and one lorebook, trigger, and CBS assembly cell. **Add the current-stack
golden lane to `test:agent`.** It runs only in `test:all` today
(`util/test-all.ts:125`), so it would protect nothing on the surviving lane.
Note that `--update-goldens` can erase this protection in one command.

## Core cases that are hollow

These are core-tagged but would pass under the named regression.

| Case | Regression that still passes |
| --- | --- |
| `src/ts/bootstrap.test.ts:251` | Replay the outbox under the wrong lineage. It asserts mocked call order only |
| `src/ts/bootstrap.test.ts:363` | A real first-run initialization race. It asserts a mocked call count |
| `src/ts/bootstrap.resourceEvents.dom.test.ts:406` | Apply an older snapshot during refresh. It asserts that a mock was called |
| `src/ts/server/pendingMutationReplay.test.ts` | Any storage or crypto fault. It mocks the outbox and dispatch |
| `src/ts/process/__tests__/streamResponse.test.ts:347` | Break replay-gap detection. The gap flag is a test input |
| `__tests__/events.test.ts:505` | Delete occupancy claim authorization in the route. It spies on the service |
| `__tests__/routeProtection.test.ts:189`, `:219` | Make the Hub wildcard public. The route loop cannot see it |
| `__tests__/auth.test.ts:380` | Stop stripping `risu-auth` in the proxy. Fetch is mocked and only counts are asserted |
| `__tests__/auth.test.ts:290` | Replace token randomness with a counter. It asserts three token parts |
| `__tests__/messageStore.test.ts:673` | Drop the legacy rename, see C1 |
| `__tests__/commandMutationReceipts.test.ts:228`, `:819` | Broad rewrite of siblings, or a mangled preset body |
| `__tests__/db.test.ts:995` | Drop any pragma other than journal and sync modes |
| `__tests__/generation.chat.test.ts:1126` | Drop the character description from the prompt. It asserts a non-empty message list |
| `__tests__/generation.chat.test.ts:7363`, `__tests__/durableGeneration.test.ts:5773` | Stop saving reroll alternates |
| `__tests__/risuSaveCodec.test.ts:1206` | Drop asset metadata on import. The fixture has no assets |
| `browser-smoke/fastifyBrowserSmoke.spec.ts:129` | Export a bundle with no assets, or return secrets in the shell read |
| `browser-smoke/importRestoreRecovery.spec.ts:168` | Skip the assets and save directory swap on restore |

## Safe to leave out of core

Verified as Medium or lower, or already fenced elsewhere in core: Hypa
planning, summarize, embed, and worker code, which is derived and
recomputable. Message translation and translator presets. MCP module scope,
transport deadlines, and listener cleanup. Plugin custom storage and update
download bounds. Agent Preset cleanup and preflight. Loadouts and split or
legacy preset breadth. Legacy raw storage routes, which the live client never
calls. Storage usage accounting. Realm progress and size caps beyond E4.
`prompt/triggerDataEffects.ts`. Horde, Mistral, Cohere, and legacy instruct
adapters. Authenticated proxy body caps. The entry preload error surface.
Scroll, geometry, and paint browser specs. V3 sandbox CSP constants, whose
existing test compares a constant with itself.

## Luna claims the verifiers overturned

- The migration chain is core-covered. `__tests__/db.test.ts:1008` walks all
  41 migrations from version zero.
- Receipt replay is uniformly core-fenced through one shared context.
- Cold transcript render after reload is core-covered by the send journey.
- Browser SSE framing is covered. The real parser runs at 84% in core.
- `chatDispatchProfileOptions.test.ts` is not mock-heavy. It has no
  `vi.mock` and stubs only global fetch.
- Route authentication for plugin proxy, MCP, BardWiki, and memory routes is
  core-covered. Only the behaviour behind those routes is unprotected.
- Bootstrap secret leakage, provider-operation endpoint binding, Hub body
  limits, translation overwrite, and Agent Preset deletion were downgraded.

## Spot checks

1. A temporary probe test, since deleted, built the app and parsed its route
   tree with the core helper. It found 323 routes and 316 API routes. The Hub
   wildcard prints as a root `*` node, so `/api/v1/hub/*` never enters the
   authentication loop at `routeProtection.test.ts:223`. Only
   `/api/v1/hub/hub/remove` is seen.
2. `messageStore.test.ts:673` states in a comment that the legacy file is
   renamed, and asserts nothing about it.
3. `bardWikiVault.test.ts:102` checks the archive for a string that no
   fixture ever inserts.
4. `operation_target_stale` appears in one test, as a finalization journal
   failure code. No test asserts the 409 at submit.

## Limits

This is a reasoned review, not a mutation run. Verdicts rest on reading test
bodies and imagining one plausible regression each. Line numbers are valid at
the analysed commit. Items marked medium confidence, and the verifiers' stated
unverified areas, should be checked again when they are acted on: the full
`canGenerate` readiness matrix, `routes/generationEffects.ts` handler bodies,
`diagnosticsJournal.ts`, `bardWikiApplyTurnHandler.ts` atomicity, and the V3
plugin unload lifecycle.
