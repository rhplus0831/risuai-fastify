# Browser Smoke Review Inventory

Initial execution inventory: 2026-09-07 at `711b1d583` (clean worktree).
Phase 2 discovery: `6f39fb8f0` plus the real-operation Realm browser spec.

The Reader Phase 5 source universe at `678876571` contains 92 cases in 22 specs, plus twelve local
TypeScript support owners and four screenshot baselines. The planning snapshot
was extended by eight viewport/entry/height cases in `chatEntryLayout.spec.ts`
and two real-operation Realm confirmation cases added during smoke Phase 2.
Reader Phase 2 adds one real multi-session connected browsing scenario (S80);
S32/S60 retain their identities with updated mixed-client behavior. Reader Phase 3
adds S81–S83 for explicit switching, durable generation survival and empty-server setup.
Reader Phase 4 adds S84–S88 for live viewing, detach, Stop, queued finalization
and atomic IGP receipt recovery; their final baseline, all six production faults and restored controls pass.
Reader Phase 5 adds S89/S90 for restart and fallback, strengthens S80 for two
simultaneous Readers, and adds S91 alongside the retained conservative S77
lineage-recovery case. The initial full TRUE cohort was 80/90; the corrected
cohort passes 91/91 with five qualified faults and restored controls. Normal/FALSE
rollout builds also pass at their recorded source. The phase-ending run at
`90069ac9c` passes 89/91 and exposes S47's lost startup navigation and recurring
S22 sampling coverage. Their repairs add S92's delayed initial-handler race;
combined browser/fault/fallback evidence and repeated final gates are pending.
Discovery does not mean execution or acceptance; review states remain explicit.
The [plan](PLAN.md) defines scope; [status](status.md) owns the execution cursor.

## Default Registered Cases

All spec names below resolve under `server/fastify/browser-smoke`.

| Spec                                       | Default cases | Primary review phase                      | Review state                                          |
| ------------------------------------------ | ------------: | ----------------------------------------- | ----------------------------------------------------- |
| `acceptedSendProtocol.spec.ts`             |            11 | 2: generation/recovery                    | Pending                                               |
| `bardWikiLifecycle.spec.ts`                |             1 | 3: memory lifecycle                       | Pending                                               |
| `chatEntryLayout.spec.ts`                  |             8 | 2: transcript/entry; 3: final review      | Pending                                               |
| `chatHistoryScroll.spec.ts`                |             2 | 2: transcript                             | Pending                                               |
| `chatStartupRendering.spec.ts`             |             3 | 2: transcript/startup                     | Pending                                               |
| `connectedReaderBrowsing.spec.ts`          |             1 | Reader 2; Stage 3 reconciliation          | Added; final verification recorded in reader status   |
| `connectedReaderRollout.spec.ts`           |             2 | Reader 5; Stage 3 reconciliation          | Added; verification in progress                       |
| `connectedReaderGeneration.spec.ts`        |             5 | Reader 4; Stage 3 reconciliation          | Added; final verification recorded in reader status   |
| `connectedWriterSwitching.spec.ts`         |             3 | Reader 3; Stage 3 reconciliation          | Added; final verification recorded in reader status   |
| `debugEchoLayoutStability.spec.ts`         |             1 | 2: generation/layout                      | Pending                                               |
| `displayPaintCache.spec.ts`                |             1 | 3: startup/cache                          | Pending                                               |
| `fastifyBrowserSmoke.spec.ts`              |            10 | 2: critical slices; 3: remaining journeys | Pending                                               |
| `lazyFirstOpen.spec.ts`                    |             8 | 3: navigation/first open                  | Pending                                               |
| `realmProgressConfirmation.spec.ts`        |             2 | 2: confirmation                           | Strengthened; BSE-002                                 |
| `rerollSwipePersistence.spec.ts`           |             1 | 2: generation durability                  | Pending                                               |
| `selectedLocaleRuntime.spec.ts`            |             4 | 3: locale transitions                     | Pending                                               |
| `selectedLocaleStartup.spec.ts`            |             1 | 3: locale startup                         | Pending                                               |
| `startupCachePopulationMatrix.spec.ts`     |             1 | 3: startup/cache                          | Pending                                               |
| `startupDirectLinks.spec.ts`               |             4 | 3: route matrix                           | Pending                                               |
| `startupRecoveryIntegrationMatrix.spec.ts` |             7 | 2: stale-response recovery                | Pending                                               |
| `transcriptResidency.spec.ts`              |            12 | 2: transcript; 3: remaining interactions  | Pending                                               |
| `visibleStateRecovery.spec.ts`             |             4 | 2: visible/durable recovery               | Pending                                               |
| **Total**                                  |        **92** |                                           | **Pilot evidence recorded; remaining review pending** |

This file-level table is the current universe. The scenario records below are
keyed by spec plus full test title and meaningful subjourney/parameter labels. A whole
file cannot be marked reviewed after sampling a few of its scenarios. Keep
opt-in workload expansion, conditional skips, desktop/mobile profiles, and
manifest-generated route coverage explicit without inflating default counts.

## Shared Owners

| Owner                                                                                                                                              | Review question                                                                                                | State                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `server/fastify/browser-smoke/fastBootstrapHarness.ts` and harnesses embedded in specs                                                             | Does setup preserve the route/storage contracts being claimed, and which workers/configurations differ?        | Retained with limits; see Phase 1 dispositions |
| `server/fastify/browser-smoke/auth.ts`, `globalSetup.ts`, `globalTeardown.ts`, `globals.d.ts`                                                      | What is supplied globally, bypassed, reset, or shared across tests?                                            | Retained with limits; see Phase 1 dispositions |
| `server/fastify/browser-smoke/englishFixture.ts`, `selectedLocaleFixture.ts`, `transcriptResidencyFixture.ts` and inline fixtures                  | Which producer/schema/history supports the fixture, and does setup pre-complete the action?                    | Retained with limits; see Phase 1 dispositions |
| `server/fastify/browser-smoke/fastBootstrapDirectLinks.ts`                                                                                         | Does the generated route matrix cover its named journeys and render assertions?                                | Retained with limits; see Phase 1 dispositions |
| `server/fastify/browser-smoke/fastBootstrapIntegrationArtifact.ts`                                                                                 | Can missing/stale/partial evidence be mistaken for successful integration?                                     | Retained with limits; see Phase 1 dispositions |
| `src/ts/server/browserSmoke.ts` and the shared hook type it imports                                                                                | Which callers observe, seed, inject a fault, or drive the action under test?                                   | Retained with limits; see Phase 1 dispositions |
| `src/appStartup.ts`, `src/ts/observerShellFlag.ts`, `src/ts/storage/fastifyStorage.ts`, `src/ts/process/generationPersistenceState.ts`             | Which smoke-only startup, auth, observer, or timing branches change the claim?                                 | Retained with limits; see Phase 1 dispositions |
| `playwright.fastify-smoke.config.ts`, `util/focused-test.ts`, `util/browser-smoke-workers.ts`, `util/test-all.ts`, `.github/workflows/quality.yml` | What is discovered, skipped, isolated, built, executed, or required by each lane?                              | Retained with limits; see Phase 1 dispositions |
| Browser API overrides, request controls, and assertion helpers within every spec                                                                   | Does the control preserve the failing transition and does the assertion independently observe its consequence? | Retained with limits; see Phase 1 dispositions |

The initial local support set contained ten TypeScript files (952 lines at the
planning anchor). Reader Phases 4–5 add `connectedGenerationHarness.ts` and
`connectedReaderRolloutHarness.ts`, bringing the current support set to twelve; source line counts are not an execution metric. Follow imports
when they reveal additional shared owners; add only dependencies relevant to a
named test claim. Existing screenshot assets remain companion artifacts of
their scenario, not independent passing tests.

## Scenario Record

Each reviewed record must contain:

- Stable ID, spec/full title, subjourney or meaningful parameter, source anchor.
- Named behavior and failure mode; risk and production entry point.
- Fixture provenance and precondition; controlled/replaced boundaries and why.
- Action actually executed, including whether UI/queue/route/storage is bypassed.
- Independent visible/durable assertion and relevant pending-state assertions.
- Companion lower-layer evidence and explicit remaining scope limits.
- Execution command, conditional environment, and required browser profile.
- Disposition, finding references, fault demonstration reference when required.

Dispositions: pending, partial, retained, strengthened, reclassified, or removed
with replacement evidence. Missing critical journeys receive their own records
and findings instead of being omitted because no test title exists yet.

## Current Scenario Identities

The stable `S` IDs below identify registered cases at the execution anchor.
Full titles include parameters; each direct-link batch expands to eleven
manifest route journeys, without multiplying the registered count. Phase 0
reviews the named pilots; remaining path/oracle dispositions are completed in
their assigned phases. Per-spec contexts and control roles below apply to every
row unless the detailed review states a narrower boundary.

| ID  | Spec and source line                           | Full registered title                                                                                                 | Disposition                                         |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| S01 | `acceptedSendProtocol.spec.ts:354`             | send -> mid-stream and completed reloads retain one exact reply                                                       | Strengthened; BSE-003                               |
| S02 | `acceptedSendProtocol.spec.ts:413`             | accepted send recovers when the operation response is lost before identity reaches the browser                        | Retained; 2c/2d review                              |
| S03 | `acceptedSendProtocol.spec.ts:449`             | provider failure before tokens exposes an exact Retry that succeeds without duplicating the user row                  | Retained; 2c/2d review                              |
| S04 | `acceptedSendProtocol.spec.ts:492`             | Pixel reload plus visibility/pageshow reattaches and commits one reply                                                | Retained; 2c/2d review                              |
| S05 | `acceptedSendProtocol.spec.ts:520`             | server restart projects a billing-aware abandoned recovery and exact retry                                            | Retained; 2c/2d review                              |
| S06 | `acceptedSendProtocol.spec.ts:557`             | Stop acknowledges Stopping, persists a stopped partial, and runs no success effects                                   | Retained; 2c/2d review                              |
| S07 | `acceptedSendProtocol.spec.ts:586`             | Pixel visibility/pageshow Stop remains exact and persists one stopped partial                                         | Retained; 2c/2d review                              |
| S08 | `acceptedSendProtocol.spec.ts:623`             | viewer transport loss reconnects boundedly and terminal snapshot stays canonical                                      | Retained; 2c/2d review                              |
| S09 | `acceptedSendProtocol.spec.ts:642`             | preserved runtime reconciles completion after its observer and replay job expire                                      | Retained; 2c/2d review                              |
| S10 | `acceptedSendProtocol.spec.ts:672`             | two concurrent chats keep stable-target UI, recovery, and jobs isolated                                               | Retained; 2c/2d review                              |
| S11 | `acceptedSendProtocol.spec.ts:709`             | queued finalization keeps a provisional row through reload and later settles                                          | Retained; 2c/2d review                              |
| S12 | `bardWikiLifecycle.spec.ts:39`                 | BardWiki settings, manual document, confirmation status, and lifecycle tools are visible end to end                   | Pending                                             |
| S13 | `chatEntryLayout.spec.ts:26`                   | 390px direct entry reveals a short last message without a transient jump                                              | Retained; 2b review                                 |
| S14 | `chatEntryLayout.spec.ts:26`                   | 390px direct entry reveals a tall last message without a transient jump                                               | Retained; 2b review                                 |
| S15 | `chatEntryLayout.spec.ts:26`                   | 390px chat-list entry reveals a short last message without a transient jump                                           | Retained; 2b review                                 |
| S16 | `chatEntryLayout.spec.ts:26`                   | 390px chat-list entry reveals a tall last message without a transient jump                                            | Retained; 2b review                                 |
| S17 | `chatEntryLayout.spec.ts:26`                   | 1280px direct entry reveals a short last message without a transient jump                                             | Retained; 2b review                                 |
| S18 | `chatEntryLayout.spec.ts:26`                   | 1280px direct entry reveals a tall last message without a transient jump                                              | Retained; 2b review                                 |
| S19 | `chatEntryLayout.spec.ts:26`                   | 1280px chat-list entry reveals a short last message without a transient jump                                          | Retained; 2b review                                 |
| S20 | `chatEntryLayout.spec.ts:26`                   | 1280px chat-list entry reveals a tall last message without a transient jump                                           | Retained; 2b review                                 |
| S21 | `chatHistoryScroll.spec.ts:55`                 | 300-message history stays readable with continuous upward wheel input                                                 | Retained; P0-T and 2b                               |
| S22 | `chatHistoryScroll.spec.ts:55`                 | 300-message history stays readable with rapid reversals and pauses among tall messages                                | Strengthened; BSE-005 renewed proof pending         |
| S23 | `chatStartupRendering.spec.ts:9`               | direct chat startup waits for display dependencies and preserves the first processed body through background startup  | Retained; 2b review                                 |
| S24 | `chatStartupRendering.spec.ts:9`               | refresh chat startup waits for display dependencies and preserves the first processed body through background startup | Retained; 2b review                                 |
| S25 | `chatStartupRendering.spec.ts:112`             | direct chat startup releases the newest rows before older display work and preserves their scroll anchor              | Retained; 2b review                                 |
| S26 | `debugEchoLayoutStability.spec.ts:61`          | debug echo send stays visually stable through the first-token wait and foreground recovery                            | Retained visual contract; 2c                        |
| S27 | `displayPaintCache.spec.ts:34`                 | warm reload keeps appearance stable before the bundle, shell, and Display response arrive                             | Strengthened; BSE-004 verified                      |
| S28 | `fastifyBrowserSmoke.spec.ts:128`              | Fastify-served browser loads bootstrap, subscribes to events, and refreshes after a command                           | Pending                                             |
| S29 | `fastifyBrowserSmoke.spec.ts:345`              | authored settings survive local backup restore and a full reload                                                      | Pending                                             |
| S30 | `fastifyBrowserSmoke.spec.ts:420`              | authored character identity fields survive command acceptance and a full reload                                       | Pending                                             |
| S31 | `fastifyBrowserSmoke.spec.ts:487`              | translator preset bindings persist independently across chats                                                         | Pending                                             |
| S32 | `fastifyBrowserSmoke.spec.ts:566`              | a connected reader keeps receiving updates through a legacy writer takeover                                           | Retained; 2c/2d review                              |
| S33 | `fastifyBrowserSmoke.spec.ts:639`              | core chat controls and blocking alerts remain accessible across responsive viewports                                  | Pending                                             |
| S34 | `fastifyBrowserSmoke.spec.ts:720`              | latest-message start alignment never mutates spacer geometry during free scrolling                                    | Retained; 2b review                                 |
| S35 | `fastifyBrowserSmoke.spec.ts:825`              | mobile in-flow composer opens from a button above the stable keyboard viewport                                        | Pending                                             |
| S36 | `fastifyBrowserSmoke.spec.ts:1157`             | prompt presets and model profiles reorder from an immediate mobile touch drag                                         | Pending                                             |
| S37 | `fastifyBrowserSmoke.spec.ts:1201`             | global lorebook page owner hydrates once, selects by stable id, and survives reload                                   | Pending                                             |
| S38 | `lazyFirstOpen.spec.ts:281`                    | smoke manifest accounts for every lazy boundary                                                                       | Pending                                             |
| S39 | `lazyFirstOpen.spec.ts:306`                    | every Settings and Playground route opens its real first-use chunk                                                    | Pending                                             |
| S40 | `lazyFirstOpen.spec.ts:340`                    | grid, route handlers, Sidebar panels, and chat dialogs open only on first use                                         | Pending                                             |
| S41 | `lazyFirstOpen.spec.ts:416`                    | a delayed emitted stylesheet keeps the previous route mounted until the new route is ready                            | Pending                                             |
| S42 | `lazyFirstOpen.spec.ts:444`                    | a delayed modal chunk preserves focus through loading, CSS, and close                                                 | Pending                                             |
| S43 | `lazyFirstOpen.spec.ts:486`                    | preset and persona lazy dialogs stay within the viewport after first-open loading                                     | Pending                                             |
| S44 | `lazyFirstOpen.spec.ts:523`                    | conservative writer offline first open shows local Retry and succeeds when connectivity returns                       | Retained conservative route-loader contract         |
| S45 | `lazyFirstOpen.spec.ts:557`                    | a stale emitted stylesheet shows local recovery and reloads the current route                                         | Pending                                             |
| S46 | `rerollSwipePersistence.spec.ts:32`            | rerolled candidates survive a reload and stay swipe-recoverable                                                       | Retained reconstruction; 2c                         |
| S47 | `selectedLocaleRuntime.spec.ts:23`             | a delayed locale cannot overwrite a newer selection and is reused on the next switch                                  | Pending                                             |
| S48 | `selectedLocaleRuntime.spec.ts:73`             | a failed locale chunk leaves the current UI usable and a later selection retries it                                   | Pending                                             |
| S49 | `selectedLocaleRuntime.spec.ts:108`            | cold selected-locale failure retries before exposing its first composer                                               | Pending                                             |
| S50 | `selectedLocaleStartup.spec.ts:15`             | selected locale is usable on cold startup and refresh                                                                 | Pending                                             |
| S51 | `startupCachePopulationMatrix.spec.ts:78`      | startup matrix keeps cold and warm small/large populations separate                                                   | Pending                                             |
| S52 | `startupDirectLinks.spec.ts:31`                | Fast-bootstrap direct-link matrix › batch 1/4 hydrates 11 empty-cache routes                                          | Pending                                             |
| S53 | `startupDirectLinks.spec.ts:31`                | Fast-bootstrap direct-link matrix › batch 2/4 hydrates 11 empty-cache routes                                          | Pending                                             |
| S54 | `startupDirectLinks.spec.ts:31`                | Fast-bootstrap direct-link matrix › batch 3/4 hydrates 11 empty-cache routes                                          | Pending                                             |
| S55 | `startupDirectLinks.spec.ts:31`                | Fast-bootstrap direct-link matrix › batch 4/4 hydrates 11 empty-cache routes                                          | Pending                                             |
| S56 | `startupRecoveryIntegrationMatrix.spec.ts:41`  | startup rollout matrix proves flag-off and flag-on boundaries on small and large fixtures                             | Pending                                             |
| S57 | `startupRecoveryIntegrationMatrix.spec.ts:61`  | legacy and null shell state is repaired before built-browser bootstrap                                                | Pending                                             |
| S58 | `startupRecoveryIntegrationMatrix.spec.ts:114` | durable recovery replays offline work and committed work whose response was lost                                      | Retained; 2c/2d review                              |
| S59 | `startupRecoveryIntegrationMatrix.spec.ts:218` | event-gap recovery performs an authoritative refresh before reconnecting                                              | Retained; 2c/2d review                              |
| S60 | `startupRecoveryIntegrationMatrix.spec.ts:345` | mixed-client journey denies pre-authority mutation and keeps the old writer connected after legacy takeover           | Retained; 2c/2d review                              |
| S61 | `startupRecoveryIntegrationMatrix.spec.ts:427` | background runtimes cannot delay or fail shell, mutation, and chat readiness                                          | Pending                                             |
| S62 | `startupRecoveryIntegrationMatrix.spec.ts:503` | inlay runtime stays route-local when slow or failed and recovers through Retry                                        | Pending                                             |
| S63 | `transcriptResidency.spec.ts:89`               | transcript residency desktop 30 rows repetition 0                                                                     | Retained; 2b review                                 |
| S64 | `transcriptResidency.spec.ts:89`               | transcript residency mobile 30 rows repetition 0                                                                      | Retained; 2b review                                 |
| S65 | `transcriptResidency.spec.ts:331`              | transcript residency screenshot is temporary full materialization                                                     | Pending                                             |
| S66 | `transcriptResidency.spec.ts:397`              | transcript residency preserves editing, selection and copy desktop                                                    | Pending                                             |
| S67 | `transcriptResidency.spec.ts:397`              | transcript residency preserves editing, selection and copy mobile                                                     | Pending                                             |
| S68 | `transcriptResidency.spec.ts:555`              | transcript residency restores ordinary rows after screenshot failure                                                  | Pending                                             |
| S69 | `transcriptResidency.spec.ts:555`              | transcript residency restores ordinary rows after screenshot cancellation                                             | Pending                                             |
| S70 | `transcriptResidency.spec.ts:610`              | transcript residency bounds eight editors through page reset and keyboard gap navigation                              | Pending                                             |
| S71 | `transcriptResidency.spec.ts:793`              | transcript residency cancels a pending jump when its route is hidden and reopened                                     | Pending                                             |
| S72 | `transcriptResidency.spec.ts:906`              | transcript legacy paging rollback traverses 180 mounted rows without spacers                                          | Pending                                             |
| S73 | `transcriptResidency.spec.ts:953`              | transcript residency promotes readable visible messages during rapid movement and settles                             | Retained; 2b review                                 |
| S74 | `transcriptResidency.spec.ts:1040`             | transcript residency expands its working window to fill a compact message viewport                                    | Retained; 2b review                                 |
| S75 | `visibleStateRecovery.spec.ts:72`              | switching chats repaints the active-chat generation picker                                                            | Retained; 2c/2d review                              |
| S76 | `visibleStateRecovery.spec.ts:107`             | a sidebar toggle flip survives the command + resource refresh                                                         | Retained; 2c/2d review                              |
| S77 | `visibleStateRecovery.spec.ts:147`             | conservative startup preserves the same-character sidebar view through old-lineage recovery reload                    | Retained conservative contract; Reader 5            |
| S78 | `realmProgressConfirmation.spec.ts:50`         | Realm import moves from actual download progress to low-level confirmation and handles YES                            | Strengthened; BSE-002                               |
| S79 | `realmProgressConfirmation.spec.ts:50`         | Realm import moves from actual download progress to low-level confirmation and handles NO                             | Strengthened; BSE-002                               |
| S80 | `connectedReaderBrowsing.spec.ts:210`          | a mobile connected Reader follows committed updates and browses locally without taking write access                   | Strengthened; Reader Phase 5 fault verified         |
| S81 | `connectedWriterSwitching.spec.ts:580`         | Use this device switches A to B to A in place while preserving reader routes and the originating draft                | Added; Reader Phase 3 reconciliation                |
| S82 | `connectedWriterSwitching.spec.ts:745`         | an accepted server generation keeps its job and durable reply when Use this device transfers the writer               | Added; Reader Phase 3 reconciliation                |
| S83 | `connectedWriterSwitching.spec.ts:955`         | an empty server without Web Locks initializes only after the explicit setup action with a fresh writer identity       | Added; Reader Phase 3 reconciliation                |
| S84 | `connectedReaderGeneration.spec.ts:28`         | a connected Reader sees one live partial and the exact persisted reply without control or effect requests             | Added; Reader Phase 4 verified                      |
| S85 | `connectedReaderGeneration.spec.ts:62`         | Reader chat switching and close/reopen detach viewers while the same provider job keeps running                       | Added; Reader Phase 4 verified                      |
| S86 | `connectedReaderGeneration.spec.ts:122`        | writer transfers during streaming and stopping preserve one cancelled partial without completion effects              | Added; Reader Phase 4 verified                      |
| S87 | `connectedReaderGeneration.spec.ts:201`        | writer transfer while a real finalization journal is queued commits one result and settles one effect ledger          | Added; Reader Phase 4 verified                      |
| S88 | `connectedReaderGeneration.spec.ts:363`        | an accepted IGP append is already receipted when its writer loses ownership before the PATCH response                 | Added; Reader Phase 4 verified                      |
| S89 | `connectedReaderRollout.spec.ts:102`           | default connected Reader reconnects after an actual server restart without page reload or write takeover              | Added; Reader Phase 5 fault verified                |
| S90 | `connectedReaderRollout.spec.ts:223`           | conservative fallback reload replays one UI-saved command and preserves the newer unsent composer draft               | Added; Reader Phase 5 fault verified                |
| S91 | `visibleStateRecovery.spec.ts:229`             | connected-default import recovery preserves the character sidebar after explicit same-owner writer recovery           | Added; Reader Phase 5 fault verified                |
| S92 | `selectedLocaleRuntime.spec.ts:151`            | new writer navigation reaches Settings while the initial character route handler is delayed                           | Added; final-gate route repair verification pending |

## Conditional and Expanded Execution

- `RISU_READER_ROLLOUT_COMPILED_FALLBACK=TRUE` is a test-run selector for the
  S90 build-time `FALSE` campaign: enable only its initial connected fixture,
  then remove the override before fallback reload. It is not a production flag.
  Ordinary S89/S90 initial startup has no per-page override; S77 and S44
  explicitly retain the conservative paths.
- Default Chromium is headless desktop. Explicit Pixel contexts in accepted
  send and mobile/touch transcript contexts exercise browser emulation, not
  physical devices. Chat entry uses 390×844 and 1280×800 viewports; history uses
  1721×1271. DOM tracing is disabled by the history, residency, and entry specs
  because snapshots change their scheduling.
- `RISU_TRANSCRIPT_COSTS=1` expands the residency size/profile matrix from
  desktop/mobile × 30 rows to desktop/mobile/mobile-cpu4x × 30/180/600 rows.
  `RISU_TRANSCRIPT_REPETITIONS` admits 1–5 repeats. Cost mode skips independent
  interaction cases; it measures costs without imposing latency gates.
  `RISU_TRANSCRIPT_LEGACY_PAGING=1` skips incompatible resident-mode cases;
  `RISU_TRANSCRIPT_CPU_PROFILE`, `RISU_TRANSCRIPT_PROFILE_CASE`, and
  `RISU_TRANSCRIPT_DIAGNOSTICS` produce explicitly separate diagnostics.
- The direct-link manifest currently expands four registered batches into 44
  unique route cases. Lazy first-open loops additionally exercise settings and
  Playground route inventories; their title count is not a route count.
- Default runs use up to four local workers, one on CI; explicit
  `RISU_BROWSER_SMOKE_WORKERS` overrides the bounded default. Stateful cases
  remain ordered inside their spec; independent harnesses bind random ports
  and own temporary SQLite/data directories. Direct-link batches explicitly
  permit parallel execution.

## Common Fixture and Control Boundaries

The shared harness starts the real Fastify app, authenticates through the smoke
password flow, registers a temporary import writer, and imports handcrafted
RisuSave data through the real import route into disposable SQLite. It serves
`dist` over a random loopback port and closes/removes the owned data afterward.
Fixtures create preconditions; they do not prove UI authoring or original-app
serialization. Provider controls substitute deterministic external generation
responses while retaining the application coordinator, event stream, and storage.

Smoke-specific differences at this anchor: hook installation in
`src/appStartup.ts`; automatic fixed-password input in
`src/ts/storage/fastifyStorage.ts`; a smoke session-storage observer-shell
flag override in `src/ts/observerShellFlag.ts`; 100ms rather than 5s finalization
refresh in `src/ts/process/generationPersistenceState.ts`; disabled asset GC and
memory worker in the shared harness. Embedded harness exclusions need per-owner
review. These tests do not establish normal password prompts, worker timing, or
production refresh latency.

Hook classification is per caller:

| Control                                                                                                                                                                                                         | Role and limit                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getDatabaseSnapshot`, `getLifecycleSnapshot`, `getAppliedServerResourceRevision`, `getStartupSnapshot`, `getStartupCoordinatorSnapshot`, `getCurrentRoute`, `getRouteResourceLoadState`, `getRerollCandidates` | Observation of actual client projections; requires a DOM or authoritative API oracle for claims of visible/durable truth.                                     |
| `isLoaded`, `waitForLoaded`, `waitForStartupMilestone`                                                                                                                                                          | Readiness observation; `isLoaded` means background-ready, not evidence of a user action.                                                                      |
| `activeWriterHeaders`                                                                                                                                                                                           | Authentication/session setup for real route calls; does not prove the corresponding UI entry path.                                                            |
| `patchRuntimeSettings`                                                                                                                                                                                          | Real durable outbox action in command/recovery scenarios; unrelated setup when selecting display/test options. Does not prove a settings control was clicked. |
| `selectCharacter`                                                                                                                                                                                               | Direct local store setup; does not prove sidebar selection or durable navigation.                                                                             |
| `navigateTo`                                                                                                                                                                                                    | Real router action/setup; does not prove the navigation control was clicked.                                                                                  |
| `showAlert`                                                                                                                                                                                                     | Alert presentation action; does not prove progress-to-confirmation admission from an operation.                                                               |
| `setQuickSettingsOpen`                                                                                                                                                                                          | Direct UI-state setup; does not prove clicking the opener.                                                                                                    |
| `swipeRerollBack`                                                                                                                                                                                               | Production reroll action; does not prove a visible swipe/button entry.                                                                                        |
| `clearResourceCache`                                                                                                                                                                                            | Cold-cache setup; does not prove eviction behavior or durable persistence.                                                                                    |

The concrete caller map below captures all hook member references in specs at
this source. Source lines identify setup versus action call sites for Phase 1;
assertion contracts remain owned by the scenario records. Hooks imported only
through a local alias are included during the independent control cross-check.

| Spec                                       | Hook references (member: source lines)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acceptedSendProtocol.spec.ts`             | `activeWriterHeaders`: 729, 1086; `getDatabaseSnapshot`: 766, 1063; `getLifecycleSnapshot`: 1058; `isLoaded`: 705                                                                                                                                                                                                                                                                                                                                                        |
| `bardWikiLifecycle.spec.ts`                | `waitForLoaded`: 102                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `chatEntryLayout.spec.ts`                  | `isLoaded`: 92; `selectCharacter`: 94                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `chatHistoryScroll.spec.ts`                | `isLoaded`: 85; `waitForStartupMilestone`: 93                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chatStartupRendering.spec.ts`             | `waitForStartupMilestone`: 51, 97, 159                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `debugEchoLayoutStability.spec.ts`         | `activeWriterHeaders`: 193; `getDatabaseSnapshot`: 230, 241; `isLoaded`: 187                                                                                                                                                                                                                                                                                                                                                                                             |
| `displayPaintCache.spec.ts`                | `getDatabaseSnapshot`: 153, 164; `waitForStartupMilestone`: 80, 159                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fastifyBrowserSmoke.spec.ts`              | `activeWriterHeaders`: 240; `getDatabaseSnapshot`: 226, 311, 408, 459, 483, 519, 520, 555, 608, 633; `getStartupCoordinatorSnapshot`: 628; `patchRuntimeSettings`: 230; `selectCharacter`: 660, 750, 878; `showAlert`: 706; `waitForLoaded`: 196, 659, 1241                                                                                                                                                                                                              |
| `lazyFirstOpen.spec.ts`                    | `navigateTo`: 425, 532, 574, 645; `setQuickSettingsOpen`: 384, 388; `showAlert`: 459; `waitForLoaded`: 656                                                                                                                                                                                                                                                                                                                                                               |
| `rerollSwipePersistence.spec.ts`           | `activeWriterHeaders`: 191; `getDatabaseSnapshot`: 64, 98, 140, 154; `getRerollCandidates`: 131, 135; `selectCharacter`: 170; `swipeRerollBack`: 149; `waitForLoaded`: 50                                                                                                                                                                                                                                                                                                |
| `selectedLocaleRuntime.spec.ts`            | `getDatabaseSnapshot`: 47, 57; `navigateTo`: 15, 60, 97; `waitForStartupMilestone`: 14, 139                                                                                                                                                                                                                                                                                                                                                                              |
| `selectedLocaleStartup.spec.ts`            | `getStartupSnapshot`: 44; `waitForStartupMilestone`: 41                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `startupCachePopulationMatrix.spec.ts`     | `getStartupCoordinatorSnapshot`: 193; `getStartupSnapshot`: 201; `waitForStartupMilestone`: 189                                                                                                                                                                                                                                                                                                                                                                          |
| `startupDirectLinks.spec.ts`               | `clearResourceCache`: 69; `getCurrentRoute`: 87; `getRouteResourceLoadState`: 79; `waitForStartupMilestone`: 85                                                                                                                                                                                                                                                                                                                                                          |
| `startupRecoveryIntegrationMatrix.spec.ts` | `activeWriterHeaders`: 258; `getAppliedServerResourceRevision`: 143, 185, 256, 309; `getDatabaseSnapshot`: 96, 182, 285, 310, 475; `getLifecycleSnapshot`: 165, 179; `getRouteResourceLoadState`: 548, 557, 564; `getStartupCoordinatorSnapshot`: 317, 384, 400, 467, 488, 542, 567, 613, 644; `getStartupSnapshot`: 479, 643; `navigateTo`: 539; `patchRuntimeSettings`: 162, 373, 408, 414, 471; `waitForStartupMilestone`: 93, 140, 176, 253, 366, 392, 485, 520, 632 |
| `transcriptResidency.spec.ts`              | `activeWriterHeaders`: 826, 1772; `getDatabaseSnapshot`: 722, 1802; `isLoaded`: 1304; `navigateTo`: 585, 590, 871, 876; `patchRuntimeSettings`: 417, 636, 717, 760                                                                                                                                                                                                                                                                                                       |
| `visibleStateRecovery.spec.ts`             | `activeWriterHeaders`: 380; `getAppliedServerResourceRevision`: 370; `getDatabaseSnapshot`: 85, 125, 213; `patchRuntimeSettings`: 169; `selectCharacter`: 248; `waitForLoaded`: 244                                                                                                                                                                                                                                                                                      |
| `realmProgressConfirmation.spec.ts`        | `waitForStartupMilestone`: 313; hook installation is observed at startup. Both are readiness observations; import and confirmation use visible controls.                                                                                                                                                                                                                                                                                                                 |

## Per-Spec Discovery Boundaries

These are source-reviewed maps, cross-checked by independent read-only workers;
the pilot and strengthened rows have the linked focused fault evidence. A listed action is
what runs, not an assertion that every feature reachable from it is covered.
All browser commands use `pnpm test -- server/fastify/browser-smoke/<spec>` or,
after a matching smoke build, explicit Playwright selection in the same config.

| Scenario family                  | Fixture; actual action; independent oracle; remaining limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted send (S01–S11)          | Inline RisuSave fixture and controlled provider; visible composer/Stop/Retry/reload, dropped POST and viewer streams, job expiry/restart/finalization holds; DOM rows plus authoritative message/bootstrap APIs, operation IDs and provider counts. S01 now adds a completed-reply reload with exact operation/user/reply IDs and one provider invocation; BSE-003 records the fault proof.                                                                                                                                                                                                                                                                                                                                                                                 |
| BardWiki (S12)                   | Small imported fixture with two seeded turns; settings/workspace, document creation, confirmation, lifecycle tools and reload; request responses plus visible document/status. Does not prove generating the seeded turns or provider-backed memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Chat entry (S13–S20)             | Twelve imported rows, short/tall final body, held display-source request; direct URL or actual chat-row/recent-chat button (character selection is setup); skeleton then at least 30 readable frame samples and ≤1px start displacement. Does not prove mutation/durability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| History (S21–S22)                | Imported 300-row transcript with wrapping text, static rich content and tall rows; real CDP gestures/wheel overlapping real page requests and queued parsing; nonempty readable pauses, stable IDs/positions, first row reached/remains, logical/resident bounds. See P0-T; simulated Chromium input only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Startup rendering (S23–S25)      | Small fixture with display plugin or twelve messages; real startup/reload with held dependency/display requests; skeleton, processed body, newest-before-older rendering and geometry. Deterministic plugin/data preparation is not plugin authoring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Debug Echo (S26)                 | Imported echo profile plus direct generation-settings setup; actual composer send and lifecycle event dispatch; waiting/provisional DOM, final client transcript projection and nonempty frame samples of control identity/focus/geometry. Fixed provider delay is a controlled precondition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Paint cache (S27)                | Imported custom display settings; warm reload with entry/shell/Display held independently; pre-bundle computed appearance and final hydrated values, sampled mismatches/errors. One appearance preset; cache is non-authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Mixed smoke (S28–S37)            | Fresh embedded harness per test. S28 uses real API actions and durable settings hook, storage interception observes writes. S29–S31 drive backup/settings/character/translator UI and accepted responses/reloads. S32 now uses three contexts for conservative writer/takeover and upgraded Reader continuity; see the Reader Phase 2 reconciliation below. S33 tests direct alert presentation and keyboard focus/screenshots. S34 assigns scroll/style as geometry setup. S35 mocks visualViewport and tests composer transitions/draft. S36 drives touch reorder with real requests. S37 opens/selects/reloads lorebook with request-count and stable-ID checks. S33 does not cover an operation reaching confirmation; full disposition stays partial until Phases 2/3. |
| Lazy boundaries (S38–S45)        | Imported personas/chats and emitted asset manifest; actual route/dialog controls plus hook-driven router/modal setup; chunk/CSS requests, visible ready/loading/recovery/focus/viewport checks. Includes 23 Settings and 15 Playground routes; proves loader boundaries rather than every route's domain behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reroll (S46)                     | Imported old reply/echo provider; UI reroll with operation POST and no truncation, reload then direct production reroll-back hook; reload-reconstructed tail and client candidates/DOM. Retain as candidate reconstruction/navigation evidence; pointer swipe remains unproved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Locale runtime/startup (S47–S50) | Small imported en/ko fixture and emitted locale lookup; language select, held/failed Korean asset, cold/reload startup; visible locale/composer label, no stale overwrite, retry and asset reuse. Startup loops en/ko × three repetitions × cold/warm; other language packs are not covered by this matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Cache population (S51)           | Small and generated large corpus; cold cache then warm reload; cache/protocol/request timing, payload differences and early mutation/generation counts. Four scenarios, no device/network diversity claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Direct links (S52–S55)           | Small imported fixture, observer shell disabled, cleared browser/resource caches; direct URLs for 44 manifest routes; current-route/resource-ready state and required/non-eager requests. No route-specific DOM oracle: classify as hydration routing, with visible route proof in lazy first-open companions.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Recovery integration (S56–S62)   | Small/large fixtures; startup flag matrix, sparse legacy SQLite setup, offline/drop-response durable commands, event-row deletion and SSE hold, mixed-version takeover, slow/failed background/inlay requests; readiness/telemetry, outbox identity/receipt/revision, refresh order, writer denial and localized Retry. Browser faults preserve real command/storage processing; direct SQLite corruption is controlled setup, not a production incident.                                                                                                                                                                                                                                                                                                                   |
| Residency (S63–S74)              | Transcript fixture and gated provider; initial/page/jump/stream/reload, screenshots, edits/selection/copy, failed/cancelled screenshots, editor limit/page reset, hidden-route jump cancellation, legacy paging and compact viewport. Uses real DOM/content with some direct scroll-position controls; those cases retain algorithm/interaction value and do not replace P0-T's continuous-input contract. Detailed scenario dispositions remain pending.                                                                                                                                                                                                                                                                                                                   |
| Visible recovery (S75–S77)       | Imported two-chat/preset/toggle fixture; real chat rows, toggle and character sidebar clicks; visible selection/settings through accepted resource refresh, then held durable settings request and imported lineage/reload; request lineage/revision, new document identity and retained DOM/sidebar. S77 is P0-R; settings hook is the durable action, not settings-UI evidence.                                                                                                                                                                                                                                                                                                                                                                                           |

## Phase 0 Calibration and Remaining Slices

P0-C (Realm queue), P0-T (transcript), and P0-R (old-lineage recovery) are recorded
in [findings](findings.md#phase-0-calibration). The selected recovery case is the
plan's explicit `visibleStateRecovery.spec.ts` alternative: its delayed real
command response proves lineage handling and same-entry recovery, not generation
acceptance. The independent worker's accepted-send suggestion remains a Phase 2
candidate; it is not substituted for executed evidence.

The three pilots required separate build/fault/restoration runs; a history
reversal takes about 37s and its isolated two-repeat check about 80s. Shared
artifact integrity is one bounded Phase 1 repair; hook/fixture classifications
need consumer cross-checks, not wholesale fixture rewrites. Phase 2 proceeds as
four independent contract slices, starting with send/completed reload and stale
recovery. Confirmation requires a new real-operation browser journey. Phase 3
can group remaining work by locale/lazy startup, memory/settings/navigation, and
residency interactions. The initial 4–8 engineer-day estimate remains a sizing
range, with full-suite execution at every phase adding explicit fixed cost;
no estimate waives evidence or allows acceptance from discovery alone.

## Phase 1 Shared-Control Dispositions

Reviewed against implementation `711b1d583` / inventory commit `7399389f9`.
Unchanged helper consumers passed Phase 0's 77-case browser run. Changed helper
consumers require new focused and final-source aggregate evidence below.

| Shared owner or control family | Disposition and independent check                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared harness and auth        | Retained: authenticates and imports through real Fastify routes/SQLite; each harness owns a random origin and temporary data. The fixed password bypasses password-entry UX, not server authentication. Import fixtures establish data only. Harness failures reject rather than inventing setup success.                                                                                                                                                   |
| Embedded harnesses             | Retained: accepted-send, transcript, and lazy harnesses disable GC/memory workers; mixed smoke, visible recovery, and reroll disable memory workers but retain default GC. None certifies worker/GC timing. Mixed-smoke is fresh per case; accepted-send uses stable separate chat IDs per scenario, visible-recovery has ordered shared fixture state with distinct UI actions.                                                                            |
| Fixture producers              | Retained: small/large imported RisuSave fixtures, deterministic transcript rows/assets, and inline echo/provider setup preserve routes, parsing, serialization and storage where claimed. They do not prove UI authoring or pre-Fastify serialization. English constants are independent assertion labels; locale manifest lookup rejects missing emitted packs and its MutationObserver only observes the first composer.                                  |
| Smoke hook/types               | Retained with the per-caller map above. Read-only snapshots clone real client projections; authoritative APIs/DOM remain separate oracles. Settings patches use the real durable outbox. Navigation/reroll helpers call actual production functions, with UI-control/gesture bypass stated. Direct setters are setup, never evidence of a successful durable mutation.                                                                                      |
| External faults                | Retained: response aborts after `route.fetch` preserve server commit; held requests/responses preserve application processing; provider gates hold incremental output rather than supplying client completion; SQLite event deletion creates a replay gap. Offline/visibility/viewport/clipboard overrides each have a bounded browser/algorithm claim, not device equivalence.                                                                             |
| Wait and render helpers        | Retained: Playwright waits reject if their response/condition never arrives; transcript `waitForRenderedRows` requires connected, nonempty readable rows, ready images and stable identities across settling frames; `scrollToOlderEdge` throws without a visible anchor; snapshots reject missing supplied anchors. Debug-Echo spread requires finite nonempty samples and its controls/row-instance checks prove relevant sample presence.                |
| Paint-cache frame sampling     | Strengthened as BSE-004: each held phase must produce an actual sampled frame before release. Direct computed-style checkpoints remain independent. Its one changed browser consumer gets focused pass/fault/restoration evidence.                                                                                                                                                                                                                          |
| Direct-link discovery          | Retained as hydration/routing coverage: 44 unique manifest routes, cache clearing, real navigation, required and non-eager requests, final route/resource-state assertions. The lazy first-open route matrix supplies visible ready-state companion coverage. No claim that direct-link metadata alone proves every rendered screen.                                                                                                                        |
| Integration artifact reader    | BSE-001 verified repair. Required completeness/provenance is distinct from valid partial diagnostics; nested payload and manifest identities must match before writing final success outputs.                                                                                                                                                                                                                                                               |
| Execution/CI                   | Retained: focused runner builds and runs one selected spec; agent aggregate builds only; full command builds and executes all default browser cases and requires the integration merge. CI runs that full command and uploads partial/final integration, startup-matrix and Playwright diagnostics even after failure. Independent matrix/locale artifacts belong to their own producer invocations; they are not inputs to the required integration merge. |

No wholesale fixture migration or synthetic-input removal is needed. Direct
geometry assignments, custom visualViewport/clipboard behavior and synthesized
lifecycle events remain useful with the specific limits above. Per-scenario
unreviewed interactions remain for Phase 3; shared control classification is not
whole-file acceptance. Phase 2's progress-confirmation, completed-send reload and
stale/durable contracts remain required and are not closed by this table.

Behavior-driving hook distinctions at the Phase 1 source:

| Caller                                                        | Concrete role                                                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed-smoke runtime patch at line 230                         | Durable command action under test; settings input itself is not exercised.                                                                                                                                  |
| Visible recovery runtime patch at line 173                    | Durable action creating the held lineage-tagged request; sidebar navigation is driven through real controls.                                                                                                |
| Recovery integration patches at lines 162, 373, 408, 414, 471 | Respectively real offline/lost-response action, reader-denial probe, revoked-writer-denial probe, promoted-writer action, and background-readiness mutation probe. None assigns recovered state.            |
| Residency patches at lines 417/636 and 717/760                | First pair configures editor/copy preconditions; second pair is the actual page-reset action whose row/reservation outcome is asserted. Settings UI is outside these claims.                                |
| Residency router calls at lines 585/590 and 871/876           | Actual hide/reopen transitions for screenshot cancellation and pending-jump cancellation, not proof of a navigation button.                                                                                 |
| Lazy router, alert and quick-settings calls                   | Actual lazy route/component admission transitions; originating navigation/opener/operation UI is bypassed. The test separately checks emitted requests, mounted surfaces, focus and failure/retry behavior. |
| Reroll-back hook at line 149                                  | Actual production candidate-navigation function, not a pointer gesture. Buffer observation is read-only and separate.                                                                                       |

Source line references above are anchored to `7399389f9`; renamed/changed calls
must be reconciled during the reader handoff and final audit.

## Critical Contract 2d: Stale Responses and Recovery

Reviewed at `e503af81f`; production recovery/routing owners are unchanged from
P0-R's `711b1d583` fault source. Phase 1's final 77-case browser run re-executed
all these unchanged callers after the artifact repair. The 2c restored
accepted-send run additionally executes its eleven cases at the new test source.
These linked results are reused rather than mislabeled as new focused runs.

| Scenario                                             | Real path and independent outcome                                                                                                                                                                                                     | Disposition / companion limit                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S77 old-lineage recovery                             | Actual chat/sidebar clicks, durable outbox settings command held at transport, real import, conflict response and new-document reload; imported revision/chat identities and the user's newer sidebar choice agree in the visible UI. | Retained; P0-R's omitted production view-restoration fault fails the visible assertion after authoritative recovery. `router.test.ts`, `resourceRefresh.test.ts`, and replacement/outbox tests cover finer stale-response/lineage permutations. |
| S58 offline-before-send / response-lost-after-commit | Browser offline or abort after real upstream commit; outbox admission/retained mutation ID, reload replay, exactly one revision increment and one receipt acknowledgement.                                                            | Retained durable replay contract; hook dispatch is the actual command, not UI settings input. S76 separately proves the visible toggle survives accepted command/resource refresh.                                                              |
| S59 event gap                                        | Real events connection and command mutation, controlled removal of one SQLite event, reconnect held until replay rejection; four authoritative resource reads finish before live reconnection and applied revision/value recover.     | Retained ordering contract. Event deletion is the explicit fault precondition, not a fabricated recovered store. Resource-refresh/event units cover supersession and failed reads without advancing cursors.                                    |
| S60 and S32 writer denial/takeover                   | Distinct browser contexts, actual takeover UI/handshake; observer and revoked writer submit no commands, promoted writer has one accepted command.                                                                                    | Retained current conservative/partial-observer behavior. Reader Phase 2 replaces the upgraded old-writer expectation with connected reading while retaining the legacy companion; see its reconciliation below for current evidence.            |
| S02 lost operation acceptance response               | Real composer POST is fetched upstream then aborted to the browser; foreground recovery finds the accepted operation/job, visible partial and one canonical completed reply, one provider call.                                       | Retained unknown-outcome recovery; bootstrap/SSE may mask a simplistic retained-to-rejected fault, so that unexecuted suggestion is not claimed as proof.                                                                                       |
| S05 restart, S08 viewer loss, S09 expired replay     | Actual harness restart or detached observer/expired job, durable operation identity and canonical final content remain; Retry/reattach stays exact and bounded.                                                                       | Retained three distinct recovery contracts; provider/job controls replace external conditions, not client reconciliation. Real browser-process crash remains outside scope.                                                                     |
| S10 two chats                                        | Real UI navigation and composer sends; concurrent jobs remain scoped to stable chat IDs and each provider runs once.                                                                                                                  | Retained cross-chat isolation; not concurrent-writer editing.                                                                                                                                                                                   |
| S11 queued finalization                              | SQLite finalization hold creates a real queued provisional result, survives full reload, then settles to canonical messages with empty pending lifecycle state.                                                                       | Retained pending/settled durability; 100ms smoke refresh differs from production's 5s interval.                                                                                                                                                 |

The required named browser fault for 2d is P0-R, with its independent path
observations, failed stale-view restoration and passing restored spec. Current
readiness, revision/lineage ordering, outbox identity and exactly-once boundaries
have faithful owners; no demonstrated high-risk gap is waived. Deep crash,
quota, real-device and live-provider conditions retain their original explicit
limits. Reader work will change several of these owners; this acceptance is
limited to the current implementation and is not advance certification of it.

Other accepted-send variants reviewed for 2c: S03 uses visible exact Retry and
billing confirmation without duplicating the accepted user; S04 repeats the
mid-generation reload under Pixel emulation; S06/S07 hold Stop acknowledgement,
observe Stopping, persist one cancelled partial, and assert no success effects.
The unchanged per-scenario controls remain distinct from S01's strengthened
completed normal-send identity proof.

## Critical Contract 2b: Transcript Input and Rendering

Reviewed at `99089a17b`. The transcript/parse/layout production sources have not
changed since the P0-T fault experiment at `711b1d583`. The fixed two-repeat
history run and Phase 1's final full-browser passes apply to these unchanged
boundaries. This source review does not claim a new browser execution.

| Scenarios                       | Precondition, real path and nonempty oracle                                                                                                                                                                                                                                                                                                       | Disposition / limits                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S21/S22 history                 | Thirty real processed initial rows; actual wheel/gesture input continues through older-page fetches, queued parses, remounts, reversals and pauses. Logical IDs, readable content, viewport-relative positions, first-message reach/retention and maximum 76 resident rows are independent observations. Readable pause anchors must be nonempty. | Retained critical owner; P0-T's cached-height omission fails visibility/anchoring in both repetitions and clean restoration passes. It does not assign scroll position or inject measured heights.                                                                  |
| S13–S20 entry matrix            | 390/1280px × direct/chat-list × short/tall final messages; a real display-source request is held while the skeleton is visible. Release produces at least 30 readable frame samples; every sampled visible frame starts within 1px of the last-message beginning.                                                                                 | Retained entry coverage; character selection is unrelated setup, chat selection uses the actual control. Native devices and continuous scrolling are separate claims.                                                                                               |
| S23/S24 display dependencies    | Direct versus refreshed startup with real plugin/display processing and held dependency resources; raw body stays hidden until the dependencies arrive and processed text remains through background readiness.                                                                                                                                   | Retained parsing/startup composition; deterministic fixture plugin and network gates do not prove arbitrary plugin authoring.                                                                                                                                       |
| S25 newest-before-older         | Hold older display-source requests, prove one held request and twelve mounted logical rows, render newest text before older text, then release older rendering; newest row remains at the viewport start.                                                                                                                                         | Retained prioritized startup/layout contract; settled geometry checks complement P0-T's input-overlap samples.                                                                                                                                                      |
| S63/S64 base residency          | Real imported messages/local images, staged older-page loading, bookmark navigation, reload, provider-gated send/stream/finalization, actual row and DOM/heap measurements. Snapshot helpers reject missing explicitly supplied anchors; late-media resize reports the available anchor measurement.                                              | Retained bounded-row and interaction/cost observations. Direct older-edge assignments and scripted media resize isolate those algorithms; they do not replace P0-T's actual-input proof. Larger opt-in cost/profile matrices remain unexecuted in the default lane. |
| S73 rapid movement              | Real parsed text and real residency scheduling; assigned scroll positions create a controlled rapid-motion workload. At least one newly admitted readable row appears while busy, and every sampled readable row's UUID/text matches its logical index.                                                                                           | Retained scheduler/visibility coverage with nonempty relevant samples; direct scroll assignment is an explicit limit.                                                                                                                                               |
| S74 compact viewport            | CSS creates 20px rows while preserving parsed message text. After controlled scrolling, working-window expansion covers the actual viewport with readable rows and preserves the ordinary resident bound.                                                                                                                                         | Retained compact-geometry allocation test, not proof of a particular compact-settings UI or physical viewport.                                                                                                                                                      |
| S34 mixed-smoke spacer geometry | Controlled scroll/style geometry tests zero/expanded latest-message spacer behavior while free-scrolling.                                                                                                                                                                                                                                         | Retained narrow geometry companion; no claim of continuous input/remount fidelity.                                                                                                                                                                                  |

Production ownership remains `ChatBody.svelte` registering parsing before
background scheduling and settling only after committed HTML, plus
`Chats.svelte` holding returning wrappers at their measured height until the
registration settles and viewport correction runs. Component tests in
`ChatBody.svelte.test.ts` and transcript geometry units protect scheduling and
calculation details; their fabricated geometry is not used as browser proof.

The 2b critical contract is verified with the unchanged P0-T fault and restored
browser evidence. Screenshot materialization/cancellation, editor/selection/copy,
page-reset pins, hidden-route jumps and legacy paging (S65–S72) remain explicit
Phase 3 scenario reviews; the residency file is therefore still partial. Reader
changes to supported transcript entry/rendering require the planned Stage 3
reconciliation and fresh affected browser evidence.

### Generation Companion Claim Corrections

At `736fbe490`, S26's final response helper reads the client projection; it does
not independently fetch the final messages API. Retain S26 as transient layout,
focus/opacity and DOM-identity evidence with real composer/generation/SSE, and
use S01 for the complete visible/authoritative/reload durability contract.
S46 now drives the actual message reroll button and asserts the operation POST
without truncation, then rebuilds candidates after reload and calls the
production reroll-back helper. Retain it as candidate persistence/reconstruction
and navigation evidence, with the final pointer gesture explicitly unproved.
Current test/architecture guides now state these actual paths. No test or
production change is needed to correct these documentation claims; Phase 1's
passing browser run applies to the unchanged specs.

## Critical Contract 2a: Operation Confirmation

S78/S79 replace the missing browser-operation owner, with the exact fixture,
path/oracle and production-fault evidence in
[BSE-002](findings.md#bse-002-real-operation-browser-proof). The actual trigger is
visible Realm URL/ID import through its warning/input/Terms controls; the only
substituted service is the external HTTP catalog/CharX source. Its held byte
stream is a timing precondition, and its low-level flag is real input to the
server importer. No alert queue, parser, pending token, import result or durable
outcome is supplied by the test.

New inline controls are classified: local HTTP/ZIP builders and empty RisuSave
import are setup; download release is external timing control; POST listeners,
read-only SQLite/API reads and the forwarding raw-write recorder are observation;
Realm controls and YES/NO are the actual user actions. All servers, contexts and
temporary data are owned and cleaned up, including setup failure. The recorder
preserves transport callbacks, encodings, this binding and return values.

Both browser variants protect progress-to-confirmation admission, pending/no
premature import, and answer-specific continuation. The accepted variant also
protects token reuse, one external download, stable imported ID and durable
reload; rejected input remains usable with unchanged storage. Stale low-level
server responses while a newer import owns progress remain the explicitly
component-level real-queue companion. The required browser admission fault
fails both new cases at the intended dialog assertion and restored behavior
passes. S33 remains alert presentation/focus/screenshot coverage; it is not
relabeled as operation confirmation.

## Reader Phase 2 Smoke Reconciliation

Production source `81efb67c3` adds connected browsing behind the still-disabled
public flag. S80 adds one registered case; S32 and S60 are materially updated
existing cases. The required full gate also exposed S22’s pause-sampling gap;
its bounded BSE-005 repair retains the registered case and input workload. The default universe is 80 cases in 19 specs, with no removal.
Final browser/fault/aggregate evidence belongs to
[reader status](../connected-read-only-clients/status.md#phase-2-implementation-2026-09-07)
and the [fault record](findings.md#reader-phase-2-production-fault-evidence).
This is a Stage 2 handoff update, not acceptance of the remaining smoke audit.

| Scenario/control                          | Action, independent observation and disposition                                                                                                                                                                                                                                                                                                                                                                    | Remaining limit                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S22 pause sampling                        | At `9387d1464974`, two fixed real-input passes preserve the original pause/geometry oracle and add a proven ordinary-row unmount/remount. BSE-005 records the original coverage gap, independent cache-owner fault detection and restored controls; all original input/visibility/geometry bounds remain.                                                                                                          | Final baseline/fault/restored pairs passed their intended outcomes, then test:agent and all 13 test:all lanes passed. S22 passed in 44.9s in the full suite; the cache-owner fault proves remount readability while the earlier geometry candidates remain unqualified. |
| S80 `connectedReaderBrowsing.spec.ts`     | New actual Fastify/SQLite startup with initialized unowned data: writer A acquires, separate mobile Reader B does not. A same-context tab with copied session storage gets a distinct ID through real Web Locks; legitimate writer reload retains ID/epoch. A real authenticated command appends a message; B visibly renders its exact ID/text with zero forbidden requests and SQLite event-origin proof.        | Writer append is an authenticated command invoked from the browser, not composer/generation UI. Full live generation remains reader Phase 4.                                                                                                                            |
| S80 read/local browse subjourneys         | Actual wheel input fetches and displays older history. A selects another character/chat through real sidebar UI; B stays on its own URL. B navigates, uses the actual mobile copy button/clipboard, goes Back/Forward, reloads and focuses. Writer URL and the complete compared SQLite domain snapshot stay identical during reader-only actions. Composer is disabled and retry mutation affordances are absent. | Chromium Pixel 7 emulation with real clipboard permission; no physical-device or alternate-engine claim. Text selection behavior also has mounted/shared transcript companions.                                                                                         |
| S80 interruption                          | BrowserContext offline control triggers real browser lifecycle/network behavior. B reports interrupted last-known content; A commits another message; B reconnects from applied state and displays the commit. Ownership remains unchanged. Final request log, durable snapshot and screenshot are attached even on failure.                                                                                       | Network disconnection is deliberately controlled. Auth/lineage/replay-gap races are tested in focused runtime suites and existing recovery browser companions.                                                                                                          |
| S80 request control                       | BrowserContext request observation includes service-worker requests. GET/HEAD/OPTIONS are reads; exact server-declared cache/display POST routes and authentication/diagnostic/startup telemetry are explicit non-domain exceptions. Any writer-session header on bootstrap/events is forbidden, including an empty header. No broad resource POST exemption exists.                                               | This proves observed transport and compared durable domain state for this journey; it is not a claim that arbitrary future POST routes are reader-safe. New routes require an explicit audit before allowlisting.                                                       |
| S32 legacy companion                      | Three independent contexts: conservative writer A, upgraded Reader B and conservative takeover C. C uses the existing Disconnect confirmation; A retains the frozen legacy choice. B keeps its subscription through initial and changed foreign-writer frames, then visibly receives C's accepted character rename. B's attempted mutation remains denied and no writer bootstrap originates from B.               | Deliberately preserves old-client semantics. It does not substitute for upgraded explicit promotion, assigned to reader Phase 3.                                                                                                                                        |
| S60 mixed demotion                        | Upgraded A starts from an unowned normalized fixture; conservative C is denied before authority, explicitly confirms Disconnect and becomes writer. Old A becomes a connected Reader with routes available and no old offline prompt. A cannot mutate; C's accepted settings command reaches A's loaded resource projection.                                                                                       | The settings convergence oracle uses the smoke resource snapshot because the former writer already loaded that group. S80/S32 provide separate visible transcript/character oracles. A → B → A drafts and pending edits remain reader Phase 3.                          |
| `fastBootstrapHarness.ts` unowned fixture | The new `unowned-migration` seed mode uses `normalizeRisuSaveSnapshotDatabase`, then proves null owner/epoch zero before browser acquisition. It does not leave the temporary import writer behind. Existing `writer-import` mode remains for conservative/direct-link tests. Reader fixture supplies stable message/character/chat IDs and explicit greeting metadata.                                            | Direct SQLite seeding is fixture preparation; the actual acquisition, subscriptions and reads are production browser/server paths.                                                                                                                                      |
| Integration artifact                      | S60 retains `denial-then-takeover`; startup flag matrix and all required payload identities retain the Phase 1 artifact schema. Enabled startup can publish an authenticated coherent preview while delayed acquisition still blocks ordinary writes.                                                                                                                                                              | Required complete artifact production is checked by the full browser lane; isolated spec output is intentionally partial and cannot claim the final merged artifact.                                                                                                    |

Stage 3 must retain this changed-source boundary when reviewing earlier Stage 1
claims. Unchanged source contracts may reuse their evidence with its original
limits; changed role/synchronization assertions require the new fault and final
browser results above.

### S22 remount oracle maintained during Reader Phase 2

At `9387d1464974`, S22 preserves the original readable sample-zero pause anchor,
all 1px geometry/visibility bounds, and continuous real-wheel/full-history
checks. Its fixed second pass revisits recently measured history. Before the
return, it requires ordinary message 298 to be unmounted; fixed real return
input must restore its text and visible intersection. There is no adaptive
retry or future-surviving anchor selection. The nonempty pause guard follows
all independent assertions. Passive script receipts and console diagnostics
are attached for fault provenance and do not determine the oracle.

[BSE-005](findings.md#bse-005-pause-sampling-misses-readable-anchors-after-hydration)
records the original full-suite coverage failure, rejected proposals, final
baseline, separately declared cache-owner fault and restored controls. This adds
an explicit remount check to S22 without changing the 80-case/19-spec discovery
universe. The original P0-T evidence keeps its earlier source limit; the new
fault proves cache handoff on remount, with geometry still checked by S22.

## Reader Phase 3 Smoke Reconciliation

Source: `7c3da2160`; three new cases extend discovery to 83 cases in 20 specs.
The public flag remains disabled. The complete three-case baseline passed in
9.9s; production-fault and restored controls are recorded in
[findings](findings.md#reader-phase-3-production-fault-evidence), with aggregate
acceptance in [reader status](../connected-read-only-clients/status.md).
No existing case or integration artifact identity is removed or renamed.

| Scenario/control             | Real boundary and independent oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Scope and limits                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S81: A → B → A               | Separate browser contexts use actual **Use this device** and confirmation controls. SQL owner/epoch, stale 423 responses and accepted current-writer commands establish authority. Reader updates and local routes stay usable; time origin and document requests prove no reload. A types an unsent composer draft, sees it in Saved local edits after demotion, and restores it on return; B cannot see it.                                                                                                                       | Draft/route/ownership UI composition. Held uncertain intent, late receipt cleanup, retained unreadable work and superseded recovery use the focused real-outbox/coordinator companions.                                                                                                                                               |
| S82: held durable generation | Actual composer/send UI starts one deterministic local provider invocation and a real durable operation/attempt/job. After actual B takeover, SQL still names the same running job and attempt. Release creates one completed attempt and exact canonical result on both clients, with no cancellation request or provider abort.                                                                                                                                                                                                   | The `generationChat` dependency controls only external provider execution. It does not seed operation rows or forge stream/completion responses. This proves durable survival; live reader partial/effect behavior remains Phase 4. Terminal completion correctly clears `current_attempt_no` while preserving the completed attempt. |
| S83: empty first run         | `databaseSeedMode: empty` performs no import and creates no `db.json`. SQL checks absent settings, zero domain rows, revision/projection epoch zero and null owner. With Web Locks absent, a copied previous ID stays metadata and a fresh identity is installed. No acquisition/initialize request occurs before the actual setup click; afterwards one initialization event/settings object, writer epoch one and HTTP 200 writer stream establish startup. A foreign deny-only bootstrap returns 409 without changing ownership. | Browser API override supplies the unsupported Web Locks environment. Actual pre-shell UI, conditional acquisition, initialization and SQL are production paths. The initialization event can have null origin because persistence precedes writer-origin assignment; header and owner assertions independently prove the actor.       |
| Shared harness additions     | Optional typed `generationChat` forwards a controlled provider; empty seed mode omits fixture import and checks empty durable state. Existing default initialized fixture behavior is unchanged.                                                                                                                                                                                                                                                                                                                                    | Harness audit is scoped to these options. They do not pre-complete the action under test or bypass server writer guards.                                                                                                                                                                                                              |
| Observation and artifacts    | Context-level request/response logs, browser errors, SQLite snapshots and provider state are saved before teardown, including on failure. Console/source-chunk evidence distinguishes executed production faults.                                                                                                                                                                                                                                                                                                                   | Read-only smoke snapshots observe capabilities and scoped drafts; UI drives role changes, sending and setup. Chromium single-worker controls use the emitted build.                                                                                                                                                                   |

All three exact production faults fail after their named startup/action
preconditions. The unchanged final clean-build controls pass 3/3 in 10.0s.
Stage 3 must reconcile these additions with subsequent reader viewer/rollout
changes; this record does not accept the remaining smoke Phase 3 scenarios.

## Reader Phase 4 Smoke Reconciliation

Source `40b3eb516` adds five cases and one shared generation harness; the public
flag remains disabled. The initial four-case run at `a45fa4b39` failed all four
cases. Its actual runtime defects and test-contract corrections are recorded in
[reader status](../connected-read-only-clients/status.md#phase-4-implementation-2026-09-07).
The final five-case baseline passes in 49.2s after the recorded production and
assertion corrections. All six exact production faults fail their intended oracles, and the unchanged
five-case restored control passes in 51.1s. Both phase-ending aggregate gates pass at that implementation, as recorded in
reader status.

| Scenario/control                     | Real path and independent oracle                                                                                                                                                                                                                                                                                                                                  | Scope and limits                                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S84: partial and canonical reply     | Actual composer/send starts one local controlled provider and durable operation/attempt/job. Both writer and Reader must visibly show the held partial, then exactly one canonical result with its persisted identity. SQL operation/attempt/message/event and seven effect rows are checked independently.                                                       | One selected ordinary chat. Continue/regenerate, half-stream replay, EOF and changed descriptor/attempt/lineage use the focused transport/coordinator/mounted companions.                                                                                                       |
| S85: chat-switch/close/reopen        | With two real viewers and the provider held, B opens another chat through UI, closes its context, then reopens a fresh reader. Registry counts, actual routes/visible partials and one running SQL job prove each detach/attachment; release gives the same canonical result.                                                                                     | Browser context closure and UI chat switching are real. Registry counts are read-only server observations. No cancellation request or provider abort is allowed.                                                                                                                |
| S86: transfer and Stop               | Actual A→B confirmation and SQL epoch 2 precede B's Stop click. The provider holds its abort acknowledgement while another UI transfer occurs. SQL stopping/terminal identity and one stopped partial prove the final outcome, with no completion effects.                                                                                                        | Stop is the existing PUT cancellation route. The original failure reproduced missing local cancellation state after bootstrap; current code handles that state.                                                                                                                 |
| S87: queued finalization and effects | A scoped SQL failure trigger blocks only the real journal's canonical message insertion after provider completion. Actual UI transfer occurs while the job/journal is finalizing; removing the trigger allows one result and exact effect rows. Enabled retained IGP executes its real server completion request and one targeted text command under B.           | The trigger supplies a persistence fault and creates no journal/result/effect rows. Built-in echo IGP is deterministic; no paid provider runs. Configured SQL settings remain independently visible throughout.                                                                 |
| S88: accepted IGP response loss      | `route.fetch` sends the real IGP PATCH and holds only delivery of its original response. SQL must already show one suffix, message.updated, command receipt and completed IGP claim. Actual A→B, late response release, B→A and Reader Refresh preserve that exact result and receipt.                                                                            | One logical mutation may replay only with identical mutation ID/body and no new revision/event. Existing generated-translation/plugin/IGP receipts remain immutable; only pending effects may settle under B. No second IGP execution or reader effect/control call is allowed. |
| Shared controls and provenance       | The helper seeds initialized unowned data, forwards the local provider dependency, observes dispatch-time lifecycle plus headers/body, reads SQLite and viewer counts, and saves artifacts before cleanup. Recovery writes are allowed only under actual SQL writer authority; the response-loss case narrowly matches its independently accepted command replay. | Pure-read POST exceptions are exact existing routes. Bootstrap/events/generation-viewer reads carry no writer header. Request URL/status matching to emitted hashes is source attribution, not an independent hash of network response bytes.                                   |

All new cases retain actual rendered outcomes and durable state assertions;
capability hooks and provider/gate logs supply prerequisites and attribution.
The production-fault protocol separately targets partial display, canonical
handoff, viewer cleanup, promoted Stop, configured recovered IGP and atomic IGP
completion. All six meet their declared preconditions and fail the intended oracle, then
pass the shared unchanged restored control. Detailed provenance is recorded in
[findings](findings.md#reader-phase-4-production-fault-evidence). Final acceptance belongs in reader status; smoke Phases 3–4 stay
pending until the completed reader handoff.

## Reader Phase 5 Smoke Reconciliation — In Progress

The three-case TRUE baseline at `4dfac6c1e` passes, but the first full enabled
cohort is 80/90. Its exact failures and source-backed fixes are in
[reader status](../connected-read-only-clients/status.md#phase-5-enabled-build-baseline-and-integration-repairs).
S80 now keeps its copied-identity Reader connected through the shared commit,
independent navigation/commit and the other Reader's offline catch-up. S89
restarts Fastify/SQLite in place and observes actual native SSE closure,
reconnection and teardown. S90 uses real Popup Editor save-on-close, an accepted
response held across reload, a native encrypted outbox row, exact same-ID replay,
one receipt ACK and a newer actual composer draft. These controls observe
production boundaries; they do not seed draft/intent or simulate persistence.

S91 observes new-lineage Reader replacement before releasing the old command's
409, proves same-document/no-acquisition behavior, then uses the real explicit
same-owner recovery action before the original sidebar oracle. S77 separately
retains the original forced-reload contract in conservative mode. Direct SSE
frame consumption in S91 is inferred from source and subsequent reads; the
import response's actual `state.imported` event is captured. Final focused,
full-browser and declared fault/restored verification are still pending.

The corrected source `22da08cd1` supersedes those pending baseline results:
all 28 affected cases, the legacy companion and full 91-case TRUE suite pass.
Five isolated production faults qualify, and the unchanged restored S80/S89/S90/
S91 cohort passes. [Reproduction and source limits](findings.md#reader-phase-5-production-fault-evidence)
include exact second-Reader, restart, intent replay, draft and sidebar oracles.
`70a8b18e1` now enables connected readers by default; normal/FALSE build checks
and the reader phase's final aggregate gates remain pending. This is not the
Stage 3 handoff or acceptance of the still-pending remaining scenario reviews.

Normal and actual compiled-FALSE verification now pass at `a394b1310`:
S89/S90/S91 use null initial overrides in the normal build; the FALSE S90 variant
removes the override before real conservative reload and retains exact command,
receipt and newer-draft behavior. The restored normal emission matches all 503
original files. [Build proof](findings.md#reader-phase-5-default-and-fallback-build-proof)
retains the command/environment and fixture limits. Final reader aggregate gates
and the subsequent Stage 3 scenario review remain pending.

The required reader Phase 5 full gate at `90069ac9c` is **89/91**, with all
other twelve lanes passing. S47's actual route race has a production App repair
and the new S92 held-asset browser companion; S22 retains its full workload and
adds a prepared measured pause at the existing proven remount boundary. The
[final-gate repair record](findings.md#reader-phase-5-final-gate-repairs) reopens
BSE-005's sampling acceptance and records BSE-006's startup route cause. Prior
faults remain qualified only for their named source and oracle; renewed combined
controls and final aggregate gates are still pending.
