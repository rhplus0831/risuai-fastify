# Read-Only Shell Parity and Role-Transition Stability

Date: 2026-09-09

Start at [status](status.md) for the current phase, next action, decisions, and
verification evidence. This document defines intended behavior and bounded work;
it does not describe a shipped implementation. Current source,
[STRUCTURE](../../../STRUCTURE.md), and the
[architecture guides](../../structure/README.md) remain authoritative for shipped
behavior.

This is a focused follow-up to the completed
[connected read-only clients](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/PLAN.md)
and
[read-only app UX](../../../.archived-docs/ui-and-user-input/read-only-app-ux/PLAN.md)
workstreams. Those archives remain closed. This plan does not reopen their wider
authority, synchronization, or reader-rendering scope.

## Objective and Document Ownership

Make read-only mode use the settled normal-app conversation-shell geometry so a
reader/writer role change does not replace one visible layout with a differently
sized layout. Remove the reader-only top action row and expose exactly one
**Use this device** action in a bottom-aligned, composer-equivalent action region.

Preserve the normal writer experience, connected-reader safety, independent
reader navigation, explicit takeover lifecycle, responsive behavior, themes,
focus handling, and reduced-motion behavior.

This `PLAN.md` owns the stable problem statement, product contract, boundaries,
phase definitions, and completion criteria. `status.md` is the only mutable
execution ledger. The three phases stay in this document while the work remains
a focused frontend refactor; see [Replanning Triggers](#replanning-triggers) for
conditions that require a larger planning package.

## Problem and Baseline Evidence

`src/App.svelte` currently chooses between a top-level `ObserverShell` branch and
the normal `Sidebar` plus `ChatScreen` branch. The two branches independently own
shell structure and geometry:

- `ObserverShell.svelte` adds a reader-only top row and uses its own
  `(max-width: 767px)` responsive drawer classification.
- The normal app uses `DynamicGUI`, whose responsive boundary is 1024 CSS pixels.
- `ReaderNavigation.svelte` derives its panel width locally and renders
  `NavigationRail` with its default column count.
- `Sidebar.svelte` uses the normal app's desktop/mobile column settings, stable
  width classes, and mount/open/close animation classes.
- `guisize.ts`, `Sidebar.svelte`, and `ReaderNavigation.svelte` do not currently
  share one width resolver. The settled writer shell is therefore the visual
  reference; Phase 1 must record its actual rectangles before consolidation.

The supplied `data/Trace-20260909T210319.json.gz` contains nine layout-shift
events without recent input and reaches a cumulative score of approximately
`0.1722547`. Its dominant sequence moves the main writer-route content from
`x = 440` to `x = 879` while the sidebar enters. The trace is diagnostic input,
not a portable golden: automated acceptance must measure owned shell rectangles
at deterministic viewport/settings combinations.

## Product Contract

### Shared visual frame

- At the same viewport and confirmed display settings, reader and writer modes
  have the same outer shell, navigation rail, sidebar panel, main-content origin,
  and available main-content width.
- The current settled writer layout is the parity reference. Refactoring must not
  intentionally redesign normal mode.
- Read-only state changes data, capabilities, control availability, and content;
  it does not select a separate page frame.
- Reader Home, Grid, character/chat navigation, transcript, restricted-route
  gate, loading, missing-target, and recoverable-error states all render inside
  that frame.
- There is no reader-only top row that changes the main route's vertical origin.

### Takeover placement and behavior

- Exactly one visible **Use this device** action exists while takeover is
  available. It is bottom-aligned in the main content's action area rather than
  in separate reader-only top chrome.
- On a conversation route, the action uses the composer-equivalent footer. On a
  readable route without a composer, the same action component remains
  bottom-aligned without changing navigation or main-column geometry.
- The action retains the existing confirmation, acquisition, cancellation,
  failure, ownership-race, recovery, and retry behavior. It is disabled whenever
  the existing lifecycle says promotion is unsafe.
- Read-only status, connection/recovery status, and operation results remain
  accessible and localized. Moving the action must not remove announcements or
  focus restoration.

### Transition stability

- Automatic startup, reader-to-writer promotion, writer-to-reader demotion,
  reconnect, and writer recovery do not replay sidebar entry/exit animations or
  progressively move the main content.
- Sidebar and drawer animation remains allowed for an explicit user open/close
  action. Animation eligibility must be based on the transition cause, not merely
  on component mount.
- Reduced Motion continues to disable applicable motion through the existing
  setting and root-class contract.
- Reader navigation and the latest valid reader route stay usable during pending,
  cancelled, or failed takeover. Successful promotion applies the retained route
  through the existing fenced intent lifecycle.

### Responsive parity

- Reader and writer modes consume one responsive classification; do not retain a
  reader-only media-query threshold.
- Both roles honor the confirmed `sideBarSize`, `desktopSidebarColumns`, and
  `mobileSidebarColumns` values with the same normalization and rail/panel
  geometry.
- On responsive layouts the closed shell leaves the main content at full width.
  Opening navigation creates the same modal/drawer geometry, dialog semantics,
  focus containment, Escape behavior, and focus restoration expected by the
  normal app, while retaining reader-local navigation state.

## Architecture and Invariants

### One geometry owner, separate capability owners

Extract the smallest role-neutral shell/layout boundary that can own the outer
flex/grid structure, rail and panel dimensions, responsive classification, and
animation policy. Prefer a persistent layout frame around the reader/writer
adapter boundary so a role change swaps controllers and content without
reconstructing differently sized outer columns.

Do not solve parity by mounting the writer `Sidebar` or writer chat controller in
read-only mode. The writer adapter retains writer stores, authoring controls,
organization commands, optimistic outcomes, and route effects. The reader
adapter retains certified projections, local route selection, reader-local
search/folder/drawer state, and inert authoring controls. Shared presentation
accepts explicit data, capabilities, callbacks, and geometry inputs; it must not
fall back to writer state when reader inputs are absent.

The implementation may introduce a small shared shell component or shared
geometry helper. Avoid a broad `Sidebar.svelte` rewrite unless a concrete
dependency requires it. Land the writer adapter against the shared boundary
before switching the reader adapter so normal behavior has an explicit parity
checkpoint.

### Canonical geometry

Use one normalized geometry model for:

- responsive/wide classification;
- rail column count and rail width;
- sidebar panel width and minimum width;
- open, closed, opening, and closing layout state;
- main-content origin and available width.

Phase 1 records settled writer rectangles for supported sidebar sizes and column
counts. The shared resolver must preserve those settled values and remove
conflicting reader formulas and animation endpoints. If current writer classes
and `--sidebar-size` disagree, choose and document one canonical settled value
before changing runtime code; do not hide a final snap behind a matching reader
implementation.

The shell resource already includes `desktopSidebarColumns` and
`mobileSidebarColumns`. Extend the existing certified reader-navigation
allowlist/consumer as needed rather than adding a new wire payload. Pending writer
settings must not leak into reader presentation.

### Reader safety and lifecycle invariants

All previously accepted reader constraints remain mandatory:

- The server's single-writer authority and write authorization do not change.
- Readers render only certified, server-confirmed display/navigation/transcript
  data. Pending writer appearance and optimistic domain state remain excluded.
- Reader navigation does not write `selectedCharID`, `currentChar`, `chatPage`,
  durable commands, or outbox entries.
- Settings, plugin panels, interactive scripts, authoring routes, mutation
  shortcuts, drag/drop mutations, and late callbacks remain blocked.
- Role, auth, session-generation, revision, and database-lineage fences remain
  authoritative. Do not add a second role flag for presentation.
- Promotion and demotion retain existing draft recovery, route-intent, generation
  observation, reconnect, and ownership-race behavior.

## Scope

### In scope

- App-level reader/writer shell composition and persistent outer geometry.
- Shared responsive classification and sidebar geometry normalization.
- Reader consumption of the existing desktop/mobile sidebar column settings.
- Navigation rail/sidebar animation cause and automatic-role-transition policy.
- Removal of reader-only top chrome and consolidation of takeover/status UI into
  one bottom-aligned action component.
- Focus, keyboard, screen-reader, reduced-motion, desktop, and mobile behavior
  affected by the shell change.
- Deterministic component and browser regression coverage for settled parity and
  role-transition stability.
- Current architecture/test documentation updates and final plan archival.

### Out of scope

- Server authority, session/takeover protocol, SQLite, resource schema, command,
  SSE, outbox, or database migrations.
- Multi-writer support, offline authoring, or a new reader persistence model.
- Enabling Settings, plugin panels, interactive scripts, editing, generation, or
  other authoring controls for readers.
- Merging reader and writer controllers or making reader-local navigation
  canonical writer selection.
- Redesigning the normal app's navigation, chat transcript, composer, theme, or
  content-width system beyond the geometry needed for parity.
- Treating the supplied trace's cumulative score as a cross-machine performance
  budget.

## Primary Owners and Test Entry Points

This inline map replaces a separate inventory document.

| Concern | Current owners | Focused evidence |
| --- | --- | --- |
| Top-level shell and role branches | `src/App.svelte` | `src/App.routeEffect.dom.test.ts` |
| Reader shell, takeover lifecycle, route states | `src/lib/ObserverShell.svelte` | `src/lib/ObserverShell.svelte.test.ts` |
| Writer navigation and panel geometry | `src/lib/SideBars/Sidebar.svelte` | `src/lib/SideBars/Sidebar.charList.test.ts`, `src/lib/SideBars/Sidebar.keyboard.dom.test.ts` |
| Reader navigation geometry and local browsing | `src/lib/SideBars/ReaderNavigation.svelte` | `src/lib/ObserverShell.svelte.test.ts` |
| Shared rail geometry and motion | `src/lib/SideBars/NavigationRail.svelte` | owning sidebar/App DOM tests; add a focused helper/component test if extraction warrants it |
| Bottom conversation action | `src/lib/ReaderTranscript.svelte` and the new/extracted bottom action owner | `src/lib/ReaderTranscript.svelte.test.ts`, `src/lib/ObserverShell.svelte.test.ts` |
| Responsive and sidebar-size state | `src/ts/stores.svelte.ts`, `src/ts/gui/guisize.ts`, `src/ts/gui/displaySettings.ts` | `src/ts/gui/guisize.test.ts`, `src/ts/gui/displaySettings.dom.test.ts` |
| Certified reader settings | `src/ts/server/readerTranscriptProjection.svelte.ts`, existing shell resource | `src/ts/server/readerTranscriptProjection.svelte.test.ts` |
| Real reader/writer transition | browser smoke fixtures | `server/fastify/browser-smoke/readOnlyAppUx.spec.ts`, `server/fastify/browser-smoke/connectedWriterSwitching.spec.ts` |
| Current behavior documentation | `src/docs/svelte-navigation-ui.md`, `src/docs/svelte-ui.md`, `docs/tests/app-navigation-and-chat.md` | `pnpm check:docs` |

## Phase 1: Geometry Contract and Regression Harness

### Work

1. Record the settled normal-app rail, panel, and main-content rectangles for
   sidebar sizes `0` through `3`, supported desktop/mobile column counts, and the
   wide/responsive boundary. Record computed animation endpoints where they
   differ from settled rectangles.
2. Introduce or identify stable test hooks for the outer shell, navigation rail,
   sidebar panel, main-content column, and bottom action region. Hooks must belong
   to semantic layout owners rather than Tailwind class strings.
3. Add a reusable browser measurement helper that samples `getBoundingClientRect()`
   on animation frames from immediately before a role transition until readiness
   settles. Do not use CLS alone: shifts shortly after a user click can carry
   `hadRecentInput` and be excluded from the metric.
4. Add focused projection/DOM coverage for the normal responsive boundary and
   certified desktop/mobile sidebar columns. Confirm the existing shell payload
   is sufficient and no wire change is needed.
5. Capture the pre-fix mismatch as regression evidence in `status.md`; do not
   weaken assertions to make the current implementation pass.

### Acceptance

- The stable writer geometry matrix and canonical width decision are recorded in
  `status.md`.
- A deterministic test demonstrates the reader/writer settled-geometry mismatch
  or transient role-transition movement before the fix.
- The browser helper observes intermediate frames and reports the offending
  element and largest delta when it fails.
- Reader column settings are proven to come from certified server-confirmed
  settings with the existing pending/auth/lineage isolation.
- No production shell behavior changes in this phase except minimal semantic test
  hooks or extraction prerequisites.

## Phase 2: Shared Shell and Bottom Takeover Action

### Work

1. Extract the role-neutral geometry owner and adapt the current writer shell to
   it while preserving the Phase 1 settled rectangle matrix.
2. Adapt `ObserverShell`/`ReaderNavigation` to the same frame, responsive
   classification, normalized columns, and canonical panel width. Remove the
   reader-only breakpoint and duplicated width calculation.
3. Keep reader data and local navigation behind explicit reader inputs. Audit the
   shared boundary for imports of writer stores, commands, authoring components,
   plugin/script runtime, or mutable fallback data.
4. Extract or centralize the read-only bottom action. Remove the standalone
   reader header and the duplicate takeover control; render exactly one control
   for chat and non-chat reader routes without changing navigation/main-column
   geometry.
5. Preserve localized read-only context, lifecycle status, operation results,
   accessible naming, focus behavior, and disabled-state rules.

### Acceptance

- For each Phase 1 wide-layout case, settled reader and writer rail, panel, and
  main-content rectangles differ by no more than 1 CSS pixel.
- Reader and writer switch responsive mode at the same boundary and use the same
  normalized mobile/desktop column counts.
- Reader routes have no dedicated top layout row and exactly one visible
  **Use this device** action when eligible; its action region is bottom-aligned.
- Writer navigation, authoring controls, chat selection, and normal composer
  behavior remain unchanged.
- Reader browsing stays local and all mutation/restricted-surface negative tests
  remain green.

## Phase 3: Transition Stability, Browser Proof, and Closeout

### Work

1. Restrict rail/sidebar entry and exit animations to explicit user navigation
   open/close causes. Automatic mount, role resolution, promotion, demotion,
   reconnect, and recovery must establish final shell geometry immediately.
2. Preserve the outer layout and measured main-content column while swapping
   reader/writer controllers. Remove obsolete reader geometry, header, and
   animation scaffolding after both adapters use the shared boundary.
3. Exercise reader-to-writer success, cancellation, failure, retry, and ownership
   race; writer-to-reader demotion; reconnect/recovery; direct routes; and
   desktop/mobile drawer behavior. Keep the existing route-intent, draft,
   generation, focus, and announcement assertions.
4. Add focused built-browser journeys for geometry parity and transition-frame
   sampling. Use the Performance Observer layout-shift stream only as supporting
   evidence for automatic transitions; rectangle sampling is the primary oracle.
5. Update current architecture and test guides, record exact evidence in
   `status.md`, remove temporary diagnostics, and archive this package after all
   completion gates pass.

### Acceptance

- During automatic reader/writer role changes, the shared main-content column's
  left edge and width stay within 1 CSS pixel of their pre-transition values on
  every sampled frame at the same viewport/settings.
- The shell produces no layout-shift entry attributable to rail/sidebar growth on
  automatic startup, promotion completion, demotion, reconnect, or recovery.
- Intentional responsive drawer open/close still works through pointer, keyboard,
  Escape, focus trap/restoration, and Reduced Motion.
- Reader takeover remains single-flight and preserves route/focus on cancellation
  or failure; successful promotion reaches the normal writer UI only after
  authority and recovery are ready.
- Existing connected-reader containment checks show no new command, outbox,
  restricted route, Settings, plugin, script, or authoring entry path.
- Current docs describe the shared frame and transition policy; temporary and
  duplicate layout code is removed.

## Validation Strategy

Run the smallest relevant checks throughout implementation. Expected focused
owners are:

```sh
pnpm test -- src/ts/server/readerTranscriptProjection.svelte.test.ts
pnpm test -- src/ts/gui/displaySettings.dom.test.ts
pnpm test -- src/ts/gui/guisize.test.ts
pnpm test -- src/lib/ObserverShell.svelte.test.ts
pnpm test -- src/lib/ReaderTranscript.svelte.test.ts
pnpm test -- src/App.routeEffect.dom.test.ts
pnpm test -- src/lib/SideBars/Sidebar.charList.test.ts
pnpm test -- src/lib/SideBars/Sidebar.keyboard.dom.test.ts
pnpm check
pnpm check:server
pnpm build:smoke
pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/readOnlyAppUx.spec.ts server/fastify/browser-smoke/connectedWriterSwitching.spec.ts
pnpm check:docs
```

Only run suites whose owners are affected by the final implementation, adding a
new focused test when code moves to a new owner. Follow Crunch Mode: do not run
`pnpm test:agent`; the user will run the full suite later. Do not run
`pnpm test:all` unless explicitly requested.

For each phase, `status.md` records the exact source revision, commands, outcomes,
browser viewport/settings matrix, observed maximum frame delta, failures and
their resolution, and residual limitations. A successful browser-smoke build is
not evidence that the Playwright journeys executed.

## Completion Criteria

The work is complete only when:

- all three phases are accepted with evidence in `status.md`;
- reader and writer settled shell geometry matches within the stated tolerance;
- automatic role transitions remain stable across every measured frame;
- exactly one accessible bottom takeover action replaces reader-only top chrome;
- writer behavior and reader safety/lifecycle invariants remain covered;
- focused component, DOM, type, build, and Playwright checks relevant to the final
  owners pass;
- current architecture/test docs match the shipped implementation; and
- the completed planning package moves to `.archived-docs/` and
  `docs/plan/README.md` returns to the accurate active-plan state.

## Replanning Triggers

Stop the current phase and expand this package with an inventory and separate
phase documents before proceeding if any of these becomes necessary:

- a protocol, server resource, API, SQLite, command, SSE, outbox, or migration
  change;
- a redesign of writer authority, promotion/demotion, bootstrap, route intent,
  draft recovery, or generation lifecycle;
- enabling a currently excluded reader surface or merging reader/writer
  capability owners;
- a rollout flag, compatibility fallback, or independently reversible migration;
- more than three independently acceptable implementation slices or work that
  needs parallel owners/branches and durable handoffs.

If the existing shell resource unexpectedly cannot supply the confirmed geometry
settings, record that finding and replan rather than silently adding a wire
change to Phase 2.
