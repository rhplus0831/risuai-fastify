# Read-Only Shell Parity Status

## Current Cursor

- State: **Ready for implementation; all runtime phases are pending.**
- Current phase: Phase 1 — Geometry contract and regression harness.
- Next action: record the settled writer geometry matrix and add the failing
  reader/writer transition measurement.
- Source baseline reviewed: `d548d2643089`.
- Diagnostic input: `data/Trace-20260909T210319.json.gz`.
- No runtime implementation or runtime validation is claimed by this planning
  package.

## Document Map

- [PLAN.md](PLAN.md): stable contract, boundaries, three phases, and completion
  criteria.
- [Active plans](../README.md): current planning index.
- [Prior read-only app UX](../../../.archived-docs/ui-and-user-input/read-only-app-ux/status.md):
  completed feature/presentation work that this plan follows without reopening.
- [Prior connected-reader lifecycle](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md):
  completed authority and synchronization foundation.

## Phase Ledger

| Phase | State | Acceptance evidence |
| --- | --- | --- |
| 1. Geometry contract and regression harness | Pending | None; source/trace investigation is planning evidence only |
| 2. Shared shell and bottom takeover action | Pending | None |
| 3. Transition stability, browser proof, and closeout | Pending | None |

## Decisions

- 2026-09-09: use a lean active package with one stable plan and one mutable
  status ledger. Keep phase definitions inline while this remains a three-slice
  frontend refactor.
- 2026-09-09: preserve the completed reader authority, certified projection,
  independent navigation, route-intent, lifecycle, and mutation-containment
  architecture. This is not a new read-only implementation.
- 2026-09-09: use the settled normal-app shell as the visual reference and
  centralize geometry rather than making the normal app imitate the dedicated
  reader shell.
- 2026-09-09: share role-neutral layout/presentation only. Do not mount writer
  controllers or mutation owners for readers.
- 2026-09-09: consolidate takeover into exactly one bottom-aligned action and
  remove reader-only top chrome while retaining status announcements, disabled
  states, confirmation, and focus behavior.
- 2026-09-09: use the normal app's responsive classification and confirmed
  desktop/mobile column settings. The shell protocol already carries those
  settings, so no wire change is planned.
- 2026-09-09: animation is valid for explicit user drawer/sidebar actions, not
  as an automatic consequence of shell mount or role change.
- 2026-09-09: make animation-frame rectangle sampling the primary transition
  oracle because browser CLS can exclude shifts near takeover clicks through
  `hadRecentInput`.
- 2026-09-09: follow Crunch Mode with focused tests and selected browser journeys;
  do not run `pnpm test:agent` or the full suite for this workstream.

## Planning Evidence

### Current-source findings

- `src/App.svelte` renders `ObserverShell` separately from the normal
  `Sidebar`/`ChatScreen` tree.
- `src/lib/ObserverShell.svelte` owns a reader-only top row and 767-pixel media
  query, while `src/ts/stores.svelte.ts` classifies the normal responsive shell at
  1024 pixels.
- `src/lib/SideBars/ReaderNavigation.svelte` locally derives panel width and uses
  the default navigation-rail column count; `Sidebar.svelte` consumes normalized
  desktop/mobile columns and separate stable/animated width owners.
- `packages/protocol/src/shellResource.ts` already includes `sideBarSize`,
  `desktopSidebarColumns`, and `mobileSidebarColumns`. The reader projection does
  not yet expose both column settings to `ReaderNavigation`.
- `src/lib/ReaderTranscript.svelte` already has a composer-equivalent takeover
  action, while `ObserverShell.svelte` provides another action in the top row.

### Trace findings

The supplied trace contains nine `LayoutShift` events whose
`had_recent_input` value is false. Cumulative score reaches approximately
`0.1722547`. In the dominant writer-shell entry sequence, the impacted main
content rectangle moves through `x = 440`, `522`, `538`, `713`, `770`, `785`,
`822`, and `879`. The largest single event is approximately `0.0756712`.

These values establish the reported symptom and guide the regression case. They
do not define a portable score budget; the plan's automated oracle uses owned
element rectangles and a 1 CSS pixel tolerance.

## Verification Ledger

- 2026-09-09: reviewed current shell/navigation owners, focused test indexes,
  existing shell-resource fields, and the two archived read-only plans.
- 2026-09-09: extracted the nine layout-shift events from the supplied trace with
  `gzip` and `jq`.
- 2026-09-09: `pnpm check:docs` passed for the 49 current architecture/test
  documents and indexes.
- 2026-09-09: an explicit three-document active-plan validation passed for
  `docs/plan/README.md`, `PLAN.md`, and `status.md`, including local links,
  anchors, and literal source paths.
- 2026-09-09: focused Prettier check and `git diff --check` passed for the active
  plan package and index.
- Runtime tests and browser journeys: not run; this change only creates planning
  documents.

## Progress Record

- 2026-09-09: created the focused plan, initial decisions, three-phase ledger,
  acceptance tolerances, validation strategy, and active-plan index entry.

For each implementation slice, record the exact changed owner and source
revision, commands and outcomes, viewport/settings matrix, maximum measured
frame delta, relevant screenshots/traces, failures and their resolution, and any
remaining limitation here. Advance a phase only when every acceptance item in
`PLAN.md` has direct evidence. Do not copy progress into the stable plan.
