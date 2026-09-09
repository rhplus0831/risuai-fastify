# Unified Read-Only Workspace Status

## Current Cursor

- State: **Implementation in progress; Phases 0–1 accepted.**
- Current phase: Phase 2, role-first bootstrap.
- Next action: defer the reader projection until automatic writer acquisition
  settles, preserving the existing post-replay recovery sequence.
- Source baseline reviewed: `0654259fc`.
- Current architecture and test guides remain authoritative for shipped
  behavior.

## Document Map

- [PLAN.md](PLAN.md): stable product contract, invariants, scope, rollout, phase
  order, and completion criteria.
- [Inventory](inventory.md): current source, behavior, test, documentation, and
  performance owners.
- [Phase index](phases/README.md): execution rules, phase routing, and explicit
  plan-document validation.
- [Active plans](../README.md): repository active-plan index.
- [Prior read-only app UX](../../../.archived-docs/ui-and-user-input/read-only-app-ux/status.md):
  accepted familiar-reader presentation and containment evidence.
- [Prior shell parity](../../../.archived-docs/ui-and-user-input/read-only-shell-parity/status.md):
  accepted geometry and automatic-transition stability evidence.
- [Prior connected readers](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md):
  accepted authority, synchronization, promotion, and live-observation evidence.

## Phase Ledger

| Phase                                                                                           | State    | Acceptance evidence                                                                                       |
| ----------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| [0. Contract, inventory, and baseline](phases/phase-0-contract-inventory-and-baseline.md)       | Accepted | Source/test inventory rechecked; five-sample small/large cold/warm baseline and thresholds recorded below |
| [1. Access and readiness model](phases/phase-1-access-and-readiness-model.md)                   | Accepted | Derived workspace snapshot and non-replayed reader-route handoff at `ee210deb2`                           |
| [2. Role-first bootstrap](phases/phase-2-role-first-bootstrap.md)                               | Pending  | Not run                                                                                                   |
| [3. Unified shell and navigation](phases/phase-3-unified-shell-and-navigation.md)               | Pending  | Not run                                                                                                   |
| [4. Transcript and composer containment](phases/phase-4-transcript-and-composer-containment.md) | Pending  | Not run                                                                                                   |
| [5. Role transitions and performance](phases/phase-5-role-transitions-and-performance.md)       | Pending  | Not run                                                                                                   |
| [6. Rollout cleanup and closeout](phases/phase-6-rollout-cleanup-and-closeout.md)               | Pending  | Not run                                                                                                   |

## Decisions

- 2026-09-10: create a new active workstream rather than reopening the three
  completed read-only archives. They are predecessor contracts and evidence, not
  mutable execution records.
- 2026-09-10: use the repository's full `PLAN.md`, `status.md`, inventory, phase
  index, and separate phase-document structure because the work changes
  bootstrap, route intent, reader/writer presentation ownership, promotion, and
  more than three independently acceptable boundaries.
- 2026-09-10: keep the Svelte root/loading surface available while resolving the
  initial role, but do not render a reader workspace during an automatic writer
  attempt.
- 2026-09-10: derive presentation and interaction capabilities from existing
  session/readiness authorities. Do not add a mutable role flag that can drift
  from authentication, projection, recovery, or writer ownership.
- 2026-09-10: remove the dedicated ObserverShell environment while retaining
  reader projections, synchronization, passive rendering, live generation
  observation, and revision/auth/lineage fences.
- 2026-09-10: keep reader and writer controllers separate beneath shared normal
  presentation. Do not mount the unmodified writer controller for a reader.
- 2026-09-10: place one accessible device-promotion action in the top-right of
  the visual viewport shell. It remains until writer recovery is actually ready.
- 2026-09-10: reader character/chat navigation remains local and does not
  retroactively update persisted selection or `lastInteraction` during
  promotion. A later explicit writer-mode selection may persist normally.
- 2026-09-10: Settings, Playground, plugin/custom-GUI applications, interactive
  scripts, imports, and authoring remain unavailable to readers.
- 2026-09-10: follow Crunch Mode throughout this workstream. Do not run
  `pnpm test:agent` or `pnpm test:all`; use focused tests and only the relevant
  type/build/browser checks.
- 2026-09-10: progress and verification are recorded only here. Phase documents
  remain stable work/acceptance contracts.
- 2026-09-10: use the existing `VITE_FAST_BOOTSTRAP_OBSERVER` boundary as the
  sole short-lived whole-path rollout control. The default/enabled cohort will
  become role-first and unified; exact `FALSE` remains the complete conservative
  writer-first rollback until Phase 6. Do not introduce another feature flag,
  and remove the environment variable and smoke override after Phase 5 evidence
  passes.
- 2026-09-10: the canonical workspace snapshot will derive `booting`,
  `read-only`, `promoting`, or `writer` from client-session and startup
  readiness authority. Its independently reported capabilities are local
  browsing, persisted writer-route application, mutation, and generation; the
  snapshot is presentation state and never authorizes an operation.
- 2026-09-10: reader navigation owns the browser URL and stable character/chat
  IDs. Promotion preserves that display target, but the retained reader intent
  will not enter `changeChar()` or `changeChatTo()` automatically. Only a new
  writer-mode navigation action may update persisted selection or
  `lastInteraction`.

## Planning Evidence

The plan was grounded in the current App/bootstrap/readiness/session flow,
observer and reader components, writer sidebar/chat/composer owners, command and
generation guards, current architecture/test guides, completed predecessor
plans, and the available ignored fast-bootstrap artifact. Broad read-only source
cross-checks were performed before the planning package was written.

Planning-document validation on 2026-09-10:

| Command                                                                                                                  | Result                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm check:docs`                                                                                                        | Passed for 49 current documents                                                             |
| Explicit package/index validation from `phases/README.md`                                                                | Passed for all 12 active-plan documents with no link, anchor, index, or literal-path errors |
| `pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md 'docs/plan/unified-read-only-workspace/**/*.md'` | Passed                                                                                      |
| `git diff --check`                                                                                                       | Passed                                                                                      |

The first explicit package validation identified one stale proposed test path in
the inventory. It was replaced with the current composer-draft test owner, and
the complete 12-document validation then passed. No runtime suite was required
or run for this planning-only change.

## Progress Record

- 2026-09-10: created the stable product/architecture contract, active status
  ledger, source/test inventory, and seven-phase execution package. At that
  revision all runtime implementation and phase acceptance remained pending.
- 2026-09-10: accepted Phase 0 at instrumentation revision `d9c75b560` against
  runtime baseline `0654259fc`. Rechecked the App/startup/session/readiness,
  reader/writer navigation, transcript/composer, command/outbox, generation,
  lifecycle, rollout, telemetry, browser, and documentation owners listed in
  `inventory.md`; no durable schema, server authorization, or projection-fence
  change is required.

## Phase 0 Acceptance Evidence

The baseline ran on Linux 7.0.0-31-generic x86-64 under KVM, an AMD Ryzen 9
9950X host allocation with 10 vCPUs and 47 GiB RAM, Node.js 24.19.0, pnpm
11.23.0, Playwright 1.62.1, and bundled Chromium. The deterministic small and
large SQLite fixtures, cold browser/resource cache and subsequent warm reload
were measured five times each. Raw ignored artifacts are under
`fast-bootstrap-results/unified-read-only-workspace-baseline/`; the five
instrumented matrix SHA-256 prefixes are `bb55c911`, `cf5f2a30`, `1217dc66`,
`4d04987b`, and `185df01b`. Bundle and preload artifact prefixes are
`066f4c3a` and `8e56a2b4`.

Timing values are entry-relative milliseconds. Tail is the maximum sample,
equivalent to the nearest-rank p95 for five repetitions.

| Fixture/cache | Observer-ready median/tail | Writer-ready median/tail | Chat-ready median/tail | Background-ready median/tail | Long-task maximum median/tail |
| ------------- | -------------------------- | ------------------------ | ---------------------- | ---------------------------- | ----------------------------- |
| Small/cold    | 624.2 / 791.0              | 674.1 / 864.7            | 812.6 / 1076.5         | 814.4 / 1078.0               | 70 / 72                       |
| Small/warm    | 262.4 / 338.0              | 304.8 / 384.8            | 390.0 / 532.4          | 391.0 / 533.2                | 0 / 0                         |
| Large/cold    | 572.4 / 602.3              | 621.1 / 664.4            | 775.3 / 881.4          | 777.2 / 882.5                | 69 / 78                       |
| Large/warm    | 238.0 / 259.2              | 274.0 / 295.8            | 378.1 / 385.9          | 379.2 / 387.7                | 0 / 0                         |

Every one of the 20 cases performed two shell resource reads, mounted two
`ConversationShell` elements, removed one, changed shell identity once, and
mounted one observer workspace. All cases recorded zero early mutations, zero
early generations, zero missing owned frames, and 0 px maximum horizontal
delta. Cold cases recorded one 66–78 ms long task; warm cases recorded none.
The tiny startup layout-shift sample was at most `0.0000373671`. Small/large
resource payloads were 24,633/47,887 bytes cold and 7,008/34,255 bytes warm in
the representative instrumented output. The production initial closure was 373
modules and 175,954 gzip bytes; the immediate `appStartup` closure was 1,160
modules and 1,160,147 gzip bytes. The largest initial chunk was 72,737 gzip
bytes. Existing protected-boundary, HTML-preload, selected-locale, and size
budgets passed.

Frozen final comparison rules:

- automatic writer and settled reader startup must each perform exactly one
  shell read; automatic writer startup must record zero observer-workspace
  mounts, one conversation-shell mount, zero removals, and zero identity changes;
- reader promotion and writer demotion must record 0 px automatic horizontal
  shell delta and zero missing owned frames; layout-shift entries remain
  supporting evidence;
- every measured case must keep zero mutations before writer-ready and zero
  generation starts before chat-ready;
- compare cold only with cold and warm only with warm. Each final readiness
  median and nearest-rank p95 must be no worse than the matching baseline by
  more than the greater of 20% or 75 ms; the maximum long task must not exceed
  the matching baseline by more than 20 ms;
- initial and immediate-startup gzip closures must not grow by more than 10%,
  and the existing 921,600-byte total/512,000-byte largest initial milestone
  gates and protected-boundary checks remain hard requirements; and
- semantic request payload differences from removing the duplicate shell are
  reviewed by resource, while no unchanged resource may grow by more than 10%.

Phase 0 verification:

| Command                                                                                        | Result                                                                                             |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm measure:fast-bootstrap`                                                                  | Passed build, bundle/preload reports, and four-case startup matrix                                 |
| Four additional startup-matrix repetitions before instrumentation                              | Passed; reproduced two shell reads and zero early operations in all 20 samples                     |
| Five instrumented startup-matrix repetitions                                                   | Passed; deterministic double mount/removal/identity-change assertion and performance probes passed |
| `pnpm exec prettier --write server/fastify/browser-smoke/startupCachePopulationMatrix.spec.ts` | Passed                                                                                             |
| `git diff --check`                                                                             | Passed                                                                                             |

The browser-only probe was the sole Phase 0 source change. It records mount,
frame, layout-shift, and long-task evidence and does not change production
startup or presentation behavior. No known Phase 0 work remains.

## Phase 1 Acceptance Evidence

Revision `ee210deb2` added `workspaceAccess.ts`, whose presentation mode and
four independent capabilities derive from the current client-session role and
the existing startup guards. A coherent shell preview during initial automatic
acquisition remains `booting`; an established reader remains browsable as
`read-only` and `promoting`; writer presentation requires completed writer
recovery and ordinary mutation readiness. The selectors mirror rather than
replace `canUseClientWriteAccess()`, `canMutate()`, and `canGenerate()`.

The client session now exposes its existing established-role signal without a
second mutable authority flag. App promotion consumes the reader-only display
intent without invoking `applyRouteToStores()`. The state-to-route effect may
then reconcile to the already-persisted writer selection, and only a subsequent
writer-owned route change invokes the persistence-capable handlers. Stable
reader character/chat IDs remain memory-only and no route handoff calls
`changeChar()`, updates `lastInteraction`, dispatches a command, or creates an
outbox record.

| Command                                                     | Result                  |
| ----------------------------------------------------------- | ----------------------- |
| `pnpm test -- src/ts/workspaceAccess.test.ts`               | 5 passed                |
| `pnpm test -- src/App.routeEffect.dom.test.ts`              | 29 passed               |
| `pnpm test -- src/ts/clientSession.test.ts`                 | 15 passed               |
| `pnpm test -- src/ts/startupReadiness.test.ts`              | 14 passed               |
| `pnpm test -- src/ts/observerRouteIntent.test.ts`           | 4 passed                |
| `pnpm test -- src/ts/server/commands.clientSession.test.ts` | 9 passed                |
| `pnpm check`                                                | 0 errors and 0 warnings |

The first two App DOM runs failed because retained-route tests still expected
the old automatic writer-handler replay. Their assertions were migrated to the
new invariant: the retained reader target is consumed with zero handler calls,
and a later writer navigation is the first persisted application. The final
mounted suite passed. No visible reader-shell change, protocol change, or known
Phase 1 work remains.

For every completed slice, record the exact changed boundary, source revision,
focused commands and outcomes, browser or performance artifacts where required,
failures and resolutions, and remaining limitations. Advance the phase cursor
only after every acceptance item has final-source evidence.
