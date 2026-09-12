# Test Suite Guide

Last audited: 2026-09-03.
Targeted source check: 2026-09-12 (current test families and documentation routing).

This documentation groups the current suite by protected product behavior. Treat `package.json` and the runner configuration files as the source of truth for commands and discovery; this guide intentionally avoids snapshot case counts and pass totals, which become stale whenever tests are added or parameterized matrices change.

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
- [Provider Adapter Conformance](providers-models-and-media.md#test-groups) — dispatch options, request/response shaping, catalogs, streams, aborts, and errors across first-class, local, legacy, free-model, and compatibility transports.
- [Credential and Secret Integrity](providers-models-and-media.md#test-groups) — stored and draft credentials, masking, stable identity, stale inline-secret migration, endpoint binding, sanitized projections, and provider-operation boundaries; command-side preservation is covered by [Persistence, Revisioned Commands, and Events](persistence-commands-and-events.md#command-api-behavior-inventory).
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

### Compatibility evidence ownership

Compatibility lane authority, golden updates, provenance, and retained
artifacts are canonical in
[Compatibility Harness](../structure/testing-and-operations.md#compatibility-harness).

## Regression-critical test groups

Intermediate-display wire, scope, queue/cache, diagnostics, and browser-bridge
coverage is mapped in
[Prompting, Generation, and Streaming](prompting-generation-and-streaming.md#intermediate-display).
Visible paging and scroll-anchor coverage is mapped in
[App Navigation and Chat](app-navigation-and-chat.md#connected-reader-navigation-and-transcript).

1. Outbox, dispatch, replay, bootstrap, and invalidation: `pendingMutationOutbox`, `durableMutationDispatch`, `durableMutationTerminalRejection`, `pendingMutationReplay`, browser `commands`, `bootstrap`, `startupReadiness`, `resourceState`, `resourceInvalidation`, and the startup/recovery browser matrices. These are the core protection against lost, duplicated, or stale user edits.
2. Generation goldens and durable lifecycle: `sendChat.fixtures*`, server `assemble`, `generation.chat`, `durableGeneration`, provider transport/terminal assertions, and the reroll Playwright journey. They protect model-visible context and durable transcripts.
3. Persistence transactions, identity repair, and recovery: command/revision/idempotency/concurrency suites, migrations, lorebook and record identity normalization, backups, save/bundle codecs, asset GC, and Realm atomic staging. These defend user data at rest and through destructive operations.
4. Provider conformance, credentials, and egress: provider request/stream/catalog contracts, dispatch-option parity, stale inline-secret migration, model-profile secret tests, provider operation allowlists, OAuth refresh, SSRF, redaction, and request/body/decompression limits. Regressions here have security impact beyond functional breakage.
5. Memory jobs: repository transitions, embed/summarize handlers, worker fairness/cancellation/shutdown, selection/ranking, browser terminal fences, and prompt-memory fixtures. Partial failures otherwise risk corrupt indexes or permanently active jobs.
6. Performance gates: render/clone probes and server load-cost assertions. They are the only direct defense against accidentally restoring whole-corpus work to common actions.

## Reading the detailed documents

Each feature document lists its primary inventory and groups representative
cases by behavior and the regression protected. Cross-cutting tests may appear
in more than one document—for example, a memory modal in both memory and
character UI. Inventories name files rather than claiming a suite-wide count;
use runner discovery when an exact current count is needed.

## Maintaining focused coverage

Shared algorithm behavior belongs in `packages/shared-core/src/*.test.ts`.
Browser facade tests should cover browser-specific adaptation; pure re-exports
use the consolidated `packages/shared-core/src/ownership.test.ts` dependency
rules. `packages/shared-core/src/importBoundary.test.ts` discovers every shared
runtime module without a manually maintained filename inventory.

UI interaction tests should assert bound state, emitted actions, or saved results
after an event. Reading back a DOM value assigned by the test does not prove the
application handled it. Keep explicit input/output fixtures; avoid copying the
implementation when those expected values already provide the oracle.

Repository-wide documentation and architecture validation belong to `check:docs`
and `check:server`, reached by both aggregates. Validator unit tests focus on
small valid/invalid fixtures and distinct policy assertions. Compatibility
governance unit tests construct valid in-memory fixtures for mutation checks;
`test/compat-harness/run.ts` separately validates committed manifests and digests
in its designated compatibility lane.
