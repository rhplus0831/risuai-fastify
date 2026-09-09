# Read-Only Shell Parity Status

## Final Cursor

- State: **Complete and archived; all three phases are accepted.**
- Next action: none. The implementation, focused validation, browser proof,
  documentation, and plan archival are complete.
- Implementation revision: `01ed1f9b7` (runtime through `8a3ef57f1`).
- Source baseline reviewed: `d548d2643089`.
- No protocol, API, SQLite, command, SSE, outbox, or migration change was
  required.
- The full suite was intentionally not run under Crunch Mode; the focused final
  owner set and both selected browser-smoke files passed.

## Document Map

- [PLAN.md](PLAN.md): stable contract, boundaries, phases, and completion
  criteria.
- [Active plans](../../../docs/plan/README.md): current planning index.
- [Prior read-only app UX](../read-only-app-ux/status.md): completed
  feature/presentation work retained by this implementation.
- [Prior connected-reader lifecycle](../connected-read-only-clients/status.md):
  completed authority and synchronization foundation retained by this
  implementation.

## Phase Ledger

| Phase                                                | State    | Acceptance evidence                                                                                             |
| ---------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Geometry contract and regression harness          | Accepted | Canonical matrix and legacy mismatch fixture; certified column projection; semantic hooks and diagnostic helper |
| 2. Shared shell and bottom takeover action           | Accepted | One role-neutral frame, one geometry resolver, no reader top row, and one bottom action across reader routes    |
| 3. Transition stability, browser proof, and closeout | Accepted | Explicit-cause motion, 0 px sampled handoff delta, seven passing browser journeys, current docs, and archive    |

## Final Architecture Decisions

- `ConversationShell.svelte` owns the role-neutral outer flex frame, navigation
  slot, main-content column, and responsive dialog behavior. Reader and writer
  controllers remain separate and supply explicit snippets and callbacks.
- `shellGeometry.ts` is the canonical size model. The settled writer geometry
  remains the reference; reader presentation consumes the same resolver rather
  than a second formula or breakpoint.
- The shell resource was already sufficient. The reader projection now admits
  its certified `desktopSidebarColumns` and `mobileSidebarColumns` fields while
  preserving pending/auth/lineage isolation.
- `ReaderTakeoverAction.svelte` owns the only **Use this device** control plus
  localized read-only/lifecycle/result announcements. It is bottom-aligned on
  conversation and non-conversation reader routes; the old reader header and
  transcript duplicate are removed.
- `sideBarTransitionCause` admits entry/exit animation only for explicit user
  open/close actions. Startup, role resolution, promotion, demotion, reconnect,
  and recovery establish final geometry without mount-triggered animation.
- The responsive reader drawer remains mounted while hidden so local search and
  folder state survives close/reopen. Its modal focus trap is active only while
  visible. The writer drawer keeps its prior conditional mount behavior.
- Animation-frame rectangles are the primary role-transition oracle.
  Performance Observer layout-shift entries are retained as supporting evidence
  because entries near a takeover click can have `hadRecentInput: true`.

## Geometry Contract And Baseline Regression

The canonical responsive boundary is `width <= 1024` CSS pixels. A rail column
is 5 rem. Desktop column input normalizes to 1–4; responsive/mobile input
normalizes to 1–2. Sidebar size normalizes to 0–3 and maps to panel widths of
24, 28, 32, and 36 rem.

Settled wide navigation width (rail plus panel), in rem:

| `sideBarSize` | Panel | 1 column | 2 columns | 3 columns | 4 columns |
| ------------: | ----: | -------: | --------: | --------: | --------: |
|             0 |    24 |       29 |        34 |        39 |        44 |
|             1 |    28 |       33 |        38 |        43 |        48 |
|             2 |    32 |       37 |        42 |        47 |        52 |
|             3 |    36 |       41 |        46 |        51 |        56 |

Responsive open navigation uses the same size rows with one or two rail columns;
the closed responsive shell leaves the main column at full viewport width and
the open dialog overlays it. Explicit open animation may interpolate rail and
panel width from zero to those settled values; explicit close may interpolate
back to zero. Automatic lifecycle changes attach none of those animation
classes, so their only endpoint is the settled rectangle.

The deterministic legacy fixture uses an 800-pixel viewport with sidebar size 3
and two mobile columns. The writer classified it as responsive and produced a
10-rem rail plus 36-rem panel (46 rem total). The former reader classified the
same viewport as wide at its private 767-pixel boundary and used the rail's
one-column default (41 rem total), a 5-rem mismatch. At a wide four-column
setting the former reader was 15 rem narrower than the writer. The fixture first
asserts that old mismatch and then asserts identical reader/writer output from
the shared resolver.

The supplied `data/Trace-20260909T210319.json.gz` remains the diagnostic
pre-fix input: nine shifts without recent input, cumulative score approximately
`0.1722547`, and a dominant main-column move from `x = 440` to `x = 879`.
Portable acceptance uses owned rectangles instead of that machine-specific CLS.

## Implementation Record

| Revision    | Meaningful change                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `86cd4dcb8` | Committed the requested active plan before runtime work began.                                                                                           |
| `e0d333223` | Added the canonical shell geometry model/matrix, writer consumption, semantic hooks, and certified reader column projection.                             |
| `c22966d4e` | Introduced `ConversationShell` and adapted reader/writer navigation and main content to the shared frame and responsive classification.                  |
| `93263ef1c` | Removed reader-only top chrome and consolidated takeover/status/result UI into one bottom action component.                                              |
| `8a3ef57f1` | Added explicit animation causes, stable role-change behavior, persistent hidden reader navigation, frame/shift samplers, and browser handoff assertions. |
| `01ed1f9b7` | Preserved the exact legacy mismatch as deterministic regression evidence.                                                                                |

## Verification Evidence

Focused owner checks passed:

| Command                                                                | Result                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm test -- src/ts/gui/shellGeometry.test.ts`                        | 4 passed                                                                                       |
| `pnpm test -- src/ts/gui/guisize.test.ts`                              | 4 passed                                                                                       |
| `pnpm test -- src/ts/gui/displaySettings.dom.test.ts`                  | 5 passed                                                                                       |
| `pnpm test -- src/ts/gui/animation.test.ts`                            | 3 passed                                                                                       |
| `pnpm test -- src/ts/server/readerTranscriptProjection.svelte.test.ts` | 13 passed                                                                                      |
| `pnpm test -- src/lib/ReaderTakeoverAction.svelte.test.ts`             | 3 passed                                                                                       |
| `pnpm test -- src/lib/ObserverShell.svelte.test.ts`                    | 30 passed                                                                                      |
| `pnpm test -- src/lib/ReaderTranscript.svelte.test.ts`                 | 31 passed                                                                                      |
| `pnpm test -- src/App.routeEffect.dom.test.ts`                         | 29 passed                                                                                      |
| `pnpm test -- src/lib/SideBars/Sidebar.charList.test.ts`               | 6 passed                                                                                       |
| `pnpm test -- src/lib/SideBars/Sidebar.keyboard.dom.test.ts`           | 26 passed                                                                                      |
| `pnpm test -- src/lib/UI/GUI/SideBarArrow.svelte.test.ts`              | 2 passed                                                                                       |
| `pnpm test -- server/fastify/__tests__/layoutFrameSampler.test.ts`     | 3 passed                                                                                       |
| `pnpm check`                                                           | 0 errors and 0 warnings                                                                        |
| `pnpm check:server`                                                    | Protocol/shared/Fastify/browser types and architecture inventory passed; 0 cross-runtime edges |
| `pnpm build:smoke`                                                     | Passed; existing CSS `::highlight` and large-chunk warnings remain non-fatal                   |
| `pnpm check:docs`                                                      | 49 current documents passed                                                                    |
| Explicit archive/index validation                                      | 5 documents passed with no link, anchor, index, or literal-path errors                         |
| Documentation-scoped Prettier check and `git diff --check`             | Passed                                                                                         |

The mounted reader checks cover takeover single-flight behavior, disabled
states, cancellation, failure, supersession, retry availability, retained route
and focus, announcements, successful promotion gating, demotion, and reconnect
presentation. App/navigation checks cover automatic-role animation suppression,
explicit pointer/Escape close, focus containment/restoration, and reader
mutation/authoring exclusion. The display/motion checks retain the certified
settings and Reduced Motion root-class contracts.

The final built-browser command passed all seven selected journeys:

```sh
pnpm exec playwright test -c playwright.fastify-smoke.config.ts \
  server/fastify/browser-smoke/readOnlyAppUx.spec.ts \
  server/fastify/browser-smoke/connectedWriterSwitching.spec.ts
```

It covered desktop and Pixel 7-sized reader navigation, direct and restricted
routes, local folder/search/history state, drawer focus/Escape/restoration,
containment and authenticated reads, deletion/auth recovery, A → B → A writer
transfer, retained draft/route intent, transfer during accepted generation, and
fresh setup without Web Locks.

The final A → B handoff artifact recorded:

| Transition       | Sampled frames | Largest rail/panel/main `left` or `width` delta | Missing owned elements | Layout shifts without recent input |
| ---------------- | -------------: | ----------------------------------------------: | ---------------------: | ---------------------------------: |
| Writer demotion  |             44 |                                            0 px |                      0 |                                  0 |
| Reader promotion |             43 |                                            0 px |                      0 |                                  0 |

The promotion observer also retained two tiny recent-input entries
(`0.0002579278` attributed to the main region and `0.0000029897` attributed to
the panel). They are not evidence of rail/sidebar growth: the primary per-frame
horizontal oracle measured 0 px movement throughout. Writer demotion recorded no
layout-shift entry.

## Failures Resolved During Verification

- The first combined browser run passed six journeys and timed out in the mobile
  reader journey after a drawer reopen. The shared shell had destroyed hidden
  reader navigation, losing its locally expanded chat folder. Keeping only the
  reader navigation mounted while hidden restored the prior state contract; the
  targeted retry and final seven-journey run passed.
- The first strict supporting-observer assertion rejected the two
  `hadRecentInput: true` entries above even though every horizontal frame was
  identical. The final oracle retains all entries in evidence, asserts no
  shell-owned entry without recent input, and continues to use rectangle samples
  to catch movement regardless of input timing.
- The focused-test wrapper rejected one attempt containing two file arguments
  before executing tests. Each target was rerun through the required one-file
  interface and passed.

## Residual Limits

- Chromium desktop and Pixel 7 emulation are not physical-device coverage.
- The two tiny input-window layout-shift entries remain recorded; neither
  corresponded to horizontal shell movement.
- The full repository suite was not run, as required by Crunch Mode. No known
  focused or selected browser failure remains.
