# Unified Read-Only Workspace Status

## Current Cursor

- State: **Completed and archived; all phases accepted.**
- Current phase: Closeout complete.
- Next action: None. Current architecture and test guides own shipped behavior.
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
- [UI archive](../README.md): related completed reader work.
- [Active plans](../../../docs/plan/README.md): repository planning index.
- [Prior read-only app UX](../read-only-app-ux/status.md):
  accepted familiar-reader presentation and containment evidence.
- [Prior shell parity](../read-only-shell-parity/status.md):
  accepted geometry and automatic-transition stability evidence.
- [Prior connected readers](../connected-read-only-clients/status.md):
  accepted authority, synchronization, promotion, and live-observation evidence.

## Phase Ledger

| Phase                                                                                           | State    | Acceptance evidence                                                                                       |
| ----------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| [0. Contract, inventory, and baseline](phases/phase-0-contract-inventory-and-baseline.md)       | Accepted | Source/test inventory rechecked; five-sample small/large cold/warm baseline and thresholds recorded below |
| [1. Access and readiness model](phases/phase-1-access-and-readiness-model.md)                   | Accepted | Derived workspace snapshot and non-replayed reader-route handoff at `ee210deb2`                           |
| [2. Role-first bootstrap](phases/phase-2-role-first-bootstrap.md)                               | Accepted | One-read automatic writer startup and fenced recovery failure at `c6f5871a4`                              |
| [3. Unified shell and navigation](phases/phase-3-unified-shell-and-navigation.md)               | Accepted | Persistent shared workspace, Back-only chat navigation, and top-right device action at `1a46fb9ad`        |
| [4. Transcript and composer containment](phases/phase-4-transcript-and-composer-containment.md) | Accepted | Pure disabled reader composer and browser containment at `f99b5a8c2`                                      |
| [5. Role transitions and performance](phases/phase-5-role-transitions-and-performance.md)       | Accepted | In-place role, draft, generation, reconnect, and five-sample performance gates passed                     |
| [6. Rollout cleanup and closeout](phases/phase-6-rollout-cleanup-and-closeout.md)               | Accepted | Sole role-first path, telemetry v2, retired rollout seam, current docs, and archive validation passed     |

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
  IDs while reading and during pending promotion. Once writer recovery settles,
  App consumes the reader-only target and reconciles the URL to canonical
  persisted writer state without calling `changeChar()` or `changeChatTo()`.
  Only a new writer-mode navigation action may update persisted selection or
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
| `pnpm test -- src/ts/readerRouteIntent.test.ts`             | 4 passed                |
| `pnpm test -- src/ts/server/commands.clientSession.test.ts` | 9 passed                |
| `pnpm check`                                                | 0 errors and 0 warnings |

The first two App DOM runs failed because retained-route tests still expected
the old automatic writer-handler replay. Their assertions were migrated to the
new invariant: the retained reader target is consumed with zero handler calls,
and a later writer navigation is the first persisted application. The final
mounted suite passed. No visible reader-shell change, protocol change, or known
Phase 1 work remains.

## Phase 2 Acceptance Evidence

Revision `c6f5871a4` makes authenticated ownership discovery precede both
conditional acquisition and projection installation. Eligible automatic
writers acquire first and retain the existing outbox preparation, receipt
acknowledgement, pending replay, authoritative shell, projection/cursor setup,
event subscription, and writer-readiness order. Foreign writers and lost
acquisition races settle a reader disposition before loading their single
coherent shell and synchronization stream.

App consumes the derived workspace mode, so a managed initial writer remains
on the loading boundary even after its post-replay shell arrives; it cannot
mount the read-only workspace, writer content, or authoring resources before
writer recovery completes. If recovery fails after acquisition while the
server may still identify this session as writer, the client now remains in
fenced `recovering-writer` state with an interrupted connection and schedules
ownership revalidation. It does not silently abandon retained work or expose a
reader projection. Authentication loss still clears the protected state.

| Command                                                                                                                             | Result                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pnpm test -- src/ts/connectedClientStartup.test.ts`                                                                                | 18 passed                                                                    |
| `pnpm test -- src/ts/bootstrap.test.ts`                                                                                             | 217 passed                                                                   |
| `pnpm test -- src/App.routeEffect.dom.test.ts`                                                                                      | 30 passed                                                                    |
| `pnpm test -- src/ts/workspaceAccess.test.ts`                                                                                       | 5 passed                                                                     |
| `pnpm test -- src/ts/clientSession.test.ts`                                                                                         | 15 passed                                                                    |
| `pnpm test -- src/ts/startupReadiness.test.ts`                                                                                      | 14 passed                                                                    |
| `pnpm build:smoke`                                                                                                                  | Passed; existing CSS `::highlight` and large-chunk warnings remain non-fatal |
| `pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/startupCachePopulationMatrix.spec.ts` | 1 passed with all four populations                                           |
| `pnpm check`                                                                                                                        | 0 errors and 0 warnings                                                      |

The final local startup artifact has SHA-256 prefix `793845b8`. Every
small/large cold/warm case recorded one shell read, one conversation-shell
mount, zero observer mounts, zero shell removals/identity changes, zero missing
owned frames, 0 px maximum horizontal delta, zero mutations before
writer-ready, and zero generations before chat-ready. Readiness remained within
the Phase 0 thresholds; the largest observed long task was 88 ms, below the
applicable 92 ms ceiling.

The first role-first bootstrap run failed only because legacy tests expected the
pre-acquisition locale preview and reader fallback after retained replay. Those
tests were migrated to the new ordering and the hidden recovery contract; all
final focused and browser checks passed. No protocol/server schema change or
known Phase 2 work remains.

## Phase 3 Acceptance Evidence

Revision `1a46fb9ad` replaced the mutually exclusive App-level observer/writer
shells with one `Workspace.svelte` and one persistent `ConversationShell` call
site. Reader navigation/content and writer Sidebar/route content remain
separate explicit inputs beneath that frame. Mounted App coverage proves the
workspace DOM identity survives capability loss, while automatic lifecycle
changes continue to suppress sidebar animation.

The reader controller retains local Home, grid, character, chat, pinned,
folder, search, drawer, and history state without writer-store or command
fallbacks. Settings, Playground, plugin/custom-GUI and restored overlays remain
denied before their loaders are invoked. Reader chat routes render a native
Back button outside any inert region and no other focusable sidebar control;
Back changes only the browser route. `DeviceAccessAction.svelte` provides the
single icon-labelled, single-flight, safe-area-aware top-right promotion action
and localized live result region across reader routes.

Focused checks passed: 31 workspace DOM tests, 30 App route DOM tests, 3 device
action tests, 6 Sidebar list tests, 26 Sidebar keyboard tests, 19 grid tests, 15
hotkey navigation tests, and 9 reader-local mutation tests. The smoke build
passed with only the pre-existing CSS and large-chunk warnings. The first
reader browser run reached the unified UI and failed only at the removed legacy
footer-composer selector, which Phase 4 replaced. Final browser evidence is
recorded below. No known Phase 3 work remains.

## Phase 4 Acceptance Evidence

Revision `f99b5a8c2` added a pure `ReadOnlyComposer.svelte` inside the normal
reader chat layout. Its message, translated, Draft, and BTW fields are native
disabled/read-only controls; send, menu, attachment, sticker, and reroll
actions are disabled and have no callbacks. It imports no draft store,
input-hook, plugin, scripting, generation, command, outbox, or writer controller
and therefore cannot create or restore writer state for a never-writer reader.
`ReaderTranscript` continues to pass explicit read-only state and certified
`ChatReadOwners` through the shared `Chats`, `Chat`, and `ChatBody`
presentation, retaining copy, disclosure, paging, refresh, scrolling, passive
display, and live generation observation.

| Command                                                                                                              | Result                                        |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `pnpm test -- src/lib/ChatScreens/ReadOnlyComposer.svelte.test.ts`                                                   | 2 passed                                      |
| `pnpm test -- src/lib/ReaderTranscript.svelte.test.ts`                                                               | 31 passed                                     |
| `pnpm test -- src/lib/ChatScreens/ChatBody.svelte.test.ts`                                                           | 17 passed                                     |
| `pnpm test -- src/lib/ChatScreens/Chats.owner.test.ts`                                                               | 2 passed                                      |
| `pnpm test -- src/lib/ChatScreens/DefaultChatScreen.composerDrafts.test.ts`                                          | 10 passed                                     |
| `pnpm test -- src/ts/server/writerDraftRecovery.test.ts`                                                             | 25 passed                                     |
| `pnpm check`                                                                                                         | 0 errors and 0 warnings                       |
| `pnpm build:smoke`                                                                                                   | Passed; existing non-fatal warnings unchanged |
| `pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/readOnlyAppUx.spec.ts` | 4 passed in 19.3 s                            |

The real-browser cases cover desktop and mobile reader navigation, Back-only
chat sidebar, disabled composer/action DOM, safe Settings/Plugin denial,
folders/search/pins/history, passive message copy/disclosure/link behavior,
theme and responsive layout, no reader commands/outbox/drafts, cache-pure reads,
replay refresh, deletion fallback, and authentication loss. Intermediate runs
identified old full-navigation assumptions after chat entry and a device action
that overlapped Refresh; journeys were migrated to the Back-first contract and
the action gained safe header clearance. The final complete run passed. No
known Phase 4 work remains.

## Phase 5 Acceptance Evidence

Revisions `df9252a6f`, `6a3835abb`, `a7b89bcd5`, and `c1def05e4`
completed the integrated transition gate. Promotion now consumes reader-only
route intent and immediately reconciles the URL to persisted writer state
without invoking selection handlers. The A → B → A browser journey proves that
both pre-promotion reader targets leave durable selection unchanged, while a
fresh writer-mode selection creates the next `character.selected` event under
the new writer session. The same journey retains the originating writer draft,
rejects stale mutations, keeps each demoted reader on its own route, and does
not reload either document.

Back-only reader chat navigation retains an inert rail spacer, so the canonical
rail/panel/main rectangles do not change when authority moves. The final
transition artifact under
`fast-bootstrap-results/unified-read-only-workspace-final-role-first/transitions/`
has SHA-256 prefix `fc46dc6f`; writer demotion sampled 32 frames and reader
promotion sampled 33, with zero missing elements and 0 px maximum horizontal
delta. The one promotion layout-shift entry had recent user input and remains
supporting evidence rather than an unexplained automatic shift.

The mobile browsing journey identified the top-right action covering a message
control after scrolling. `DeviceAccessAction` now uses its safe-area-aware true
top-right position, becomes icon-only below the small breakpoint, and
`ReaderTranscript` reserves matching header clearance. Desktop/mobile reader
containment and the Pixel 7 navigation/copy/history/reconnect journey pass.

Focused final-source lifecycle coverage included 23 Vitest files and 545 tests
for startup, session/readiness, App/workspace/device/composer/transcript,
commands/outbox, writer loss, auth/lineage replacement, reader synchronization,
generation observation, refresh, and telemetry. The standalone bootstrap suite
passed 214 tests. The connected-generation browser suite passed all five live
partial, viewer-detachment, transfer, finalization, and receipted-IGP journeys.
`connectedWriterSwitching.spec.ts` passed all three journeys,
`connectedReaderBrowsing.spec.ts` passed, `readOnlyAppUx.spec.ts` passed all
four journeys, and `connectedReaderRollout.spec.ts` passed the real server
restart/reconnect journey.

The final five-sample cleanup-complete measurement is retained under
`fast-bootstrap-results/unified-read-only-workspace-final-role-first/`. Matrix
SHA-256 prefixes are `a3c07ec2`, `29e02c3d`, `b550dd54`, `09f21270`, and
`0b327145`; bundle-boundary and initial-preload prefixes are `865760fc` and
`4e2759ec`.

| Fixture/cache | Reader-ready median/tail | Writer-ready median/tail | Chat-ready median/tail | Background-ready median/tail | Long-task maximum median/tail |
| ------------- | ------------------------ | ------------------------ | ---------------------- | ---------------------------- | ----------------------------- |
| Small/cold    | 568.7 / 639.9            | 579.1 / 649.6            | 706.6 / 776.1          | 707.3 / 777.1                | 66 / 84                       |
| Small/warm    | 220.2 / 232.1            | 226.2 / 238.6            | 312.2 / 320.6          | 313.1 / 321.8                | 0 / 0                         |
| Large/cold    | 529.9 / 566.2            | 536.8 / 575.2            | 667.4 / 694.0          | 668.3 / 696.9                | 62 / 74                       |
| Large/warm    | 242.0 / 286.0            | 248.1 / 303.5            | 328.9 / 448.4          | 329.8 / 450.3                | 0 / 0                         |

All 20 cases performed one shell read and one conversation-shell mount, with
zero reader-workspace mounts during automatic writer startup, zero removals,
zero identity changes, zero missing frames, 0 px maximum horizontal delta,
zero mutations before writer-ready, and zero generations before chat-ready.
Every readiness median/tail and long-task maximum is inside the Phase 0 frozen
allowance. Initial JavaScript is 175,551 gzip bytes across 373 modules, down
403 bytes from baseline; immediate startup is 1,160,200 gzip bytes across 1,161
modules, up 53 bytes (less than 0.01%). The 72,713-byte largest initial chunk
and total closure pass both hard budgets. No Phase 5 regression remains.

## Phase 6 Acceptance Evidence

Revision `1a9a1020b` made role-first connected startup the sole production path.
It removed `VITE_FAST_BOOTSTRAP_OBSERVER`, the smoke session override,
flag-on/off startup branches, unmanaged retry presentation, obsolete selectors,
and the dedicated fallback browser campaign. Reader route, projection, and
lifecycle owners now use `readerRouteIntent.ts`,
`readerProjectionLifecycle.ts`, and `readerWorkspaceLifecycle.svelte.ts`.
`Workspace.svelte`, `DeviceAccessAction.svelte`, and
`ReadOnlyComposer.svelte` own the final presentation. Startup telemetry protocol
v2 uses `reader-ready` and no longer publishes a rollout-cohort field.

The flag-free recovery browser gate exposed a managed writer replay-gap race:
the stream close callback could interrupt the session before the initial 409
result began its authoritative refresh. Initial subscription callbacks are now
ignored until the result is classified, and replay-unavailable refresh is
awaited before reconnect. The focused bootstrap regression and the real
`event_replay_unavailable` journey both pass; revision `73a28d6d6` gives the
bounded reconnect-backoff assertion its non-flaky deadline.

Revision `28e107827` removed the rollout marker from the client-resource
inventory and regenerated its checked-in baseline. Architecture validation now
reports 4,279 test-fixture compatibility references across 30 consumer groups,
zero bridge families, and 16 retained character-aggregate seam markers, down
from 21 total markers. Revision `75e8a1d18` updated current startup, persistence,
UI, navigation, chat/generation, observability, environment, and test guides.

Final verification:

| Command or focused group                                                           | Result                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run ...` across 23 final changed-owner files                     | 545 passed                                                                                                                               |
| `pnpm exec vitest run src/ts/bootstrap.test.ts --maxWorkers=1`                     | 214 passed                                                                                                                               |
| Fastify telemetry/protocol/artifact/compatibility group                            | 73 passed                                                                                                                                |
| `pnpm check`                                                                       | 0 errors and 0 warnings                                                                                                                  |
| `pnpm check:server`                                                                | Protocol, shared-core, inventory, Fastify, and browser-smoke checks passed                                                               |
| `pnpm exec tsx util/architecture-inventory.ts`                                     | All four inventory gates passed                                                                                                          |
| `pnpm build:smoke` and `pnpm measure:fast-bootstrap`                               | Passed with only the existing CSS `::highlight` and large-chunk warnings                                                                 |
| `readOnlyAppUx.spec.ts`                                                            | 4 passed                                                                                                                                 |
| `connectedReaderBrowsing.spec.ts`                                                  | 1 passed                                                                                                                                 |
| `connectedWriterSwitching.spec.ts`                                                 | 3 passed                                                                                                                                 |
| `connectedReaderGeneration.spec.ts`                                                | 5 passed                                                                                                                                 |
| `connectedReaderRollout.spec.ts`                                                   | 1 passed                                                                                                                                 |
| Required `startupDirectLinks.spec.ts` + `startupRecoveryIntegrationMatrix.spec.ts` | 11 passed; 44 direct links, two role-first fixtures, response-loss replay, event-gap recovery, takeover, and four optional-runtime cases |
| `pnpm check:docs`                                                                  | 49 current documents passed                                                                                                              |

The merged Fast-bootstrap integration artifact has SHA-256 prefix `e1b24933`.
No full-suite command was run, in accordance with Crunch Mode; the required
changed-owner and cross-layer gates above are green. No known required work or
residual rollout path remains.
