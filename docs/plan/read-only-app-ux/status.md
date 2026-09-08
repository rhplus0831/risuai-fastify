# Read-Only App UX Status

## Current Cursor

- State: Phases 0–1 accepted; implementation complete; final browser and aggregate verification in progress.
- Next phase: [Phase 5 — verification and rollout](phases/phase-5-verification-and-rollout.md).
- Next bounded slice: finish final browser and aggregate checks, record acceptance,
  and archive this package with updated current documentation.
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

| Phase                                                                                        | State        | Acceptance evidence                                                           |
| -------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                        | Accepted     | Matrix, interfaces and confirmed-field map below; four read-only cross-checks |
| [1. Reader boundary and navigation data](phases/phase-1-reader-boundary-and-data.md)         | Accepted     | Access, projection and local-navigation focused evidence below                |
| [2. Shared shell and navigation](phases/phase-2-shared-shell-and-navigation.md)              | Accepted     | Shared controls, independent browsing and desktop/mobile browser proof        |
| [3. Shared transcript and passive display](phases/phase-3-transcript-and-passive-display.md) | Accepted     | Confirmed display, script denial, history/live generation and visual proof    |
| [4. Lifecycle and action containment](phases/phase-4-lifecycle-and-containment.md)           | Accepted     | Session/draft/replay/deletion/auth/lineage and two-client generation proof    |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                    | Verification | Final aggregate and browser reruns in progress                                |

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

### Phase 1 acceptance and Phase 2 shared-navigation slice — 2026-09-08

Shared explicit-prop rail, native avatar controls, pinned shortcuts, chat
selection buttons and character cards now serve writer adapters and the reader.
`ReaderNavigation` handles confirmed order/folders/pins/search; `ObserverShell`
retains local stable routes, fenced hydration and takeover. Both the connected
reader and conservative shell preview use the shared navigation. The duplicate
dedicated navigation layout is removed. Restricted direct URLs offer Home and
Return to reading, and only valid reading routes become takeover intent.

Folder/search/drawer/unread presentation clears on auth/database identity changes
and stays local across ordinary browsing. Mobile navigation traps/restores focus,
and confirmed sidebar width leaves room for the close control. Writer adapters
retain command settlement and drafts while rejecting stale activation/Sortable
work after authority loss. Navigation neither starts the writer controller nor
falls back to its selected stores. Phase 1 route/data/navigation boundaries are
accepted; Phase 2's actual two-client browser proof remains pending.

Focused commands passed (149 tests):

```sh
pnpm test -- src/lib/ObserverShell.svelte.test.ts
pnpm test -- src/lib/Others/GridCatalog.svelte.test.ts
pnpm test -- src/lib/SideBars/SideChatList.svelte.test.ts
pnpm test -- src/lib/SideBars/Sidebar.keyboard.dom.test.ts
pnpm test -- src/lib/SideBars/Sidebar.charList.test.ts
pnpm test -- src/lib/SideBars/PinnedChatsRail.svelte.test.ts
```

Counts were 29, 19, 68, 23, 6 and 4 respectively. Existing writer and conservative
preview regressions are retained. Prettier and whitespace checks passed.
Reader transcript live-generation status remains owned by its selected-chat
observer; shared navigation does not start a second generation runtime.

### Phase 3 confirmed passive-module slice — 2026-09-08

Reader display now certifies module asset/background/icon metadata and the
character/chat/persona/preset activation links needed to choose it. It excludes
prompts, script definitions and plugin runtime state. Raw accepted inputs are
copied before pending writer overlays; compact acknowledgements demand a fresh
read instead of certifying the resident optimistic graph. Database/auth reset
clears the projection. Paint also switches to confirmed values whenever writer
projection readiness is revoked, including recovery while authority is retained.

Projection, display-resource and resource-state suites passed (105 tests); the
final projection suite passed 13 tests after adding a real pending-overlay
regression. `pnpm test -- src/ts/gui/displaySettings.dom.test.ts` passed (5).
`pnpm check` passed with zero errors and warnings. Prettier and whitespace
checks passed. Shared transcript and browser acceptance follow in separate slices.

### Phase 3 shared-transcript slice — 2026-09-08

`ChatScreenLayout` now supplies common theme/background geometry to the writer
adapter and `ReaderTranscript`. Reader rendering uses explicit confirmed
settings, persona and module owners; the composer creates no draft and invokes
the existing takeover controller. Static portraits and passive character/module
backgrounds avoid writer display runtimes. Narrow waifu layouts remain readable,
and waifuMobile reserves usable transcript/composer height.

Ordinary and custom markup keep safe links/disclosures while executable controls
are disabled with a localized reason. Capture handlers and existing action-owner
guards deny click, keyboard and direct script invocation. Deferred image work
checks session, owner, parse and DOM freshness. Unsupported executable custom
templates retain the existing readable limited-display fallback.

Focused transcript/rendering validation passed (186 tests) across
`ReaderTranscript.svelte.test.ts`, `Chat.customHtml.test.ts`,
`ChatBody.svelte.test.ts`, `ChatBody.parseMemo.test.ts`,
`ChatScreen.characterOwner.test.ts`, `readerPassiveHtml.dom.test.ts`,
`characterImage.owner.test.ts`, and parser `renderFastPaths.test.ts`.
Prettier and whitespace checks passed. Actual desktop/mobile and streaming
acceptance remains pending.

### Phase 4 focused lifecycle verification — 2026-09-08

The combined session/demotion/local-mutation/route suites passed (42 tests),
reader generation observation/stream/row suites passed (95), and connected-reader
synchronization passed (20). Commands:

```sh
pnpm exec vitest run src/ts/server/readerDemotion.dom.test.ts src/ts/readerLocalMutations.svelte.test.ts src/ts/readerRouteScope.test.ts src/ts/clientSession.test.ts src/ts/server/commands.clientSession.test.ts --bail=1
pnpm exec vitest run src/ts/server/readerGenerationObservation.test.ts src/ts/server/readerGenerationStream.test.ts src/lib/ChatScreens/readerGenerationRows.test.ts --bail=1
pnpm test -- src/ts/server/connectedReaderSync.test.ts
```

Together with the earlier bootstrap/access suites these cover retained writer
intent, current capability checks, promotion races, generation reconciliation,
and session/lineage fences. Browser lifecycle acceptance remains pending.

### Final-check repairs — 2026-09-08

The first aggregate run detected the new Return to reading key missing from the
required complete Korean locale. Added `읽던 대화로 돌아가기`;
`pnpm test -- src/lang/index.test.ts` then passed (22 tests). It also detected
shared-control inventory source moves and broad reads in new smoke-only probes.
Those are being repaired and verified before final acceptance; no production
aggregate-read allowance or relaxed ownership gate is introduced.

Browser acceptance exposed a missing copy affordance in the existing mobilechat
bubble branch. Readers now receive the existing guarded copy action there;
writer controls remain unavailable. Four DOM regressions cover character/user
bubbles at 320px and 900px, plain-text clipboard output and absent authoring
controls. `pnpm test -- src/lib/ChatScreens/Chat.customHtml.test.ts` passed
(86 tests). Browser recheck follows the rebuild.

The stable-control inventory now names the extracted shared views, and its
scanner explicitly includes literal conditional delete markers. Its focused
suite passed (5 tests), preserving the ownership gate. Smoke probes now use
narrow character resources and omit an unrelated legacy aggregate endpoint;
`pnpm check:server` then passed all protocol/shared-core, architecture inventory,
Fastify and browser-smoke checks without baseline expansion.

The first aggregate finished with 9,212 frontend tests passing, two repaired
locale/inventory failures and three pre-existing skips; server tests, frontend
check, topology, current docs and smoke build passed. A final complete aggregate
run is in progress after those repairs. Initial browser acceptance passed 16/19;
two copy failures required the runtime repair above, and a lineage fixture's
ambiguous takeover selector was narrowed to the shell control (focused rerun
passed). The browser rebuild and final proof are in progress.

The second complete `pnpm test:agent` run passed all seven lanes: 720 frontend
files (9,219 passed, three skipped), 235 server files (4,356 passed, two skipped),
all typechecks, architecture inventory, topology, current docs and the smoke
build. It completed in 3m 33.6s. Subsequent browser/visual review found two
additional boundaries requiring final repair: an inherited static writer
sidebar import loaded Settings dependencies in readers, and light mobilechat
bubbles inherited inverted prose colors. Final-source acceptance will follow
those narrow fixes and their browser/typecheck/integration rechecks.

The writer chat-list adapter now loads Toggles lazily after current write access,
with a session check when the import resolves. This removes its inherited
Settings-renderer dependency from reader startup. SideChatList passed 70 tests,
including no reader import and no mount after a deferred import crosses demotion;
the control inventory still passed five tests. Formatting and whitespace checks
passed. Actual emitted-chunk denial is being rechecked in the browser.

Visual review also corrected reader light-bubble typography and colored-folder
foregrounds. Reader mobilechat uses dark message/disclosure text and blue links,
while known dark folder colors use white labels. Custom HTML/reader action tests
passed (86), and ObserverShell passed 29 after the folder-style adjustment.
The browser fixture now checks actual computed colors as well as screenshots.

Reader panel appearance is now derived once from confirmed app colors and the
shared frame's translucent panel color, then passed through explicit read-owner
context. It covers portrait panels as well as fixed light message bubbles/cards;
prose, native disclosures, links, headings and composer guidance use that local
palette. Readable custom text colors remain effective. Writer paint is unchanged.
The nine palette cases cover opposite app/panel tones and custom-color fallback;
Chat custom HTML/action tests passed 86 and ReaderTranscript passed 32 (127 total).
Actual four-theme text contrast and final integration checks follow.

The final portrait layering correction places decorative portraits below reader
content so Refresh and transcript text remain visible. ReaderTranscript passed
32 tests after this adjustment. Four-theme browser contrast had already passed
(minimum ratios 6.09:1 mobilechat, 7.48:1 portrait themes and 5.49:1 fastify);
the final rebuild verifies those values alongside unobscured controls.

Parent screenshot review then caught the desktop portrait being covered by the
absolute passive background. Giving the reader portrait image a positioned
painting layer fixes that independent overlap. The final desktop/mobile parity
rerun passed both cases, including a loaded-image occlusion assertion and fresh
screenshot review. No further runtime change remains; the combined 19 browser
journeys passed before this isolated image-layer adjustment and all affected
visual/action assertions passed again afterward.

## Final Browser and Integration Acceptance — 2026-09-08

Runtime source is `712f1b7df` (all implementation commits through the final
portrait paint-order correction). The browser fixture/probes are committed as
a separate verification slice immediately after that revision. Shared reader
presentation is the normal view; there is no temporary presentation switch,
and the existing reader-authority rollout is unchanged. The duplicate dedicated
navigation layout is removed; reader controllers, projections and lifecycle
machinery remain.

### Actual browser evidence

The combined campaign passed **19 tests in 1.2m** with:

```sh
pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/readOnlyAppUx.spec.ts server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts server/fastify/browser-smoke/connectedReaderGeneration.spec.ts server/fastify/browser-smoke/connectedReaderRollout.spec.ts server/fastify/browser-smoke/connectedWriterSwitching.spec.ts server/fastify/browser-smoke/visibleStateRecovery.spec.ts --output=/tmp/read-only-app-browser-final-results
```

The isolated final portrait CSS correction was rebuilt with `pnpm build:smoke`
and both affected desktop/mobile journeys passed again (**2 tests, 16.7s**):

```sh
pnpm exec playwright test -c playwright.fastify-smoke.config.ts server/fastify/browser-smoke/readOnlyAppUx.spec.ts --grep 'shared read-only app' --output=/tmp/read-only-app-browser-portrait-parity
```

Viewports were desktop **1440 × 1000** and Pixel 7 emulation **412 × 839 CSS
pixels**. Parent and browser-owner screenshot review confirmed the shared rail,
folders/search/pins, mobile focus containment, readable transcript/composer and
visible controls/portraits. Four themes were exercised: mobilechat, waifu,
waifuMobile and fastify. The fixture measures eight reading/control contrast
ratios per theme, scroll/composer geometry, horizontal overflow and portrait
occlusion, alongside screenshots. Minimum observed text contrast was 6.09:1,
7.48:1, 7.48:1 and 5.49:1 respectively.

The new fixture verifies keyboard and direct handler activation, safe copy and
links/disclosures, history paging, Home/grid and independent routes/history,
Settings/plugin no-mount/no-load, local-only trigger and Lua callback denial,
restored overlay closure, retained search/folders on replay recovery, deleted
selected-chat fallback, and protected-DOM clearing on auth loss. Native outbox,
composer drafts, SQL revisions/events/ownership and network assertions distinguish
authenticated cache reads from domain mutations; reader browsing creates no
writer selection changes or new domain intent.

Existing connected-reader/writer suites provide real controlled generation,
finalization/receipt races, takeover, demotion with retained drafts, reconnect,
and database-import lineage replacement. All disposable harnesses were closed.
Logs and screenshots are local review artifacts under the output directories
above; they are not deployment evidence.

### Final integration checks

`pnpm test:agent` passed every lane in **3m 54.0s**:

- Frontend: 721 files, **9,230 passed**, three skipped.
- Fastify: 235 files, **4,356 passed**, two skipped.
- Protocol/shared-core/Fastify/browser-smoke typechecks and architecture inventory.
- Svelte check with zero errors/warnings, test topology, current documentation,
  and the browser-smoke build.

The final browser fixture addition also passed
`pnpm exec tsc -p tsconfig.browser-smoke.json --noEmit`.
Prettier and whitespace checks passed for all implementation and fixture slices.
The aggregate was required because shared routes, state ownership and role
transitions cross multiple areas. No `pnpm test:all` was run.

### Acceptance limits

This is local Chromium/disposable-data evidence, including mobile emulation,
controlled generation and injected 409 replay-exhaustion/401 read failures.
Physical mobile devices and the external production deployment were not tested;
deployment was not part of the plan. Passive custom HTML retains its documented
static/readable fallback; executable templates and interactive scripts remain
excluded. Panel contrast derives translucent-image backing from confirmed app
colors, so arbitrary user-authored background imagery/CSS is not certified by
this finite fixture matrix.

Phases 2–4 are accepted by this combined component, lifecycle, browser and visual
evidence. Phase 5's final documentation/archive consistency checks follow below.
