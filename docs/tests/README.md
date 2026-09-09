# Test Suite Guide

Last audited: 2026-09-03.

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

The canonical command inventory and lane semantics are in
[Testing And Operations](../structure/testing-and-operations.md#scripts).

| Goal                                            | Command                                                    |
| ----------------------------------------------- | ---------------------------------------------------------- |
| Agent-focused test or related-source feedback   | `pnpm test -- <one-test-or-source-file>`                   |
| Current documentation links, indexes, and paths | `pnpm check:docs`                                          |
| Completed agent-development verification        | `pnpm test:agent`                                          |
| User-owned full local quality aggregate         | `pnpm test:all`                                            |
| Full pinned compatibility differential          | `pnpm prepare:compat-baseline && pnpm test:compat-harness` |
| Startup and bundle verification                 | `pnpm verify:fast-bootstrap`                               |

During implementation, agents use the focused command only when it answers a
concrete question. It accepts exactly one repository file, rejects directories,
globs, and arbitrary runner flags, runs exact tests in their owning runtime, and
uses Vitest related-test discovery for source files. Shared protocol/core
sources query both frontend and server projects. A selected browser-smoke spec
performs its required build and runs only that spec.

After implementation is complete, agents run `pnpm test:agent` once. It owns
the core typechecks, current-document validation, topology, ordinary
frontend/server suites, and smoke build. The user and CI retain the full
formatting, coverage, compatibility, scale, performance, and Playwright
aggregate through `pnpm test:all`.

### Compatibility evidence ownership

Compatibility register validation and the current-stack/cluster golden harness
run in `pnpm test:all` and as required PR/`main` Quality jobs. The full pinned
baseline differential is intentionally separate: GitHub Actions runs it every
night at 06:00 UTC and on manual dispatch. Baseline-source comparison tests are
routed only through that full pinned lane, so focused tests do not require an
external worktree. Agents do not launch either compatibility harness; the user
reviews the scheduled/manual evidence.
`pnpm prepare:compat-baseline` uses the repository sibling
`../risu-baseline-71c476e9c` by default; `RISU_COMPAT_BASELINE_ROOT` accepts an
absolute override for CI or another checkout layout.

Do not accept a fixture or golden change by regeneration alone. Run the full
pinned harness normally first and inspect the retained semantic artifacts. Once
the change is intentional and adjudicated, refresh goldens with
`pnpm test:compat-harness -- --update-goldens --reason "<review reason>"`. The
governed command requires the full lane and a nontrivial reason; current-only
runs cannot update goldens.

Review `baseline.json`, `current.json`, `diff.json`, and `cluster10.json`
together. The separate `expected-differences.json` maps each accepted divergent
cell/aspect digest to rationale plus signed decision and inventory IDs; the
harness validates the map against the computed diff and compatibility
registers. Normalizer edits also need positive and negative cases showing that
behaviorally meaningful distinctions are not erased.

Compatibility fixture provenance is tracked in `fixture-provenance.json` and
validated on every harness run, including the pinned baseline, exact ordered
case set, normalization contract, and source-file digests. The governed full
update refreshes those digests and the golden manifest. There is no separate
compatibility fixture-update environment switch.

For local failures, inspect ignored
`fast-bootstrap-results/compat-harness/actual-*.json`. In CI, current-harness
failures upload available mismatch diagnostics, and every scheduled/manual full
run uploads the preparation/run logs that were produced, actual artifacts,
tracked goldens/manifest, expected-difference map, and fixture provenance. Both
artifact classes are retained for 14 days. Triage baseline preparation and
governance/provenance validation separately from request, execution, and
persisted-transcript differences; only refresh tracked expectations after
classifying the change as intentional. Keep the durable explanation in the
reviewed change because CI artifacts expire.

This repository has no separate release workflow or packaged release channel;
source builds use the `main` Quality aggregate and a successful full pinned
differential for the candidate commit as release-equivalent gates. Use the
scheduled full run when it covers the exact `main` commit, or manually dispatch
the workflow at the candidate ref.

### Frontend capability classification

| Class | File ownership                                                         | Runtime                                      | Use and retention rule                                                                                                                                                              |
| ----- | ---------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N     | Plain `*.test.ts` by default                                           | Node                                         | Pure TypeScript/JavaScript and injected fakes with no required Svelte client transform or browser behavior.                                                                         |
| S     | `*.svelte-node.test.ts`                                                | Svelte client transform with Node globals    | Svelte modules or runes whose behavior does not require DOM globals, mounting, layout, focus, or browser APIs.                                                                      |
| D     | `*.svelte.test.ts`, `*.dom.test.ts`, or a reviewed legacy registration | Svelte plus Happy-DOM                        | Mounted/visible component behavior and browser-shaped contracts, including accessibility, focus, optimistic paint, rollback, real DOM parsing, and transitive eager browser access. |
| B     | Browser-smoke `*.spec.ts`                                              | Built SPA in Chromium against Fastify/SQLite | Cross-layer behavior that requires a real browser, navigation, responsive layout, reload, multi-tab ownership, or durable recovery.                                                 |

All Vitest projects reject focused tests. Pre-suffix DOM files that cannot be
renamed without broad churn are explicitly registered in
`vitest.frontend-routing.ts`; these are probe-backed retainers, not an implicit
fallback. Do not add a registration without execution evidence and a reviewed
reason. Explicit suffixes and legacy registrations determine Svelte+Node and DOM
ownership; other `*.test.ts` files default to Node. Use runner discovery for the
current exact file distribution.

Playwright keeps each spec serial, uses 75% of available local CPUs up to four
file workers (one in CI), retains traces on failure, and sets `forbidOnly` in CI. The normally skipped
7,000-display-asset Realm stress case is enabled by running
`realmImport.test.ts` directly. Broad frontend and backend coverage are
report-only; only the focused UI map has thresholds.

The agent-final `test:agent` command uses the same scheduler but selects only
`check:server`, current-document validation, topology, ordinary frontend tests,
`pnpm check`, isolated server tests, and `build:smoke`. Its frontend subprocess
runs the six UI-map sentinel files without coverage instrumentation and excludes
the two explicit performance probes. It never launches Playwright.

The user-owned `test:all` command defaults to two concurrent outer lanes; override it with
`RISU_TEST_ALL_JOBS=<count>` or `--jobs <count>`, and inspect the schedule with
`--dry-run`. Pass `--timings=json` to append a machine-readable lane schedule
and timing record for critical-path analysis. It waits to build browser smoke
until the independent server typecheck lane has completed. Its ordinary frontend
subprocess omits the six UI-map files, then the coverage lane executes them once
with thresholds after the remaining frontend tests finish. Browser smoke,
server, and performance lanes run outside the outer pool. Smoke uses its own
bounded file-level parallelism; the other isolated lanes contain load-sensitive
checks.

`server/fastify/vitest.config.ts` roots discovery at `server/fastify/` and
includes `__tests__/**/*.test.ts`. `pnpm test -- <file>` selects that config for
server tests and source, while ordinary frontend files use the root three-project
Vitest configuration.

`startupCachePopulationMatrix.spec.ts` keeps small/large and cold/warm startup populations
separate and writes `fast-bootstrap-results/startup-matrix.{json,txt}`.
It captures cold readiness metrics, then observes zero pending optional cache
writes before the warm reload. Startup readiness itself does not wait for those
writes; the test does not flush them or change the measured readiness boundary.
`startupDirectLinks.spec.ts` runs every production route-manifest direct-link
family in four independently isolated batches. `startupRecoveryIntegrationMatrix.spec.ts`
runs role-first startup, response-loss replay, a real
`event_replay_unavailable` recovery, multi-tab denial/takeover/promotion, and
slow/failing optional-runtime Retry. Per-worker partials are merged after the
Playwright run into `fast-bootstrap-results/fast-bootstrap-integration.{json,txt}`, with
current-run IDs, exact scenario/batch/route coverage, and nested result/manifest
validation. Focused partial runs retain diagnostic partials but do not emit a
successful combined report. Required incomplete, malformed, or stale merges fail
and remove prior final outputs. Startup-matrix and locale artifacts belong to
separate producer invocations and are not inputs to this integration merge.
The disposable harness owns a
temporary authenticated Fastify/SQLite instance per journey or direct-link
batch. See
[Development And Observability](../structure/development-and-observability.md#startup-and-bundle-verification)
for fixtures, budgets, artifact interpretation, and request-trace correlation.

## Regression-critical test groups

Intermediate display protocol/cache/route coverage lives in
`packages/protocol/src/displaySource.test.ts`,
`src/ts/server/displaySources.test.ts`,
`server/fastify/__tests__/displaySourceCache.test.ts`, and
`server/fastify/__tests__/displaySources.test.ts`. The existing ChatBody memo,
parser, scripting, Lua, trigger, bounded-regex, bootstrap, route-protection, and
generation suites remain companion parity coverage. The server route cases pin
the per-target ephemeral scriptstate contract: same-target reads see temporary
writes, sibling targets start from the authoritative baseline, and SQLite plus
the response revision remain unchanged. They also cover the production-shaped
ten-trigger singleton-tuple module, scalar-only automatic matching, narrow
active-module validation, and one-entry-per-target handled fallback. The route
test also places the SQL
load-cost harness around cold and warm display batches, allowing only the three
required transform collections while rejecting whole-character, whole-chat,
asset, and unrelated-collection payload scans. Its metric assertions distinguish
the cold misses from warm cache hits and pin the queue/load/fingerprint timing
dimensions.
The browser bridge cases also prove that critical newest-message targets settle
from the same mixed batch before background results complete, and that changing the
visible chat aborts an obsolete fetch before the replacement batch starts.
`chatDisplayScrollStability.spec.ts` holds individual older-row SSE results while
real CDP wheel input continues, then pauses beyond the interaction grace before
releasing unfinished newer rows below the reading position. Animation-frame,
after-frame, and DOM-mutation samples require the same readable anchor node to
remain within one pixel throughout late commits, not only after settlement.
The matrix covers delayed success and handled fallback in bounded and legacy
paging. Coordinator and ChatBody tests also pin explicit initial-commit anchor
preservation after grace expiry without forcing it on ordinary later updates.
Cache cases cover exact-namespace reuse after a context switch, isolation
between namespace identities, least-recent namespace retirement, stale
in-flight completion rejection, and entry/byte bounds aggregated across all
retained namespaces. The route metric case exercises the same A/B/A namespace
sequence through Fastify.

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
