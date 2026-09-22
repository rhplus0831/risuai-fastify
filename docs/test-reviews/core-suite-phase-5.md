# Core suite Phase 5: deletion of the tests outside the core suite

Completed on 2026-09-22. Baseline `1adda76bc` (the Phase 3 result), result
`fastify` at the commit that adds this report. Inputs:
[core-suite-phase-2.md](core-suite-phase-2.md), [core-suite-phase-3.md](core-suite-phase-3.md),
the `TEST-LIST.md` priority snapshot (tiers; now archived under
`.archived-docs/performance-and-stability/test-suite-reduction-2026-09/`), and the owner's audit finding
that the agent-generated tests mostly failed to protect the product. Phase 4,
the gate, was the mutation replay recorded in the Phase 3 report; it is
repeated here on the reduced suite.

No production source changed except one string in
`src/ts/server/browserOperationManifest.ts` (an `owner:` pointer to a deleted
test now names the architecture inventory rule) and `util/architecture-inventory.ts`,
which gained four closed-world checks. Everything else is test files, test
support, test configuration, frozen inventory baselines, CI, and documentation.

## Outcome

| Measure | Before | After |
| --- | ---: | ---: |
| Tracked test files (`*.test.ts`, `*.spec.ts`) | 1,103 | 392 |
| Frontend Vitest lane (files / cases) | 790 / 9,844 | 161 / 1,863 |
| Server Vitest lane (files / cases) | 262 / 4,699 | 192 / 3,771 |
| Browser smoke journeys | 177 | 175 |
| UI coverage gate (files / cases) | 8 / 249 | removed |
| Compatibility cells, performance gates | 18, 6 | 18, 6 |
| Runner-registered cases, all lanes | 14,993 | 5,833 |
| Core contract files (frontend / server / browser) | 24 / 55 / 8 | 24 / 55 / 8 |
| `pnpm test:all` wall time | 9.9 min | 8.3 min |
| Frontend tests lane | 1.65 min | 0.27 min |
| Server tests lane | 0.88 min | 0.76 min |
| Saved production mutations caught by the core lanes | 114 of 115 | 114 of 115 |

The core suite did not change: not one file in `util/core-test-contract.ts`
was edited, and no helper, fixture, or golden that a core file reads was
removed. The survivor in the mutation gate is D1 from Phase 2, an equivalent
mutation (`node:sqlite` enables foreign keys by default).

## What was removed

| Batch | Files in list | Deleted | Kept | Support files removed | Rules ported |
| --- | ---: | ---: | ---: | ---: | ---: |
| structural | 159 | 81 | 78 | 1 | 4 |
| src-lib | 207 | 207 | 0 | 57 | 0 |
| src-ts-runtime | 149 | 132 | 17 | 1 | 0 |
| src-ts-shell | 139 | 105 | 34 | 0 | 0 |
| src-ts-process | 147 | 137 | 10 | 96 | 0 |
| server | 215 | 49 | 166 | 0 | 0 |
| **Total** | **1,016** | **711** | **305** | **155** | **4** |

The support column counts helpers, harnesses, and fixtures the batches listed;
`git` counts 156 deleted non-test files including `vitest.ui-coverage-tests.ts`.

Reasons, as the batch agents classified each deleted file (registered cases
are the static `it` count at the baseline):

| Reason | Files | Registered cases |
| --- | ---: | ---: |
| src-lib policy (every `src/lib` component test) | 212 | 1,849 |
| own-module mock (`vi.mock` of `src/`, `server/`, `packages/`) | 193 | 3,576 |
| Medium tier client file, not a pure-function fixture test | 113 | 733 |
| Low tier | 72 | 431 |
| structural, source-text, ownership, allowlist guard | 40 | 145 |
| redundant with a named core case | 36 | 559 |
| implementation-coupled assertions | 31 | 253 |
| tooling test that gates nothing | 14 | 85 |

By snapshot tier: Critical 93 deleted / 65 kept, High 189 / 127, Medium
262 / 106, Low 111 / 7, unlisted (added after the snapshot) 56 / 0.

Also removed: the UI coverage gate (`coverage:ui-map` scripts,
`vitest.ui-coverage-tests.ts`, the `ui-coverage` lane and CI job, the
`RISU_TEST_EXCLUDE_UI_MAP` routing), the `check:shared-core:boundary` script
and `util/test-support/shared-core-ownership.ts`, 57 `src/lib` test harness
and stub components, 96 `src/ts/process/__fixtures__` corpus files no
surviving test loads, and the two isolated Phase 9 compatibility suites.

## What stays outside the core suite

305 files remain as the extended tier. They run in `pnpm test:all` and CI,
not in `pnpm test:agent`.

| Keep reason | Files | Where |
| --- | ---: | --- |
| Real boundary, behavioural assertions, no own-module mocks | 168 | 137 Fastify-over-SQLite files, 31 client files |
| Pure-function fixture tests, no mocks | 94 | 71 in `packages/`, 23 in `src/ts` |
| Non-core browser-smoke journeys | 29 | `server/fastify/browser-smoke` |
| Gate tooling with in-memory fixtures | 9 | `util/*.test.ts`, the two performance gates |
| Pinned by the compatibility baseline | 5 | four server files, `src/ts/model/modelProfileRecords.test.ts` |

The server batch deleted under a quarter of its list on purpose: the Fastify
tests drive a real server over real SQLite, which is the kind of test the
owner wants to keep. The client side kept 61 of 435 files.

## Rules ported into `util/architecture-inventory.ts`

The structural batch read every source-text and ownership test and ported
only the rules that guard a security or data boundary. They now run in
`pnpm check:server`.

| Rule | From |
| --- | --- |
| The protocol package may not import client, server, host, DOM, Svelte, or Node-only modules | `packages/protocol/src/importBoundary.test.ts` |
| Shared-core may not import client, server, host, DOM, Svelte, Fastify, or Node-only modules | `packages/shared-core/src/importBoundary.test.ts` |
| Only classified capability-gated callers may reach the raw generation path | `src/ts/process/rawGenerationCallerAllowlist.test.ts` |
| Every flat model or runtime field access is classified with a stable expected count | `src/ts/model/modelRuntimeFlatAccessGate.test.ts` |

The other 57 structural rules (type ownership, descriptor ownership,
phase 3 to 12 compatibility structure, UI compatibility inventory,
accessibility source scans, and similar) were judged to protect a migration
plan rather than a runtime boundary and were dropped; the structural result
file records each decision.

## Method

Six file-disjoint batches ran as GPT-5.6 Sol sub-agents, one git worktree
each outside the repository, under a written protocol
(`/home/codex/core-audit/phase5/PROTOCOL.md`). The default for every file was
delete. A file stayed only when four rules held: it drives a real boundary
(Fastify `inject` over real SQLite, Playwright, or real modules with only
process edges stubbed), its assertions compare observable outcomes against
explicit expected data, no core case already observes the scenario, and it is
not Low tier. Client files also had to be High or Critical tier unless they
were mock-free pure-function fixture tests. Each agent deleted with `git rm`,
removed support files no survivor imports, fixed every enumeration and frozen
baseline that named a deleted file, and ran topology, `svelte-check`,
`check:server`, the full Vitest lane for its side, `pnpm test:agent`,
Prettier, and one `pnpm test:all`. Documentation was frozen for the six
batches and rewritten afterwards by a seventh agent, so `check:docs` was the
one lane expected to fail until then.

Integration: the batch commits were cherry-picked in order onto `fastify`;
conflicts were limited to `vitest.frontend-routing.ts` (resolved as the union
of removals), the two client resource baseline files (regenerated once on the
merged tree), and two files one batch edited that another had deleted (the
deletion won). The merged tree needed one extra fix: the gap matrix gate test
in `util/architecture-inventory.test.ts` mutated the `lorebook` owner, which
lost its last test-fixture consumer, so it now mutates `character-chat`.

## Things worth knowing

1. **The six parallel `test:all` runs were noisy.** Each batch's single
   aggregate run hit load timeouts in frontend, server, and browser lanes
   while six Vitest and Playwright suites shared one machine. Every affected
   file passed its isolated rerun, and the merged tree's `test:all` on a quiet
   machine passed every lane except documentation, which was expected.
2. **Frozen baselines shrank.** The client resource inventory went from 4,290
   test-fixture references across 30 consumer groups to 464 across 12, and the
   owner gap matrix from nine resource families to four. The compatibility
   baseline re-points five `historicalFixture` entries from deleted tests to
   the production modules that own the behaviour.
3. **The priority inventory and the review worklist are retired.** They
   describe the 1,034-file suite of 2026-09-19; Phase 6 moved them to
   `.archived-docs/performance-and-stability/test-suite-reduction-2026-09/`
   and wrote the test policy into `AGENTS.md` (see
   [core-suite-phase-6.md](core-suite-phase-6.md)).
4. **One src-lib keeper was considered and rejected.** The owner had named
   `src/lib/ChatScreens/Chat.deletion.dom.test.ts` as borderline. It has no
   `vi.mock` call, but its `Chat.testSupport` harness replaced the repository's
   own modules and its oracle was the dispatch calls made on them, so it went
   with the rest. Message delete on a real page is covered by the `@core`
   journey in `server/fastify/browser-smoke/coreLifecycle.spec.ts`.

## Result files

`/home/codex/core-audit/phase5/results/<batch>.json` (one per batch plus
`docs.json`), `results/<batch>.progress.md`, `results/<batch>.test-all.log`,
`integration/test-all-merged-1.log`, `integration/replay-results.json`, and
`integration/deleted-files.txt` (867 paths).
