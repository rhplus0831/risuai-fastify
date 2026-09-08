# Testing And Operations

Last audited: 2026-09-03.
Targeted source check: 2026-09-08 (diagnostic helpers, focused browser proof, and aggregate ownership).

Use `pnpm` for package scripts. Node.js is declared as `>=24.0.0`. The package
is root-only; there is no `server/fastify/package.json`. `package.json` pins
`pnpm@11.23.0`, and the lockfile is pnpm lockfile v9. Local servers, tracing,
startup telemetry/measurement, built-SPA serving, browser support, and runtime
environment variables live in
[Development And Observability](development-and-observability.md).

## Scripts

| Command                            | Purpose                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                         | Start Vite client dev server on `0.0.0.0:5174`.                                                                                                                                            |
| `pnpm dev:agent`                   | Start full-stack agent dev server: frontend `6418`, Fastify `6419`, trace mode `agent`, auth/RisuRealm-terms bypass, and disposable `data-agent/` sandbox defaults.                        |
| `pnpm dev:human`                   | Start Tailscale-bound full-stack human trace server: frontend `6002`, Fastify `6001`, trace mode `human`, password auth enabled and RisuRealm terms bypassed by default unless overridden. |
| `pnpm api:dev`                     | Start Fastify with `tsx watch server/fastify/src/index.ts`.                                                                                                                                |
| `pnpm api:dev:flag`                | Start Fastify through `util/api-flag-dev.ts`; restarts only when `.risu-api-restart` is touched/created.                                                                                   |
| `pnpm api:start`                   | Start Fastify once with `tsx server/fastify/src/index.ts`.                                                                                                                                 |
| `pnpm build`                       | Vite build with sourcemaps.                                                                                                                                                                |
| `pnpm report:bundle-boundaries`    | Validate the generated entry/static closure against protected optional/database/export boundaries and write JSON/text reports.                                                             |
| `pnpm report:initial-preload`      | Measure JavaScript referenced by built `index.html`, enforce the ratified total/largest-file budgets, and write JSON/text reports.                                                         |
| `pnpm build:initial-preload`       | Production build with the boundary plugin, followed by both boundary and initial-preload reports.                                                                                          |
| `pnpm measure:fast-bootstrap`      | Run the initial-preload build/report, browser-smoke build, and small/large cold/warm startup matrix.                                                                                       |
| `pnpm verify:fast-bootstrap`       | Run the complete measurement command and the direct-link, replay, event-gap, writer-takeover, observer, and optional-runtime browser matrix.                                               |
| `pnpm preview`                     | Vite preview server for a built client bundle.                                                                                                                                             |
| `pnpm check`                       | Run `svelte-check --tsconfig ./tsconfig.json`.                                                                                                                                             |
| `pnpm check:docs`                  | Validate the current documentation set: local Markdown targets/anchors, focused-index completeness, and unambiguous literal repository paths.                                              |
| `pnpm check:server`                | Check protocol/shared-core types and architecture inventories, then typecheck strict Fastify and Playwright browser-smoke projects concurrently without emitting code.                     |
| `pnpm test -- <file>`              | Agent-facing focused runner. Requires exactly one repository test or source file, routes it to the owning runtime, and uses related-test discovery for source files.                       |
| `pnpm validate:compat-registers`   | Validate the compatibility inventory/findings schemas, cross-register references, and pinned upstream commit coverage.                                                                     |
| `pnpm test:compat-harness`         | Compare pinned local/Fastify generation matrices against a prepared pre-Fastify worktree; opt-in and not part of `test:all`.                                                               |
| `pnpm prepare:compat-baseline`     | Create or verify the exact detached compatibility-baseline worktree and install its frozen dependencies.                                                                                   |
| `pnpm test:agent`                  | Agent-final aggregate for typechecks, current docs, topology, ordinary frontend/server tests, and the browser-smoke build; excludes the specialized full-quality lanes.                    |
| `pnpm test:all`                    | User-owned full local aggregate for format, typechecks, current docs, topology, frontend/server tests, compatibility, coverage, scale, performance, and browser smoke.                     |
| `pnpm coverage:ui-map`             | Run the focused UI coverage gate and write text/JSON reports to `coverage/ui-map`; use `coverage:ui-map:html` for an on-demand HTML report.                                                |
| `pnpm smoke:fastify-browser`       | User/CI command that builds the smoke client without production sourcemaps, then runs the full Playwright Fastify browser smoke suite.                                                     |
| `pnpm analyze:db <path>`           | Analyze `.risu`, JSON, raw database JSON, or data dirs containing `db.json`; SQLite sidecars are copied when present. Add `--json` for machine-readable output.                            |
| `pnpm ts:agent <command>`          | Run the tsserver-backed agent debugging wrapper for navigation, diagnostics, symbols, code actions, imports, and renames.                                                                  |
| `pnpm format`, `pnpm format:check` | Prettier write/check.                                                                                                                                                                      |
| `pnpm coverage:frontend`           | Run root/browser Vitest tests with broad frontend coverage under `coverage/frontend`.                                                                                                      |
| `pnpm coverage:backend`            | Run Fastify/server Vitest tests with broad backend coverage under `coverage/backend`.                                                                                                      |
| `pnpm coverage:all`                | Run frontend and backend coverage, preserving a failing exit code if either side fails.                                                                                                    |

There is no ESLint config or `lint` script.

Remote diagnostics operator tools are `pnpm diagnostics:credential` for local
mint/rotate/revoke and `pnpm diagnostics:remote` for fixed-origin verified HTTPS
reads. Setup and rollback live in
[Remote Support Diagnostics](development-and-observability.md#remote-support-diagnostics).
Focused diagnostics suites cover exact schemas, separate authority, journal
limits/restarts, generation/provider/recovery evidence, and browser publishing.
`server/fastify/browser-smoke/remoteDiagnostics.spec.ts` is the focused real
browser/auth/upload/HTTPS-helper journey; it uses a fresh disposable database
and temporary test CA. Run it through the focused test runner after a smoke
build. The agent aggregate builds the smoke client but does not run Playwright.

## Tests And Checks

Read by task: [focused execution](#focused-execution),
[compatibility](#compatibility-harness), [aggregate scheduling](#aggregate-scheduling),
[runtime classification](#frontend-runtime-classification),
[coverage](#coverage-and-browser-smoke), [test helpers](#fixtures-and-specialized-helpers).

| Area                        | Command/config                                                                               | Environment                      | Locations                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Browser/client/domain tests | `pnpm test -- <file>`, `vitest*.config.ts`                                                   | Node + Svelte/Node + `happy-dom` | One exact test, or tests related to one source file, outside the server tree.                                                    |
| Agent-final aggregate       | `pnpm test:agent`, `util/test-agent.ts`, `util/test-all.ts`                                  | Node + Svelte/Node + `happy-dom` | Core typechecks, current docs, topology, all ordinary frontend/server tests, and a Vite browser-smoke build without Playwright.  |
| Current documentation       | `pnpm check:docs`, `util/current-documentation-validator.ts`                                 | Node filesystem                  | Both aggregates and CI validate current guides, three focused indexes, local links/anchors, and literal repository paths.        |
| Test topology               | `util/test-topology.ts`, `vitest*.config.ts`, `server/fastify/vitest.config.ts`              | Static Vitest discovery          | Agent/user/CI aggregate owner; validates every tracked test exactly once in its configured project.                              |
| Specialized frontend gates  | `vitest.performance-tests.ts`, `vitest.config.ts`                                            | Node + `happy-dom`               | Exact performance owners; isolated in `test:all`/CI, or individually selectable through the focused runner.                      |
| Focused UI audit tests      | `pnpm test -- <audit-test-file>`, `vitest.config.ts`                                         | Node + `happy-dom`               | One exact `src/lib/_audit/**/*.test.ts` file; both aggregates include the complete audit set.                                    |
| Full frontend tests         | `pnpm test:agent`, `pnpm test:all`, CI, `vitest.config.ts`                                   | Node + Svelte/Node + `happy-dom` | Agent profile owns the ordinary suite; user/CI additionally own explicit performance and coverage gates.                         |
| Frontend coverage           | `pnpm coverage:frontend`, `vitest.config.ts`                                                 | Node + Svelte/Node + `happy-dom` | Broad coverage over `src/**/*.{ts,svelte}` and `util/**/*.ts`; reports under `coverage/frontend`.                                |
| UI coverage map             | `pnpm coverage:ui-map`, `vitest.config.ts`                                                   | Node + `happy-dom`               | Six focused tests mapped over `src/lib/ChatScreens`, `src/lib/Others`, `src/lib/SideBars`, and `src/ts/server`.                  |
| Fastify/server tests        | `pnpm test -- <file>`, `pnpm test:agent`, `pnpm test:all`, `server/fastify/vitest.config.ts` | Node                             | Focused feedback or the complete `server/fastify/__tests__/**/*.test.ts` suite; the direct Realm scale case remains specialized. |
| Realm import scale gate     | `pnpm test:all`, CI, `server/fastify/vitest.config.ts`                                       | Node                             | The direct-only 7,000-display-asset Realm/CharX import case; isolated in the user/CI aggregate.                                  |
| Compatibility harness       | `pnpm test:all`, `pnpm test:compat-harness`, `test/compat-harness/*.vitest.config.ts`        | Node                             | User/CI current goldens plus the separately governed full pinned differential.                                                   |
| Backend coverage            | `pnpm coverage:backend`, `server/fastify/vitest.config.ts`                                   | Node                             | Broad coverage over `server/fastify/src/**/*.ts`; reports under `coverage/backend`.                                              |
| Browser smoke               | `pnpm test -- <spec-file>`; full suite via user/CI                                           | Chromium                         | One exact spec through the focused runner, or all specs through the user/CI aggregate.                                           |

### Focused Execution

The agent-facing runner accepts exactly one existing repository file and rejects
directories, globs, runner flags, external paths, and test-runner configuration.
Exact frontend and server tests use their configured runtime. Frontend/server
source uses Vitest related-test discovery; shared protocol/core source queries
both projects. Exact performance tests retain one-worker isolation. Exact
browser-smoke specs build the smoke client and run only the selected spec.
Compatibility-isolated tests remain user-owned.

Agents use the focused command only for a concrete diagnostic need while work
is in progress. Once implementation is complete, `pnpm test:agent` runs the
core broad checks, current-document validator, ordinary frontend/server suites,
and smoke build. It does not
run repository-wide formatting, coverage instrumentation, compatibility and
Realm scale gates, explicit performance probes, or Playwright. The user and CI
retain those lanes through `pnpm test:all` and the split Quality workflow. On a
fresh machine, the user/CI smoke owner runs
`pnpm exec playwright install --with-deps chromium` before browser smoke.
`server/fastify/__tests__/README.md` is the maintained topical map for the flat
Fastify test directory; use it to find command/persistence, generation, memory,
provider, job, asset/import, and platform/route coverage.

### Compatibility Harness

Register validation and the current compatibility harness are ordinary
`test:all`/CI owners. The current harness validates current-stack and cluster
goldens without external prerequisites. The full compatibility harness additionally
requires the pinned baseline worktree and its dependencies prepared by
`pnpm prepare:compat-baseline`; it remains outside `pnpm test:all` because that
external worktree is not a normal checkout prerequisite. Tests that read the
pinned worktree are excluded from the ordinary frontend projects and run only
through the full compatibility harness. The preparer defaults to the sibling
`../risu-baseline-71c476e9c` path; set
`RISU_COMPAT_BASELINE_ROOT` to an absolute path when a runner needs another
location. Preparation and harness execution resolve the same override.

Compatibility fixtures and goldens are evidence, not permission to change
behavior. Run the full harness normally first and review its retained semantic
artifacts. For an intentional adjudicated change, use
`pnpm test:compat-harness -- --update-goldens --reason "<review reason>"`; the
full pinned lane and a nontrivial reason are mandatory, and current-only runs
cannot update goldens. The command refreshes the tracked
`test/compat-harness/golden/{baseline,current,diff,cluster10}.json` files and
their digest manifest only after governance validation passes.

Review all four golden artifacts together. The computed `diff.json` is checked
against `test/compat-harness/expected-differences.json`, whose cell/aspect
digests, rationale, signed decision IDs, and inventory IDs are validated against
the compatibility registers. A new, removed, or changed divergence fails until
that mapping is adjudicated. A normalizer change also needs focused positive and
negative cases showing that meaningful request, execution, or transcript
differences remain visible.

Compatibility fixture provenance is tracked in
`test/compat-harness/fixture-provenance.json`. The harness validates its pinned
baseline commit, ordered cases, normalization contract, source paths, and source
digests on every run; the governed full update command refreshes those source
digests before writing the golden manifest. There is no separate compatibility
fixture-update environment switch.

Each harness run writes `actual-*.json` under the ignored
`fast-bootstrap-results/compat-harness/` directory. Compare those files with the
tracked goldens and classify a failure as baseline preparation, provenance or
governance validation, unexpected current behavior, or an intentional
expected-difference change before updating anything. PR/main current-harness
failures upload available diagnostics for 14 days. The scheduled/manual full
workflow always uploads the preparation/run logs that were produced, actual
artifacts, tracked comparison goldens and manifest, expected-difference map, and
fixture provenance for 14 days. If a review outlives that window, preserve the
relevant diff and rationale in the tracked change rather than relying on an
expiring workflow artifact.

`pnpm test:all` owns register validation and current compatibility, but not the
full pinned differential. A focused or aggregate pass therefore does not replace
a full differential when the harness/baseline itself changes or when
compatibility risk calls for baseline comparison. The user owns that decision
and reviews the scheduled/manual differential.

### Aggregate Scheduling

`pnpm test:agent` uses the same bounded scheduler and failure aggregation as
`test:all`. It runs `check:server`, current-document validation, topology, the
frontend suite with the six UI sentinel files restored as ordinary
uninstrumented tests, `pnpm check`, the isolated server suite, and an isolated
`build:smoke`. It explicitly disables the
two frontend performance probes and does not launch Playwright. The smoke build
waits for `check:server`; every selected lane still finishes after another lane
fails. `RISU_TEST_ALL_JOBS`, `--jobs`, `--dry-run`, and `--timings=json` work for
both commands.

`pnpm test:all` runs up to two ordinary lanes concurrently by default and
preserves any failure in the final aggregate result. Set
`RISU_TEST_ALL_JOBS` or pass `--jobs <count>` to tune that outer limit, and use
`--dry-run` to inspect the lane graph. Its topology lane validates discovery
before the ordinary frontend lane starts. Browser smoke runs outside that pool and
waits for `check:server` because declaration checking and the smoke build both
use `dist/`; its stateful tests remain serial within each spec, while local runs
use 75% of available CPUs up to four workers. Set
`RISU_BROWSER_SMOKE_WORKERS=<count>` for an explicit local or CI override; CI
defaults to one worker. The direct-link owner is the narrow exception to
file-serial execution: it divides the manifest-derived routes into four
independent Playwright batches with separate Fastify/data/browser contexts. The focused UI coverage lane waits
for the ordinary frontend lane and owns its six sentinel files during `test:all`, so the
ordinary frontend subprocess does not execute them twice. The render/clone
performance gates run with one Vitest worker and no file parallelism. The
Fastify/server lane also runs outside the concurrent pool because it contains
deadline and load-cost assertions. These isolated phases keep concurrent load
from invalidating timing checks. Every lane still runs when another lane fails,
and the aggregate exits nonzero at the end.
Pass `--timings=json` to append a schema-versioned JSON record containing the
aggregate duration, configured job limit, and each lane's elapsed time plus
start/finish offsets, dependency metadata, isolation flag, and exit code. This
is observational only and is intended to expose the real critical path before
changing concurrency or isolation.

### Frontend Runtime Classification

Config details: `vitest.config.ts` composes three isolated thread-pool projects,
and `vitest.frontend-routing.ts` owns their disjoint filename/registration
contract. Plain `*.test.ts` files default to Node; `*.svelte-node.test.ts` uses
client-mode Svelte transformation against Node globals; `.svelte.test.ts` and
`.dom.test.ts` use Svelte/Happy-DOM. The DOM project also explicitly includes
the reviewed pre-suffix owners in `legacyDomTestFiles` in
`vitest.frontend-routing.ts`. That maintained list, not a snapshot count in this
guide, owns the exceptions. Unclassified tests default to Node; there is no
implicit DOM fallback. The Svelte+Node custom environment
delegates to Vitest's Node setup while selecting Vite's client transform so
`$effect` retains client semantics.

The user/CI topology utility (`pnpm exec tsx util/test-topology.ts`) asks Vitest
for static file discovery in four modes:
ordinary frontend, explicit performance gates, UI-map exclusion, and Fastify
server. It compares those results with tracked `*.test.ts` files and the
frontend routing function, rejecting missing, duplicate, unexpected, or
misrouted tests without executing their bodies. The aggregate and CI retain
final behavioral certification for runner/config changes.

All three projects retain browser resolve conditions, the `src` alias, and
`vitest.setup.ts` to install the shared production `safeStructuredClone` helper
and establish an explicit all-ready startup baseline. Real KaTeX remains
available to parser tests; behavior libraries require scoped, faithful mocks
when a test needs isolation. Only the two Svelte projects load the Svelte plugin,
and only the DOM project loads `vitest.dom.setup.ts`. That DOM-only setup blocks
unexpected fetches resolving to loopback port `3000` and reports the originating stack;
tests that perform network-shaped work must stub `fetch` explicitly and await
fire-and-forget command drains before teardown. `vitest.setup.test.ts` protects
the shared native, fallback, global-restoration, and exact post-startup
capability semantics, while
`vitest.fetchGuard.test.ts` protects the DOM fetch boundary. Root Vitest excludes
explicit performance gate tests unless
`RISU_TEST_INCLUDE_GATES=true` is set. `test:all` also sets
`RISU_TEST_EXCLUDE_UI_MAP=true` only for its ordinary frontend subprocess; the
following coverage lane executes those same six files once with instrumentation
and thresholds. The user/CI performance and broad-coverage lanes set
`RISU_TEST_INCLUDE_GATES=true`; an exact focused performance test does the same
while retaining one-worker isolation. `test:agent` instead forces
`RISU_TEST_EXCLUDE_UI_MAP=false` and
`RISU_TEST_INCLUDE_GATES=false`, so inherited shell variables cannot remove the
six UI tests or pull the resource-sensitive performance probes into the ordinary
frontend run. Server Vitest uses Node, forks, a 15s
test timeout, and
sets `RISU_DIRECT_REALM_IMPORT_TEST` only when the Realm import test is directly
selected. Playwright smoke keeps tests within each file serial except for the
explicitly parallel direct-link batches. Local workers use 75% of
available CPUs capped at four, CI stays at one by default, and
`RISU_BROWSER_SMOKE_WORKERS` overrides either choice. It retains Chromium traces
on failure and rejects focused tests when CI is truthy.
The frontend and server Vitest configs set `allowOnly: false`. Directly selecting
`realmImport.test.ts` enables its otherwise skipped 7,000-asset stress case.
`test:all` and CI own that selection as an isolated single-worker gate. A user
may also select the exact file through the focused runner.

### Coverage And Browser Smoke

`pnpm coverage:frontend` and `pnpm coverage:backend` are broad coverage views for
reporting and enforce no thresholds. `pnpm coverage:all` runs both sides and still executes backend
coverage when frontend tests fail, then exits non-zero if either side failed.

`pnpm coverage:ui-map` is the focused UI state coverage gate included in
`pnpm test:all`. It uses `@vitest/coverage-v8`, runs the focused ChatScreens,
Others, and SideBars UI test files, enforces line `8%`, statement `7%`, function
`5%`, and branch `4%` thresholds, and emits `text` and `json-summary` reports
under `coverage/ui-map`. Its denominator excludes the exact test-only UI hosts,
stubs, and harnesses listed in `vitest.ui-coverage-tests.ts`. `pnpm coverage:ui-map:html`
additionally emits HTML on demand. The repository ignores `coverage/`; keep all
coverage reports local unless a plan slice explicitly asks for extracted
results.

Browser smoke also owns tracked desktop/mobile screenshot baselines under
`server/fastify/browser-smoke/*-snapshots/`. The core-chat and blocking-alert
assertions are part of the user/CI browser-smoke suite, so update those PNGs only
for an intentional visible change.

Smoke mode keeps the built SPA, resource/command protocol, Fastify, SQLite, and
Chromium journeys real, but makes selected surroundings deterministic. It uses
test auth and observer controls, shortens a finalization refresh, and disables
unrelated provider, worker, and asset-GC activity. Treat its assertions as
cross-layer startup, recovery, navigation, command, and durability evidence;
they do not prove the live auth UI, external providers, production refresh
timing, memory workers, or asset garbage collection.

Ordinary `fastBootstrapHarness.ts` fixtures import through the real authenticated
API before any writer is registered. Bootstrap and, when the data directory is
available, SQLite must report a null writer and epoch zero both before and after
import. This lets the first browser exercise normal initial acquisition.
Explicit `writer-import`, `unowned-migration`, and `empty` modes retain their
owned, legacy-normalization, and genuine first-run purposes. Seeding cannot
reset ownership after a browser has acquired it. Shared accepted-send cases use
**Use this device** when a preceding case still owns the fixture; reload and
restart inside a case retain the current session's recovery path.

### Fixtures And Specialized Helpers

Shared-core import/export/compatibility ownership is consolidated in
`packages/shared-core/src/ownership.test.ts`, with its consumer rules in
`util/test-support/shared-core-ownership.ts`. Use
`packages/shared-core/src/importBoundary.test.ts` for dependency boundaries;
behavior tests remain beside each shared algorithm. Do not recreate retired
per-module `*Ownership.test.ts` files to add a consumer assertion. See the
[shared-core guide](../../packages/shared-core/README.md#focused-checks).

Prompt/generation fixtures live in `src/ts/process/__fixtures__/`; review any
expected fixture change with its owning tests. Server `.risu` fixture helpers
live in `server/fastify/__fixtures__/risuSave/`. Explicit performance gates live
in `src/ts/__tests__/`, while cross-cutting UI audit probes live in
`src/lib/_audit/` and run in the ordinary frontend lane. Keep those specialized
probes in their current locations instead of mixing them into feature folders.
Fastify suites that need an assembled read-after-write snapshot call
`injectComposedResourceDatabase` explicitly. The helper composes settings,
collections, and character resources for the requesting test only; it does not
patch production bootstrap behavior. Production `/api/v1/bootstrap` remains
runtime-only and has no legacy `database` property. New tests should use the
narrow resource reader unless composed state is the behavior under test.
Communication-cost regressions stay in the normal frontend/server lanes rather
than a separate package script. The server lane owns the large-corpus and
mutation-shape checks in `serverLoadCostHarness.test.ts`,
`commandMutationReadNarrowing.test.ts`, `commandSingleRowPaths.test.ts`,
`commandSettingsAndPluginStorageRange.test.ts`, and
`commandMessageFreeCeiling.test.ts`.

## Visible State Test Contract

This is policy guidance for choosing current Fastify tests, not a new gate. When
a change affects state the user can see, the rendered DOM is the primary oracle:
assert it after the same transition that changes state, or after the initial
render when state is seeded before mount. Prefer user-observable roles, names,
text, selection, and enabled/pressed state over component internals or source
text. Helper/state assertions, command payload assertions, store reads, and fetch
mocks can support classification, but they are not enough for stale-visible-UI
bugs. If behavior includes optimistic updates or rollback, assert both the
visible optimistic change and the visible rollback after settlement.

Use helper Vitest for pure helpers and resource-invalidation calculations,
Svelte DOM Vitest for state-to-DOM contracts, and sparse Fastify browser smoke
for end-to-end boot/API/SSE wiring. Add state-to-DOM coverage when touching
resource slice state, `selectedCharID`, `chatPage`, startup readiness,
authoritative resource applies, bootstrap/refresh/SSE, optimistic command
helpers, bridge
watchers, router selection, array create/delete/reorder flows, `$derived`,
`$effect`, keyed lists, memo signatures, or render dependency keys.

The mounted audit probe `src/lib/_audit/optimisticTogglePaint.dom.test.ts`
asserts optimistic and grouped toggle rendering before using stores as
classification aids. It runs in the ordinary frontend lane and both aggregates;
`pnpm test -- src/lib/_audit/optimisticTogglePaint.dom.test.ts` selects that file
for focused debugging. Use the same DOM-first pattern in
feature-owned component tests; reserve a new audit probe for a cross-cutting
invariant that benefits from a dedicated audit location.

Browser-smoke contracts protect reload/reconciliation behavior:
`server/fastify/browser-smoke/visibleStateRecovery.spec.ts` covers chat-switch
repainting of the active generation preset, sidebar-toggle survival through
command/resource reconciliation, and route/sidebar continuity after an
old-lineage recovery reload.
`server/fastify/browser-smoke/rerollSwipePersistence.spec.ts` proves persisted
reroll alternates reconstruct after reload and remain candidate-recoverable. It
clicks the real message reroll control, observes the operation request and absence
of truncation, then invokes the production candidate-navigation helper after
reload. Pointer-swipe controls are outside that final recovery assertion.
`server/fastify/browser-smoke/acceptedSendProtocol.spec.ts` drives the normal
composer through incremental output, completion and a full completed reload,
checking exact user/reply/operation identities and one provider invocation.

`server/fastify/browser-smoke/bardWikiLifecycle.spec.ts` protects the visible
BardWiki settings and provider-cost warning, active-chat workspace, manual
document creation, explicit current-turn confirmation/job state, lifecycle and
vault warnings, and persistence through reload. Repository/route/component
tests retain the destructive, conflict, restart, and privacy edge cases that do
not belong in a browser journey.

## TypeScript And Formatting

- Root `tsconfig.json` is browser-oriented, `strict: false`, allows JS, and uses
  bundler resolution.
- `packages/protocol/tsconfig.json` strictly checks the browser-safe shared wire
  schemas. `pnpm check:protocol` runs it directly and `pnpm check:server` includes
  it before the shared-core and downstream checks.
- `packages/shared-core/tsconfig.json` strictly checks framework-neutral shared
  runtime behavior. The architecture inventory then rejects browser-application
  imports and stale project references before downstream typechecks begin.
- `tsconfig.node.json` covers `vite.config.ts`.
- `server/fastify/tsconfig.json` is strict and `noEmit: true`; it has no browser
  project reference or generated-declaration prerequisite.
- `tsconfig.browser-smoke.json` typechecks Playwright config/spec/helper sources
  in the same `pnpm check:server` lane. After protocol, shared-core, and
  architecture prerequisites pass, the Fastify and browser-smoke checks run
  concurrently.
- Prettier uses `prettier-plugin-svelte`, no semicolons, single quotes, and
  print width 120.
- `.prettierignore` excludes Markdown docs, `docs/`, archived docs, and agent
  handoff notes. `pnpm format` will not normalize these files, so keep docs
  tables and wrapping tidy by inspection.

Server TypeScript check workflow:

```sh
pnpm check:server
```

Re-run the client-lib build after client source/type changes that affect server
imports. Protocol package changes are source-exported and checked through both
the dedicated protocol project and their client/server consumers.

Agent TypeScript navigation wrapper:

```sh
pnpm ts:agent hover server/fastify/src/app.ts:87:23
pnpm ts:agent definition server/fastify/src/index.ts:134:37
pnpm ts:agent references server/fastify/src/app.ts:87:23 --include-declaration
pnpm ts:agent diagnostics server/fastify/src/app.ts
pnpm ts:agent diagnostics --project server/fastify/tsconfig.json
pnpm ts:agent symbols server/fastify/src/app.ts
pnpm ts:agent workspace-symbols buildApp --project server/fastify/tsconfig.json
pnpm ts:agent code-actions server/fastify/src/app.ts:87:23
pnpm ts:agent organize-imports server/fastify/src/app.ts
pnpm ts:agent project-files --project server/fastify/tsconfig.json
pnpm ts:agent rename-preview server/fastify/src/index.ts:45:17 nextSignalExitCode
```

Locations use 1-based `file:line:character` coordinates. The wrapper returns
JSON so agents can chain the safer loop `references -> diagnostics ->
rename-preview -> rename-apply -> diagnostics`. `rename-apply` and
`organize-imports --write` modify files, so inspect `git diff` after using them.
Use `pnpm ts:agent --help` as the canonical command/flag list. Useful global
flags include `--project`, `--absolute`, `--compact`, and `--timeout-ms`. Set
`RISU_TS_AGENT_TSSERVER_LOG=1` to capture a verbose tsserver log at
`data/trace/tsserver-agent.log` when debugging the wrapper itself.

## CI And Deployment

`.github/workflows/quality.yml` runs for pull requests and pushes to `main` with
Node 24 and the exact pnpm version declared by `packageManager` in
`package.json`. Formatting, both typecheck lanes, current-document validation,
frontend tests (including UI audit probes), focused UI coverage, isolated
performance gates, compatibility register validation, current compatibility,
server tests, and serial browser smoke run as separate jobs; only the smoke job
installs Chromium. Current
compatibility waits for register validation, and both results are required by
the final `verify` aggregate. The ordinary frontend job always omits the six
sentinel files because the unconditional coverage job executes them once with
the same assertions and additional thresholds, then uploads its report.
Playwright failure traces/results are also uploaded. The final `verify` job
preserves the aggregate pass/fail contract while allowing independent lanes to
finish after another lane fails. Local `pnpm test:all` has the same test
ownership with bounded concurrency and isolated load-sensitive phases; CI
additionally runs the initial-preload build/report lane.

`.github/workflows/compatibility-differential.yml` runs the full pinned
differential nightly at 06:00 UTC and on manual dispatch. It fetches full Git
history, prepares and rechecks the exact detached baseline, and runs
`pnpm test:compat-harness` with read-only repository permissions, one shared
non-cancelling concurrency group, and a 60-minute job timeout. Its retained
artifact is the first triage source described above; preparation and harness
failures still reach the `if: always()` upload step.

The container path (`Dockerfile`, `docker-compose.yml`, `.dockerignore`) was
removed on 2026-07-22; the project does not currently ship a Docker image, and
running from source is the only supported deployment. There is no separate
release workflow or packaged release channel in this repository. Consequently,
the `main` Quality result plus a successful full differential for the candidate
commit are the release-equivalent gates for source builds. The scheduled run
usually supplies the full evidence for `main`; manually dispatch it at the
candidate ref when the scheduled result does not cover that exact commit.
