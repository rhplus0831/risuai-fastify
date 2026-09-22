# Test Suite Guide

Last audited: 2026-09-22.
Targeted source check: 2026-09-22 (Phase 5 suite deletion and tier ownership).

This documentation groups the current suite by protected product behavior. Treat `package.json` and the runner configuration files as the source of truth for commands and discovery; this guide intentionally avoids snapshot case counts and pass totals, which become stale whenever tests are added or parameterized matrices change.

The [Priority Test Review Worklist](../TEST-REVIEW-WORKLIST.md) tracks audits,
current file mappings, and evidence for all Critical inventory entries and High
entries rated Frequently or Often.

## Index

### Product flows and UI

- [App Navigation and Chat](app-navigation-and-chat.md) — routing, character-folder opening, floating composition, chat lists/reset, rerolls, responsive navigation, and browser smoke.
- [Settings, Profiles, and Extensions](settings-profiles-and-extensions.md) — settings pages, model/profile editors, profile/preset reordering, modules/plugins, translators, personas, and Agent Preset UI.
- [Character Content, Memory, and Catalogs](character-content-memory-and-catalogs.md) — character editors, lore/scripts, Hypa controls, Realm/catalog and mobile character behavior.
- [Shared UI, Feedback, and Accessibility](shared-ui-feedback-and-accessibility.md) — alerts, drag-safe backdrop dismissal, dialogs, generic controls, focus, onboarding, feedback, and platform surface gates.
- [Playground and Specialized Tools](playground-and-specialized-tools.md) — Playground execution, conversion, media, parser, translation, MCP, and developer tools.

### State, data, and platform

- [Browser State Sync and Recovery](browser-state-sync-and-recovery.md) — bootstrap, writer identity, encrypted outbox, replay, hydration, invalidation, refresh, and stale-state fences.
- [Domain Mutations and Editing Owners](domain-mutations-and-editing-bridges.md) — optimistic character/chat/settings/preset/persona/loadout/module/lorebook/script edits and rollback.
- [Persistence, Revisioned Commands, and Events](persistence-commands-and-events.md) — SQLite repositories, migrations, identity repair, revisions, receipts, command transactions, secret-preserving state changes, events, projections, and resource reads.
- [API Security, Runtime, and Network Boundaries](api-security-and-runtime.md) — auth, body limits, SSRF/egress policy, tracing/redaction, Web Push, startup/shutdown, and operational routes.
- [Assets, Import/Export, and Backups](assets-import-export-and-backups.md) — assets, garbage collection, save codecs, backup/restore, bundles, bounded high-cardinality Realm/CharX imports, browser uploads, and compatibility adapters.

### AI behavior and extensibility

- [Prompting, Generation, and Streaming](prompting-generation-and-streaming.md) — prompt construction, CBS history/index semantics, preflight, generation, SSE, durability, reroll, Agent Presets, and cost gates.
- [Providers, Models, and Media](providers-models-and-media.md) — model profiles, Strip CoT, translation, image/audio/transcription, and codecs.
- [Provider Adapter Conformance](providers-models-and-media.md#provider-wire-and-dispatch-contracts) — dispatch options, request/response shaping, catalogs, streams, aborts, and errors across first-class, local, legacy, free-model, and compatibility transports.
- [Credential and Secret Integrity](providers-models-and-media.md#model-profiles-and-credentials) — stored and draft credentials, masking, stable identity, stale inline-secret migration, endpoint binding, sanitized projections, and provider-operation boundaries; command-side preservation is covered by [Persistence, Revisioned Commands, and Events](persistence-commands-and-events.md#command-coverage-ownership).
- [Memory and Embeddings](memory-and-embeddings.md) — Hypa planning, summaries, embeddings, ranking, job execution, worker/API/browser reconciliation, and memory UI.
- [Scripting, Parsing, and Automation](scripting-parsing-and-automation.md) — CBS, regex scripts, triggers, Lua, HTML/chat parsing, templates, and bounded execution.
- [Plugins, Modules, and MCP](plugins-modules-and-mcp.md) — plugin permissions/sandboxing, module lifecycle, MCP transports/OAuth/tools, and RisuAccess resources.

## Running the suite

[Testing And Operations](../structure/testing-and-operations.md) is the canonical
owner for commands, impact-based lane selection, runtime classification,
aggregate scheduling, compatibility governance, coverage, CI, and startup
artifacts. Follow the conditional validation policy in `AGENTS.md`: use a focused
command when it answers a concrete question, and run `pnpm test:agent` only when
the change or unresolved risk meets that policy. Documentation-only edits use
`pnpm check:docs`.

This guide owns behavioral test discovery. Its topical documents and regression
families name useful owners without promising snapshot counts. Use Vitest and
Playwright discovery when an exact current inventory is required. Browser
`*.spec.ts` files form a separate Playwright class; the static topology utility
covers tracked `*.test.ts` files.

### Minimal agent protection

`pnpm test:agent` runs the mutation-proven core: tagged frontend and Fastify
Vitest cases, current compatibility goldens, a browser-smoke build, and the
sixteen `@core` Playwright journeys. The contract covers startup and ownership,
authentication and egress, durable commands, generation and streaming, recovery,
backup/restore, assets, provider wires, and client rollback fences. A case entered
this tier only after it killed a production mutation that the previous core
survived; the evidence is in `docs/test-reviews/core-suite-phase-2.md` and
`docs/test-reviews/core-suite-phase-3.md`. The tests outside that tier were
reduced from 1,016 files to 305 on 2026-09-22;
`docs/test-reviews/core-suite-phase-5.md` records what went and what stayed.

`util/core-test-contract.ts` is the reviewed file inventory. A wholly core file
uses `@module-tag core`; mixed files tag only the relevant cases. Playwright uses
`@core`. Untagged real-boundary Vitest cases and non-core browser-smoke specs form
the extended tier and run through focused commands, `pnpm test:all`, and CI.
Performance gates and the complete compatibility/browser matrices also belong to
that extended tier.

### Compatibility evidence ownership

Compatibility lane authority, golden updates, provenance, and retained
artifacts are canonical in
[Compatibility Harness](../structure/testing-and-operations.md#compatibility-harness).

## Regression-critical test groups

Intermediate-display wire, scope, queue/cache, diagnostics, and browser-bridge
coverage is mapped in
[Prompting, Generation, and Streaming](prompting-generation-and-streaming.md#intermediate-display).
Visible paging and scroll-anchor coverage is mapped in
[App Navigation and Chat](app-navigation-and-chat.md#connected-readers-and-visible-navigation).

1. Outbox, replay, bootstrap, and invalidation: `src/ts/server/pendingMutationOutbox.test.ts`, `src/ts/server/durableMutationDispatch.test.ts`, `src/ts/server/pendingMutationReplay.test.ts`, `src/ts/bootstrap.test.ts`, and `src/ts/server/resourceInvalidation.test.ts` protect against lost, duplicated, or stale edits.
2. Generation and durable lifecycle: `src/ts/process/__tests__/sendChat.fixtures.serverBacked.test.ts`, `server/fastify/__tests__/generation.chat.test.ts`, `server/fastify/__tests__/durableGeneration.test.ts`, and `server/fastify/browser-smoke/rerollSwipePersistence.spec.ts` protect model-visible context and durable transcripts.
3. Persistence and recovery: the core command files, `server/fastify/__tests__/legacyDatabaseImport.test.ts`, `server/fastify/__tests__/backups.test.ts`, `server/fastify/__tests__/risuSaveCodec.test.ts`, and `server/fastify/__tests__/assetGc.test.ts` protect user data through mutations, migration, backup, and import.
4. Providers, credentials, and egress: `server/fastify/__tests__/providerWireGoldens.core.test.ts`, `server/fastify/__tests__/staleInlineModelProfileSecrets.test.ts`, `server/fastify/__tests__/providerOperations.test.ts`, `server/fastify/__tests__/pluginNetwork.test.ts`, and `server/fastify/__tests__/requestTrace.test.ts` guard security-sensitive boundaries.
5. Memory jobs: retained real-SQLite suites such as `server/fastify/__tests__/memoryRepository.test.ts` and `server/fastify/__tests__/memoryWorker.test.ts`, plus `server/fastify/__tests__/promptMemoryAdapter.test.ts`, protect repository transitions, workers, ranking, and prompt injection in the extended tier.
6. Performance gates: `src/ts/__tests__/renderCostHarness.test.ts`, `src/ts/__tests__/sendCloneCountProbe.test.ts`, and `server/fastify/__tests__/serverLoadCostHarness.test.ts` protect common paths from whole-corpus work.

## Reading the detailed documents

Each feature document lists its primary inventory and groups representative
cases by behavior and the regression protected. Cross-cutting tests may appear
in more than one document—for example, a memory modal in both memory and
character UI. Inventories name files rather than claiming a suite-wide count;
use runner discovery when an exact current count is needed.

## Maintaining focused coverage

Shared algorithm behavior belongs beside its implementation in
`packages/shared-core/src/`. Browser facade tests should cover browser-specific
adaptation rather than pure re-export identity. The deleted source-text ownership
tests were not replaced with more unit tests: `util/architecture-inventory.ts`
now enforces the protocol and shared-core import boundaries as closed-world
checks in `pnpm check:server`. The same inventory owns the raw-generation caller
classification and model/runtime flat-access classification that replaced two
other structural tests.

UI interaction tests should assert bound state, emitted actions, or saved results
after an event. Reading back a DOM value assigned by the test does not prove the
application handled it. Keep explicit input/output fixtures; avoid copying the
implementation when those expected values already provide the oracle.

Repository-wide documentation and architecture validation belong to
`pnpm check:docs` and `pnpm check:server`; `test:all` runs both, while the agent
profile uses the typecheck-only server mode. Validator tests use small fixtures.
`test/compat-harness/run.ts` separately validates committed manifests and digests
in the compatibility lane.
