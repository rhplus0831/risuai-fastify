# Unified Read-Only Workspace and Role-First Bootstrap

Date: 2026-09-10

Start at [status](status.md) for the current phase, decisions, next action, and
verification evidence. This document defines intended behavior and completion
criteria; it does not describe shipped implementation. Current source,
[STRUCTURE](../../../STRUCTURE.md), and the
[architecture guides](../../../docs/structure/README.md) remain authoritative for
shipped behavior.

This is a new follow-up to the completed
[connected read-only clients](../connected-read-only-clients/PLAN.md),
[read-only app UX](../read-only-app-ux/PLAN.md),
and
[read-only shell parity](../read-only-shell-parity/PLAN.md)
workstreams. Those packages remain closed. This plan preserves their accepted
authority, projection, accessibility, and transition guarantees while replacing
the dedicated observer presentation and the early observer-to-writer render
path.

## Objective and Document Ownership

Remove `ObserverShell.svelte` as a separate application environment. Resolve the
initial client role before exposing the application workspace, then use the
normal RisuAI visual environment with capability-derived read-only behavior when
the page cannot write. A compact top-right action indicates read-only status and
allows an explicit **Use this device** promotion.

Successful automatic writer startup should not load and mount an observer
projection before replacing it with the writer projection. Connected readers
must retain useful committed-data browsing without being able to persist
selection, author, generate, open restricted applications, or execute delayed
writer work.

This `PLAN.md` owns the stable product contract, architecture constraints,
scope, rollout, phase order, and completion criteria. [Inventory](inventory.md)
maps current source, test, documentation, and measurement owners. The
[phase index](phases/README.md) defines execution rules and bounded phase
documents. Only `status.md` records implementation progress, decisions made
during execution, verification results, failures, and the current cursor.

## Product Contract

### Role-first initial startup

Mounting the Svelte root may precede bootstrap so the loading and authentication
surfaces remain available. The application workspace itself must not render
until the initial page role is resolved.

1. Resolve the page identity and perform authenticated read-only ownership
   discovery without adopting the returned revision as command authority.
2. If the page may automatically acquire or resume the writer, attempt that
   acquisition before applying a reader shell projection.
3. On success, complete writer recovery in the existing order: writer
   authorization, outbox preparation, receipt acknowledgement, pending-intent
   replay, authoritative post-replay shell, revision/event reconciliation, and
   accepted event subscription. Only then expose writer mutation capability.
4. If the page resolves as a reader, or an acquisition/recovery failure safely
   settles into reading, load one coherent authenticated reader projection and
   expose the workspace in read-only mode.
5. Authentication-required, uninitialized-server, superseded-session, and fatal
   startup states retain their explicit handling. They must not be mislabeled as
   a usable reader.

A successful automatic writer startup has exactly one
`GET /api/v1/resources/shell` read: the authoritative post-replay shell. A reader
startup has exactly one coherent reader shell read. An explicit later
reader-to-writer promotion still requires the authoritative post-replay shell;
this correctness read is not duplicate startup work.

### Workspace access model

Do not introduce an independently mutable role or read-only flag. Derive a
single presentation model from the current client-session and startup-readiness
authorities while retaining their narrower capabilities:

| Presentation mode | Visible surface                           | Browsing                                   | Persisted selection or authoring              |
| ----------------- | ----------------------------------------- | ------------------------------------------ | --------------------------------------------- |
| `booting`         | Loading/auth/setup/error boundary         | None applied to writer stores              | Denied                                        |
| `read-only`       | Normal workspace with device action       | Committed reader data and local routes     | Denied                                        |
| `promoting`       | Same readable workspace; action is busy   | Existing local reader route remains usable | Denied                                        |
| `writer`          | Normal workspace without reader indicator | Normal writer routing                      | Admitted only by existing narrow capabilities |

The implementation may choose different symbol names, but it must retain these
separate meanings:

- readable projection and local browsing readiness;
- writer route/persisted-selection readiness;
- ordinary mutation readiness; and
- generation readiness after plugin, recovery, chat, and prompt dependencies.

The read-only indicator disappears only when current writer authority and the
post-replay projection/event boundary are established. Composer generation may
remain disabled until the later generation capability becomes ready.

### Familiar read-only workspace

Read-only state changes capabilities and data ownership, not the application's
outer visual identity. Reader and writer modes use the same role-neutral
`ConversationShell`, canonical geometry, responsive classification, navigation
rail, sidebar panel, and main-content placement.

Keep reader and writer controllers separate underneath shared presentation:

- the reader controller supplies server-confirmed projections, stable route IDs,
  local search/folder/drawer state, lazy transcript reads, and live generation
  observation;
- the writer controller retains persisted selection, commands, optimistic
  outcomes, drafts, plugins, generation, and authoring lifecycles; and
- shared view components accept explicit data, capability, and callback inputs.
  Missing reader callbacks must never fall back to writer stores or commands.

Do not mount the complete writer `Sidebar` or `DefaultChatScreen` controller in
read-only mode merely to obtain visual parity. Extract or adapt the smallest
presentation boundaries and reuse the existing read-only `Chats`, `Chat`, and
reader read-owner mechanisms.

### Read-only navigation and route behavior

Before entering a chat, a reader may use Home, the character grid, character
selection, chat selection, pinned/recent shortcuts, browser history, local
folder expansion, and local search. These actions update only the browser route
and reader-owned presentation state.

Reader character selection must not call the writer `changeChar()` path, update
`selectedCharID`, change the authoritative `currentChar` or `chatPage`, update
`lastInteraction`, dispatch `character.selected` or chat-selection commands, or
create an outbox record. Chat selection follows the same local-only rule.

Settings and Playground are unavailable in read-only mode:

- visible launch controls are disabled with a localized reason;
- hover/focus intent does not preload their components or resources;
- shortcuts, restored stores, overlays, and delegated callbacks cannot open
  them; and
- a direct restricted URL is rejected before authoring resources or components
  load and shows a localized write-access gate with safe navigation.

On a read-only character/chat URL, the sidebar enters `back-only` interaction:

- one native **Go back** button remains active and navigates locally to the
  character route without a chat ID;
- navigation-rail actions, pinned chats, character/folder controls, chat rows,
  search fields, author-note controls, toggles, organization controls, and
  plugin additions are non-interactive; and
- the Back button must not be nested inside an `inert` ancestor. Disabled
  controls retain an accessible explanation or are removed from the accessibility
  tree with an adjacent read-only explanation.

### Transcript and composer behavior

Reader transcripts continue to use authenticated, lineage/revision-fenced
reader owners and passive display policy. Scrolling, text selection, copy,
ordinary safe links, local disclosure, history paging, and explicit read refresh
remain available where their existing reader policy permits them.

Every action that can write, execute application logic, or affect writer-owned
runtime state remains unavailable, including message edit/delete/truncate,
reroll/regenerate, greeting selection, translation writes, script/Lua/plugin
buttons, generation start/stop/retry, authoring dialogs, imports, and media or
provider operations that require writer authority.

The composer keeps the normal visual chrome but is inert in read-only mode:

- message, translated-message, Draft, and BTW fields are disabled or read-only
  as appropriate and cannot receive programmatic write shortcuts;
- send/continue, hamburger menu, attachment, sticker, suggestion, Draft/BTW,
  reroll, and generation controls are disabled or not mounted;
- a page that has never been a writer does not restore or persist a writer draft,
  install input-hook/plugin controllers, or start writer effects; and
- writer loss captures an existing writer draft synchronously before the
  workspace becomes read-only. The reader projection never exposes that draft.

### Floating device action

Replace the observer-only bottom takeover/status region with one compact action
anchored to the top-right of the visual viewport shell. It remains available on
Home, grid, character, and chat reader routes without changing shell geometry.

The action must:

- expose an icon plus an accessible name such as **Read only — Use this device**;
- use safe-area offsets and avoid the responsive navigation control and route
  status surfaces;
- show busy state and reject duplicate activation during promotion/recovery;
- explain offline/interrupted/unavailable states without enabling an unsafe
  takeover;
- preserve confirmation, ownership preconditions, cancellation, failure,
  supersession, and retry behavior from the current promotion flow;
- announce lifecycle/result changes through a localized live region; and
- restore focus after a cancelled or failed operation when the action remains
  available.

### Promotion, demotion, and reader intent

Reader browsing never becomes a domain mutation retroactively. Promotion may
keep the current reader URL and display target, but it must not replay an earlier
reader character click as a `lastInteraction` update or `character.selected`
command merely because writer authority became available. A new explicit
selection made after writer mode begins may use normal persistence.

Successful promotion retains the readable workspace until writer recovery has
installed the post-replay projection and accepted event stream. Cancellation or
failure returns to the same reader route and projection. Superseded operations
cannot affect a newer session or role.

Writer loss revokes mutation and generation synchronously, captures drafts,
stops authority-bearing work, closes restricted overlays, and returns to a
committed reader projection without exposing optimistic writer state.
Authentication loss clears protected content. Database/lineage replacement
clears obsolete local route, hydration, cache, and display identities while
retaining only content permitted by the established replacement lifecycle.

## Architecture and Safety Invariants

### Presentation is not authorization

Disabled controls are an accessibility and consistency requirement, not the
security boundary. Preserve `canUseClientWriteAccess()`, `canMutate()`,
`canGenerate()`, command admission, server active-writer checks, operation/session
generation fences, and post-await freshness checks. Direct calls, hotkeys,
drag/drop, plugin callbacks, DOM-delegated handlers, timers, and held promises
must fail closed even if a control is accidentally exposed.

Every shared surface lands with its handler/effect/shortcut/drop and delayed
continuation guards. Phase 5 challenges the integrated system; it is not the
first phase in which earlier surfaces become safe.

### Projection and selection ownership

Reader display uses only server-confirmed shell, character, chat, message,
display-setting, and operational projections. Pending writer values and
optimistic overlays do not enter reader presentation. Reader route IDs are
presentation targets, not canonical selection.

The implementation must make display selection explicit where current writer
components assume `selectedCharID` or `chatPage`. Do not temporarily write those
stores in reader mode. Prefer stable IDs and existing `ChatReadOwners`-style
interfaces over indexes and aggregate mutable database fallbacks.

### Mount and bundle boundaries

Keep the outer workspace frame mounted during an established reader's promotion
or a writer's demotion. Conditional reader/writer controllers may change, but
the shell geometry must not be reconstructed or animate because authority
changed. Preserve reader-local route, navigation drawer/search/folder state,
transcript position where valid, and focus ownership.

Do not instantiate writer-only draft, plugin, scripting, generation, or
authoring controllers for a reader. Prefer loading a reader-only controller only
after a reader disposition is known if that reduces the automatic writer's
initial JavaScript closure. Any dynamic import must preserve the visible loading,
error, and retry contract.

## Scope

### In scope

- Client role resolution and automatic writer startup sequencing.
- Startup-readiness/presentation capability naming and derivation.
- App-level removal of the dedicated ObserverShell render branch.
- Shared workspace, sidebar, route, transcript, and composer presentation
  boundaries needed for the stated read-only behavior.
- A top-right read-only/device-promotion action.
- Local reader selection and non-replayed last-interaction behavior.
- Promotion, demotion, reconnect, auth, lineage, draft, and generation-observer
  transition containment.
- Startup/resource/bundle/transition measurements and privacy-safe telemetry
  needed for a reversible rollout.
- Focused component, DOM, client lifecycle, browser-smoke, inventory, and current
  documentation updates.

### Out of scope

- Multi-writer mutation, offline authoring, or a new persistence model.
- Changing Fastify's single-writer policy or weakening server authorization.
- Reader access to Settings, Playground, plugin/custom-GUI applications,
  interactive scripts, imports, authoring, or provider execution.
- Persisting reader search, folder expansion, drawer state, or selection.
- A general redesign of the writer navigation, transcript, composer, theme, or
  responsive layout.
- Removing reader projection, synchronization, generation observation, cache,
  revision, authentication, or lineage fencing because ObserverShell is removed.
- Database or durable domain-schema migrations. If implementation proves one is
  necessary, stop and replan before making it.

## Rollout Strategy

Use one short-lived, whole-path rollout boundary if production comparison or
incremental browser proof requires it. The switch selects either the complete
current observer startup/presentation path or the complete role-first unified
workspace path; do not independently combine partial startup, navigation, and
composer modes.

The existing `VITE_FAST_BOOTSTRAP_OBSERVER` behavior remains unchanged for the
legacy path until closeout. Avoid a permanent cross-product of rollout flags.
Record the exact selection and retirement plan in `status.md` before Phase 2
runtime work. The final state has one connected-client startup path and no
observer-shell rollout flag, smoke storage override, or permanent compatibility
branch.

Telemetry is diagnostic-only and cannot affect capabilities. During rollout,
record a privacy-safe path/mode dimension sufficient to compare startup
readiness, attempt failures, retry pressure, shell-request counts, and transition
cost. If the wire telemetry schema changes, update browser/server schemas,
consumers, tests, retention documentation, and compatibility handling in the
same phase.

## Performance and Verification Contract

Phase 0 regenerates the current small/large, cold/warm baseline and records the
measurement environment before runtime code changes. The current ignored local
artifact shows two shell reads in each sampled automatic writer case, but it is
diagnostic input rather than accepted portable evidence.

Measure at minimum:

- bootstrap, role-resolution, reader-ready, writer-ready, chat-ready, and
  background-ready timing;
- shell request count, payload bytes, cache hits/misses, and duplicate resource
  application;
- initial JavaScript transfer/decoded size and protected-boundary imports;
- workspace/controller mount counts and retained DOM identity;
- long tasks and owned shell rectangle/layout-shift evidence around role changes;
- mutations before writer-ready and generations before chat-ready; and
- reader no-command/no-outbox/no-selection/no-last-interaction outcomes.

Phase 0 must ratify comparison thresholds before behavior changes so acceptance
cannot be weakened after results are known. Regardless of timing variance, the
following are hard requirements:

- one shell read for successful automatic writer startup;
- one shell read for settled initial reader startup;
- zero reader-origin domain commands and outbox rows;
- zero mutations before writer-ready;
- zero generation starts before chat-ready; and
- no automatic role-transition movement attributable to shell reconstruction.

Use focused tests throughout. Follow Crunch Mode: do not run `pnpm test:agent`
or `pnpm test:all`. Run only directly relevant suites, type/build checks, and
selected browser journeys. Planning-only changes require documentation,
formatting, link/index, and whitespace validation but no runtime suite.

## Phase Order

| Phase                                                                                           | Outcome                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [0. Contract, inventory, and baseline](phases/phase-0-contract-inventory-and-baseline.md)       | Ratified state/action matrices, current-source inventory, rollout choice, and reproducible pre-change performance evidence |
| [1. Access and readiness model](phases/phase-1-access-and-readiness-model.md)                   | Derived workspace capabilities and explicit local-versus-persisted route ownership without changing the visible path       |
| [2. Role-first bootstrap](phases/phase-2-role-first-bootstrap.md)                               | Automatic writers avoid the reader projection/mount; settled readers still receive one coherent projection                 |
| [3. Unified shell and navigation](phases/phase-3-unified-shell-and-navigation.md)               | Persistent normal workspace, local reader browsing, restricted routes, back-only chat sidebar, and top-right device action |
| [4. Transcript and composer containment](phases/phase-4-transcript-and-composer-containment.md) | Normal transcript/composer presentation with reader-safe owners and complete authoring denial                              |
| [5. Role transitions and performance](phases/phase-5-role-transitions-and-performance.md)       | Promotion/demotion/reconnect/auth/lineage/draft behavior and measured transition/startup acceptance                        |
| [6. Rollout cleanup and closeout](phases/phase-6-rollout-cleanup-and-closeout.md)               | Unified path becomes final, ObserverShell scaffolding is removed, current docs are updated, and the plan is archived       |

Phases are sequential because they share bootstrap, session, App, navigation,
and chat owners. Read-only research and test discovery may run concurrently, but
do not merge dependent implementation slices out of order. Each phase can span
multiple tasks or commits; accept it only with evidence in `status.md`.

## Completion Criteria

The workstream is complete only when:

- all seven phases are accepted with final-source evidence in `status.md`;
- successful automatic writer startup never mounts reader UI and performs one
  shell read;
- settled readers use the normal workspace identity with the specified top-right
  action and restricted behavior;
- reader navigation never persists selection, `lastInteraction`, a command, or
  an outbox record, including after promotion without a new writer interaction;
- Settings and Playground are inaccessible through controls, direct routes,
  shortcuts, restored state, prefetch, overlays, and late callbacks;
- Back is the only interactive sidebar control on a reader chat route;
- composer, message, script, plugin, import, and generation write paths are
  denied at both presentation and action/transport boundaries;
- promotion, failure, writer loss, reconnect, auth loss, lineage replacement,
  drafts, live generation observation, focus, responsive layout, and reduced
  motion retain their accepted guarantees;
- focused tests, relevant type/build checks, selected real-browser journeys,
  performance/bundle measurements, documentation validation, formatting, and
  whitespace checks pass;
- current architecture and test guides describe the shipped unified path; and
- the completed package moves to `.archived-docs/`, its archive indexes are
  updated, and `docs/plan/README.md` again reflects the true active-plan state.

## Replanning Triggers

Stop the active phase and update this plan before proceeding if implementation
requires:

- a database or durable domain-schema migration;
- weaker writer authorization or a change to the single-writer contract;
- mounting the unmodified writer controller for readers;
- reader access to an excluded application or execution surface;
- automatic persistence of reader route intent or last interaction;
- more than one independently selectable rollout switch;
- removal of a projection, draft, auth, revision, lineage, or generation fence;
  or
- a performance tradeoff outside the thresholds ratified in Phase 0.
