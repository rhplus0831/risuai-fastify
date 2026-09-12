# Fastify Test Map

This directory is the Node/Vitest lane for the Fastify backend. Agents may run
one exact test or the tests related to one server source file:

```sh
pnpm test -- server/fastify/__tests__/<owner>.test.ts
pnpm test -- server/fastify/src/<owner>.ts
```

The complete server lane runs in `pnpm test:agent` when the impact-based policy
requires that aggregate, and in the user/CI `pnpm test:all` aggregate.

## Current Buckets

The folder is intentionally still flat so existing relative imports stay stable,
but files should be read and split by these ownership buckets:

| Bucket | Typical files |
| --- | --- |
| Commands and persistence mutations | `commands.test.ts`, `command*.test.ts`, `targetedMutationPaths.test.ts`, `messageStore.test.ts`, `repositoryWriterKit.test.ts`, `splitPresets.test.ts`, `greetingTranslationStore.test.ts` |
| Generation and prompt assembly | `generation.*.test.ts`, `generationOperations*.test.ts`, `generationEffects.test.ts`, `assemble.test.ts`, `agentPresetExecution.test.ts`, `generationInput*.test.ts`, `preflight.test.ts`, `budgetFinalize.test.ts`, `generationBodyCap.test.ts`, `history.test.ts`, `templates.test.ts`, `scripts.test.ts`, `triggers.test.ts`, `luaRuntime.test.ts`, `plainSections.test.ts`, `staticSections.test.ts` |
| Intermediate display | `displaySource*.test.ts`, including scoped loading, queue priority, cache namespaces, preparation cost, diagnostics, and route behavior. |
| Memory | `memory*.test.ts`, `promptMemoryAdapter.test.ts` |
| Providers and provider transport | `openai*.test.ts`, `anthropic.test.ts`, `bedrock.test.ts`, `cohere.test.ts`, `gemini.test.ts`, `horde.test.ts`, `kobold.test.ts`, `mistral.test.ts`, `ollama.test.ts`, `oobaLegacy.test.ts`, `provider*.test.ts`, `sigv4.test.ts`, `vertexAuth.test.ts`, `chatDispatchProfileOptions.test.ts`, `modelProfileResolver.server.test.ts` |
| Jobs, streams, limits, and observability | `durableGeneration.test.ts`, `stream*.test.ts`, `requestAbort.test.ts`, `payloadBudgets.test.ts`, `clientDiagnostics.test.ts`, `diagnostics*.test.ts`, `remoteDiagnostics.test.ts`, `supportDiagnosticsAuth.test.ts`, `requestTrace.test.ts`, `requestHistory*.test.ts`, `generationTraceSidecar.test.ts`, `terminalFrameAssertions.test.ts`, `serverLoadCostHarness.test.ts` |
| Assets, saves, imports, backups, and maintenance | `assets.test.ts`, `asset*.test.ts`, `risuSave*.test.ts`, `realmImport.test.ts`, `backups.test.ts`, `backupCopy*.test.ts`, `maintenance*.test.ts`, `storageUsage.test.ts` |
| Platform, routes, database, auth | `auth.test.ts`, `bootstrap.test.ts`, `config.test.ts`, `databaseDefaults.test.ts`, `databaseInitialization.test.ts`, `db.test.ts`, `missingDatabaseGuard.test.ts`, `events.test.ts`, `index.test.ts`, `legacyStorage.test.ts`, `resourceReads.test.ts`, `proxy.test.ts`, `hub.test.ts`, `pushNotifications.test.ts`, `static.test.ts`, `routeProtection.test.ts` |

Asset/save owners include shared persisted-asset catalog parity, bounded
`.part` staging and incremental hashing for current and legacy backup imports,
abort/hash-failure cleanup, and the direct-only 7,000-asset Realm scale case.
Tests that need a composed resource database inject it explicitly; production
bootstrap is never patched with a legacy database payload.

Browser-smoke support and real Chromium journeys remain under
`server/fastify/browser-smoke/`; use the topical maps in
`docs/tests/README.md` rather than treating this Node/Vitest directory as their
inventory.

## Cleanup Rule

Prefer splitting a hotspot file before adding another large `describe` block.
Good split targets are files with many unrelated command families or provider
families. Keep shared harness code in `helpers/` when at least two test files use
it.

Avoid broad directory moves unless you are prepared to update relative imports
from `../src/*` and `./helpers/*` throughout the moved files.
