# Read-Only App UX Status

## Current Cursor

- State: Phase 0 accepted; Phase 1 access and committed-data boundaries in progress.
- Next phase: [Phase 1 — reader boundary and data](phases/phase-1-reader-boundary-and-data.md).
- Next bounded slice: establish route/action denial and certify navigation/display
  fields before mounting shared reader navigation.
- Source baseline reviewed: `982eef6112a407d138ea6a77ebc638c8058edfe2`.
- Fixed scope: Settings, plugin panels, and interactive scripts are inaccessible
  to readers through controls, routes, shortcuts, restored UI, and callbacks.
- No phase is accepted by creating these planning documents.

## Document Map

- [PLAN.md](PLAN.md): stable product contract, invariants, rollout, and completion criteria.
- [Inventory](inventory.md): source owners, known integration boundaries, and focused test entry points.
- [Phase index](phases/README.md): bounded work and explicit plan validation.
- [Active plans](../README.md): repository planning index.

## Phase Ledger

| Phase                                                                                        | State    | Acceptance evidence                                                           |
| -------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                        | Accepted | Matrix, interfaces and confirmed-field map below; four read-only cross-checks |
| [1. Reader boundary and navigation data](phases/phase-1-reader-boundary-and-data.md)         | Pending  | —                                                                             |
| [2. Shared shell and navigation](phases/phase-2-shared-shell-and-navigation.md)              | Pending  | —                                                                             |
| [3. Shared transcript and passive display](phases/phase-3-transcript-and-passive-display.md) | Pending  | —                                                                             |
| [4. Lifecycle and action containment](phases/phase-4-lifecycle-and-containment.md)           | Pending  | —                                                                             |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                    | Pending  | —                                                                             |

## Decisions

- 2026-09-08: adopt the repository's stable plan, single progress ledger, inventory,
  and bounded phase-document structure.
- 2026-09-08: reuse the existing app's presentation around the connected-reader
  controller and committed projections. Keep `ReaderTranscript` as the first
  reader transcript owner; extract the normal shell's reusable view boundaries.
- 2026-09-08: Settings, plugin panels, and interactive scripts are hard exclusions,
  including interactive scripts that only affect local state. Display-setting
  reads and existing isolated server display transforms remain permitted.
- 2026-09-08: block direct restricted routes before loading/mounting authoring UI;
  show a localized gate in the shared shell with safe reading navigation. Blocked
  in-app actions preserve the reader selection and never trigger takeover.
- 2026-09-08: retain current reader authority and takeover/recovery machinery.
  Any temporary presentation switch is separate from reader-authority rollout.

## Verification Ledger

### Investigation baseline

The earlier source investigation ran these existing focused suites successfully:

| Command                                                   | Result    |
| --------------------------------------------------------- | --------- |
| `pnpm test -- src/lib/ObserverShell.svelte.test.ts`       | 26 passed |
| `pnpm test -- src/lib/ReaderTranscript.svelte.test.ts`    | 27 passed |
| `pnpm test -- src/ts/readerLocalMutations.svelte.test.ts` | 9 passed  |

These 62 tests verify the existing reader foundation, not the proposed shared
interface. The investigation cross-checked cited source after concurrent
repository changes. No new runtime implementation, shared-view browser proof,
or production verification is claimed by this baseline.

### Planning package

- 2026-09-08: `pnpm check:docs` passed for 49 current documents.
- 2026-09-08: the exact [explicit plan/index command](phases/README.md#plan-document-validation)
  passed for all 11 planning/index documents with no link, anchor, source-path,
  or index errors.
- 2026-09-08: `pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md 'docs/plan/read-only-app-ux/**/*.md'`
  and `git diff --check` passed.
- Consistency review confirmed all six phases are pending, restricted surfaces
  stay excluded in every phase, and access guards precede shared UI exposure.
  Runtime source is unchanged; no runtime suites or browser journeys were run
  for this documentation-only change.

## Progress Record

- 2026-09-08: prepared the stable contract, source inventory, six phase documents,
  and active-plan entry. The next work is Phase 0; all implementation remains pending.

For each completed slice, record the exact changed boundary and source revision,
commands, outcomes, relevant browser evidence, and remaining limitations here.
Record failures and their resolution without describing an unrun check as passed.
Advance the cursor and accept a phase only when its checks are evidenced. Keep
phase documents focused on work and acceptance; do not copy progress into them.

## Phase 0 Implementation Inventory

### Entry and action matrix

| Surface and entry                                                                                             | Reader policy and owner                                                                                                                                   | Writer behavior retained                                                   | Verification target                                                           |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Home/grid buttons, character avatars/cards, chat/pin rows, browser URLs/history                               | Local stable IDs through `ObserverShell` and `readerRouteScope`; no `changeChar`, `currentChar`, `chatPage`, or selected-character store writes           | Existing router/character adapter applies selection                        | Shell/route tests and two-client browsing journey                             |
| Character/chat folders, search, scroll, unread badges, mobile drawer                                          | Local view state scoped to authenticated database identity; committed ordering and IDs; keyboard-accessible native buttons                                | Existing folder confirmations and command-backed fold/order persistence    | Navigation component tests plus desktop/mobile folders/search/focus proof     |
| Settings buttons, Quick Settings, character/config tabs, presets and developer controls                       | Disabled visible launchers with localized reason; deny handler and shortcut; direct restricted URL gets shell gate with Home/valid previous reading route | Current Settings and editor adapters, readiness and route resource loading | Hotkey/router/prefetch/App overlay suites                                     |
| Plugin menu items, custom GUI/settings, restored overlays, deferred imports/callbacks                         | Never mount or invoke; current write capability and session-generation checks at invocation; close restricted stores on demotion                          | Existing plugin runtime readiness and lifecycle                            | Plugin lifecycle and demotion suites; browser no-mount check                  |
| Sidebar/chat create/delete/rename/reorder/import, context menus, keyboard organization, native/Sortable drops | No reader command callbacks, Sortable, import effects or authoring dialogs; deny at current action boundary even after awaits                             | Existing command owners, outcome handling and draft fences                 | Sidebar/SideChatList writer regression and reader mutation/outbox assertions  |
| Transcript history, copy, safe links/disclosures, passive markup/assets                                       | Keep `ReaderTranscript` with explicit read owners and `Chats`/`Chat`; isolated server display processing and readable fallback                            | Existing writer transcript/composer controller                             | Reader transcript, custom HTML, display-resource and browser rendering suites |
| `risu-trigger`/`risu-btn`, Lua/button callbacks, plugin actions and executable markup                         | Disabled native controls and guarded invocation, including local-only effects and stale parses                                                            | Current authorized script behavior with session/owner freshness            | Button freshness/custom HTML/plugin tests and browser alternate activation    |
| Composer/send/regenerate/stop/edit/TTS and other message mutations                                            | Disabled composer explains write requirement and uses explicit takeover callback; no draft owner mounted                                                  | Existing composer drafts and separate generation readiness                 | Transcript/action tests and controlled live-generation browser journey        |
| Takeover confirmation/acquisition/recovery, cancel/failure/race                                               | Existing `promoteConnectedReader`; retain latest valid local route; no automatic takeover                                                                 | Existing writer acquisition/recovery, pending-intent owners                | Session/bootstrap/route intent and rollout browser suites                     |
| Demotion/reconnect/replay gaps/auth loss/database replacement                                                 | Existing client session, confirmed projection, sync and stream fences; clear identity-bound local view state; no reader outbox replay                     | Writer draft capture/runtime stop and retained intent                      | Demotion/projection/sync/stream tests and rollout browser journey             |

### Shared view and adapter interfaces

- Extract presentation from the existing rail, grid/cards, chat list rows and chat
  chrome. Shared components accept explicit display rows, stable selected IDs,
  visual options, capabilities, and required activation callbacks. They import
  no mutable resource owner or command fallback. Writer adapters retain the
  existing organization, command settlement and editor controllers.
- `ObserverShell` remains the reader controller, using certified rows and local
  routes. Replace its dedicated connected-reader layout with those shared views.
  Keep a shell-only preview before read readiness; do not hydrate protected detail
  or repair a deep link while initial disposition remains unresolved.
- Retain `ReaderTranscript`, read-owner context, pagination, generation observer,
  stream reconciliation and viewport owners. Extract presentation/chrome only;
  its composer receives the controller's existing explicit takeover callback.
- No temporary presentation switch is needed. Reader-authority rollout remains
  unchanged. Introduce shared presentation directly with slice-level guards and
  retain lifecycle tests; remove duplicate dedicated navigation at integration.

### Confirmed field and invalidation map

| Display input                                                                                     | Certified source                                                               | Invalidation and isolation                                                                                                               |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Character stable IDs, names, images, creator notes, trash state, chat IDs/count and pin summaries | Existing character summary/detail read payloads                                | Character list/detail resource fences; clone before pending overlays; global unique IDs                                                  |
| Character order and folder ID/name/image/color/members/open default                               | Existing shell/character-order payload                                         | Order receipt/resource revision, database lineage and session fences; readers override expansion only in local memory                    |
| Chat ID/name/order, folder assignment, pin and date; chat folder labels/color/fold default        | Existing hydrated character detail and accepted chat metadata receipts         | Character/chat invalidations; copy only certified fields; retain lazy detail loading                                                     |
| Theme palette, fonts/sizes, icon shape, chat appearance, safe CSS/background metadata             | Existing shell/display settings plus audited character display fields          | Clone accepted settings before optimistic overlays; refresh through read-only display-resource loader; clear on auth/lineage replacement |
| Persona display, greeting and message text/assets                                                 | Existing reader projection, persona settings/collection and paginated messages | Existing persona demand reads, message incarnation/revision and session-generation fences                                                |
| Live generation/unread presentation                                                               | Existing reader generation observation and local unread display                | Stream operation identity distinct from client lifecycle generation; final persisted reconciliation                                      |

The first browser slice extends the existing disposable two-client browsing
harness with shared rail/grid, local folders/search/pins, blocked Settings and
plugin entry, network/domain-event/outbox assertions, and writer selection
comparison. The final combined run adds actual desktop/mobile rendering,
controlled generation and takeover/demotion/reconnect/lineage journeys.

### Phase 0 acceptance — 2026-09-08

Four independent read-only Luna workers cross-checked route/policy, navigation,
transcript and lifecycle/test ownership. All completed successfully; parent
review confirmed the cited seams in current source. Concrete gaps are Settings
hotkeys and route warming, retained restricted overlays/intents, omitted
navigation/background fields, missing shared reader navigation, and ordinary
script-button disabled feedback. Existing low-level plugin/trigger authority
checks remain useful and will receive focused containment regression coverage.

Resolved implementation choices: active character cards exclude trash; explicit
unique IDs gate folder membership and pins; no new wire schema is needed;
`backgroundCSS` has no live writer renderer and is outside parity. Safe static
custom markup stays readable, with the existing localized limited-display
fallback for executable/template features that cannot run in reader mode.
The next commits establish access denial and confirmed data before shared
presentation is exposed. No runtime acceptance is claimed by this inventory.

Phase 0 documentation checks: `pnpm check:docs` passed (49 files), explicit
plan/index validation passed (11 documents), Prettier and documentation-scoped
whitespace validation passed. Concurrent runtime edits are validated per slice.

### Phase 1 committed-data slice — 2026-09-08

The reader projection now retains allowlisted character/chat folders, pins,
labels and background metadata, certified character order, and passive display
settings. Resource reads and accepted receipts record these before optimistic
writer overlays. Auth/lineage replacement clears the new projection; demotion
selects confirmed paint values. No wire schema or database migration changed.

Validation: `pnpm test -- src/ts/server/readerTranscriptProjection.svelte.test.ts`
passed (8 tests), `pnpm test -- src/ts/gui/displaySettings.dom.test.ts` passed
(5), `pnpm test -- src/ts/gui/colorscheme.test.ts` passed (36), and
`pnpm test -- src/ts/server/resourceState.svelte.test.ts` passed (79). The initial
attempt to give multiple files to the focused wrapper was rejected before any
tests ran; each target was then run through its supported single-file interface.
Prettier and slice-scoped whitespace checks passed. Shared UI and browser
acceptance remain in progress.

### Phase 1 access-boundary slice — 2026-09-08

In-app restricted navigation and Settings shortcuts now preserve the reading
route. Direct URLs remain available to the reader gate. Writer route component,
resource and idle/background warming reject reader or stale session work.
App closes restricted overlays synchronously on writer loss and on late store
restoration; only explicit session-purpose takeover selections are admitted
alongside passive/auth alerts. Confirmed theme/font/size repaint occurs on loss.
Reader adjacent-character shortcuts consult committed rows. Existing plugin,
Lua and trigger authority/generation boundaries remain in place.

Focused access validation (377 tests) passed with:

```sh
pnpm exec vitest run src/ts/router.test.ts src/ts/routeComponentPreload.test.ts src/ts/routeIntentPrefetch.test.ts src/ts/server/routeResourceLoader.test.ts src/ts/hotkey.navigation.test.ts src/ts/alert.test.ts src/App.routeEffect.dom.test.ts src/ts/server/activeWriterSession.test.ts src/ts/bootstrap.test.ts --bail=1
```

Additional hotkey/resource/plugin/Lua/trigger verification passed (226 tests).
After the committed-paint integration, `pnpm test -- src/ts/bootstrap.test.ts`
passed (217) and `pnpm test -- src/App.routeEffect.dom.test.ts` passed (29).
Prettier and slice whitespace checks passed. Phase 1 navigation adapter proof
and later combined browser acceptance remain outstanding.
