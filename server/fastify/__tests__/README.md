# Fastify Test Map

This directory is the Node/Vitest lane for the Fastify backend. Agents may run
one exact test or the tests related to one server source file:

```sh
pnpm test -- server/fastify/__tests__/<owner>.test.ts
pnpm test -- server/fastify/src/<owner>.ts
```

`pnpm test:agent` runs the `core`-tagged server contract when the impact-based
policy requires that aggregate. The complete server lane remains in the user/CI
`pnpm test:all` aggregate.

## Current Tiers

The mutation-proven `core` cases are declared in
`util/core-test-contract.ts` and run in `pnpm test:agent`. The other files in
this directory form the extended server tier: they exercise real production
modules, Fastify, SQLite, filesystem, or provider-process boundaries and assert
responses, persisted data, files, events, or returned values. The full extended
tier runs with:

```sh
pnpm exec vitest run --config server/fastify/vitest.config.ts --maxWorkers=4
```

The folder remains flat so its shared helpers and relative imports stay stable.
Use these ownership buckets to find the surviving behavioural coverage:

| Bucket | Typical files |
| --- | --- |
| Commands and persistence mutations | `commands.test.ts`, the core `commands.*.test.ts` owners, `commandMutation*.test.ts`, `commandMessageFreeCeiling.test.ts`, `messageStore.test.ts`, `repositoryWriterKit.test.ts`, `splitPresets.test.ts`, `greetingTranslationStore.test.ts` |
| Generation and prompt assembly | `generation.*.test.ts`, `generationOperationsStartup.test.ts`, `generationEffects.test.ts`, `agentPresetExecution.test.ts`, `generationInput*.test.ts`, `preflight.test.ts`, `budgetFinalize.test.ts`, `generationBodyCap.test.ts`, `history.test.ts`, `scripts.test.ts`, `triggers.test.ts`, `luaRuntime.test.ts`, `plainSections.test.ts`, `staticSections.test.ts` |
| Intermediate display | `displaySource*.test.ts`, including scoped loading, queue priority, cache namespaces, and route behavior. |
| Memory | `memory*.test.ts`, `promptMemoryAdapter.test.ts` |
| Providers and provider transport | `openai*.test.ts`, `anthropic.test.ts`, `bedrock.test.ts`, `cohere.test.ts`, `gemini.test.ts`, `horde.test.ts`, `kobold.test.ts`, `mistral.test.ts`, `ollama.test.ts`, `oobaLegacy.test.ts`, `provider*.test.ts`, `sigv4.test.ts`, `vertexAuth.test.ts`, `chatDispatchProfileOptions.test.ts`, `modelProfileResolver.server.test.ts` |
| Jobs, streams, limits, and observability | `durableGeneration.test.ts`, `streamJobs.test.ts`, `streamBackpressure.test.ts`, `requestAbort.test.ts`, `clientDiagnostics.test.ts`, `diagnostics*.test.ts`, `remoteDiagnostics*.test.ts`, `supportDiagnosticsAuth.test.ts`, `requestTrace.test.ts`, `requestHistory*.test.ts`, `generationTraceSidecar.test.ts`, `serverLoadCostHarness.test.ts` |
| Assets, saves, imports, backups, and maintenance | `assetGc*.test.ts`, `risuSave*.test.ts`, `realmImport.test.ts`, `backups.test.ts`, `backupCopyPool.test.ts`, `maintenanceCoordinator.test.ts`, `storageUsage.test.ts` |
| Platform, routes, database, auth | `auth.test.ts`, `bootstrap.test.ts`, `config.test.ts`, `databaseDefaults.test.ts`, `databaseInitialization.test.ts`, `db.test.ts`, `missingDatabaseGuard.test.ts`, `events.test.ts`, `legacyStorage.test.ts`, `resourceReads.test.ts`, `proxy.test.ts`, `hub.test.ts`, `pushNotifications.test.ts`, `static.test.ts`, `routeProtection.test.ts` |

Asset/save owners include shared persisted-asset catalog parity, bounded
`.part` staging and incremental hashing for current and legacy backup imports,
abort/hash-failure cleanup, and the direct-only 7,000-asset Realm scale case.
Tests that need a composed resource database inject it explicitly; production
bootstrap is never patched with a legacy database payload.

Browser-smoke support and real Chromium journeys remain under
`server/fastify/browser-smoke/`; use the topical maps in
`docs/tests/README.md` rather than treating this Node/Vitest directory as their
inventory.

The embed and summarize handler suites share
`helpers/acceptedMemoryGeneration.ts` for accepted configuration and attempt
provenance. Their provider and job assertions remain with the individual worker
suites.

The command suite keeps its transaction and initialization cases in
`commands.test.ts`; the remaining domain files are core owners. See
[Command coverage ownership](../../../docs/tests/persistence-commands-and-events.md#command-coverage-ownership)
for exact file scopes and counts. `helpers/commandHarness.ts` shares setup and
resource reads; each integration case still gets a fresh app and database.

## Cleanup Rule

New coverage belongs at a real boundary and needs an explicit behavioural
oracle. Do not add source-text checks, own-module mocks, internal call-count
assertions, or split-off command suites that restate a core scenario. Keep
shared harness code in `helpers/` only while multiple surviving files use it.
