# Read-Only Mode in the Existing App UX

Date: 2026-09-08

Start at [status](status.md) for the current phase, decisions, next action, and
verification evidence. This document defines the intended behavior; it does not
describe a shipped implementation.

## Objective and Document Ownership

Give a connected reader the familiar RisuAI sidebar, character and chat lists,
transcript appearance, and responsive layout while another device remains the
writer. Preserve independent browsing, committed-data isolation, live generation
observation, and the existing explicit writer takeover flow.

This plan owns the stable contract, scope, dependencies, and completion criteria.
[Inventory](inventory.md) maps source and test owners. [Phase documents](phases/README.md)
define bounded implementation slices. Only `status.md` records execution progress,
acceptance, and verification results. Creating this package does not complete a phase.
Current source, [STRUCTURE](../../../STRUCTURE.md), and the
[architecture guides](../../structure/README.md) remain authoritative for shipped behavior.

## Product Contract

### Reading in the familiar interface

Readers can browse Home and the character grid, select characters and chats,
expand folders locally, search the lists, follow browser back/forward and deep
links, load older messages, copy text, scroll, and observe replies being generated
by the writer. Preserve applicable themes, fonts, backgrounds, avatars, folder
ordering, and pinned-chat presentation using server-confirmed display data.

Show a compact read-only indicator and the existing explicit **Use this device**
action in the shared layout. The composer area explains that write access is
required and offers that same action; it does not create new reader drafts.
Editing becomes available only after writer authority and recovery are ready.
Generation keeps its separate readiness requirement.

### Access policy

| Surface or action                                                                                    | Reader behavior                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Home, character grid, character/chat selection, transcript/history                                   | Available through reader-scoped data and local selection                                              |
| Folder expansion, list search, scroll, unread display                                                | Available as local presentation state; no domain command                                              |
| Passive message formatting, assets, copy, ordinary safe links and disclosure controls                | Available through the safe reader rendering path                                                      |
| Settings                                                                                             | Block all Settings pages, dialogs, routes, menus, and shortcuts; disable visible launch controls      |
| Plugin panels                                                                                        | Block panel/custom-GUI entry points, routes, and restored overlays; do not mount or execute plugin UI |
| Interactive scripts                                                                                  | Disable script buttons and deny all invocation paths, including scripts whose effects are only local  |
| Send, regenerate, stop generation, edit, create, delete, reorder, import, and other domain mutations | Unavailable; enforce current authority at the action boundary as well as the control                  |
| Explicit writer takeover                                                                             | Available through the existing confirmation, acquisition, and recovery lifecycle                      |

Settings, plugin panels, and interactive scripts are fixed exclusions for this
workstream. They are not later read-only parity milestones. Authenticated reads
of display settings needed to render the interface remain allowed; blocking the
Settings UI does not change the server's existing read authorization model.

Interactive scripts include message `risu-trigger`/`risu-btn` actions, Lua/button
callbacks, plugin/custom-GUI actions, and executable custom-markup handlers.
No reader click, shortcut, delegated event, effect, or late callback may invoke
them. Preserve existing isolated, side-effect-free server display transforms
and their readable fallback. Do not start the general browser script or plugin
runtime to achieve display readiness. Static safe markup, CSS, assets, and native
browser interactions remain readable where the existing renderer supports them.

Disable visible native controls and provide an accessible, localized reason.
Non-native controls must also reject activation; styling or `aria-disabled`
alone is insufficient. In-app blocked actions leave the reader's selection
unchanged. A directly entered blocked route displays a localized write-access
gate in the shared shell, with Home and Return to reading where a valid prior
selection exists. Reject it before authoring component mounting, route warming,
or authoring-specific resource loading. Do not acquire writer access or reopen
an old restricted overlay automatically.

## Architecture and Invariants

### Shared presentation, explicit owners

Extract reusable layout and navigation presentation from the existing shell,
sidebar, and chat-list components. Pass explicit display data, stable selected
IDs, capabilities, and callbacks. A writer adapter preserves the existing writer
behavior; a reader adapter owns reader navigation and committed projections.
Shared views must not silently fall back to mutable writer stores or commands
when an input or callback is absent.

Retain the connected-reader controller and synchronization machinery. Initially
retain `ReaderTranscript` as the reader transcript controller, continuing to
share `Chats` and `Chat` underneath. Extract layout/chrome needed from the normal
chat screen; do not mount its writer controller unchanged to obtain visual parity.
Reader display readiness must not wait for writer plugins, composer recovery,
or generation readiness. A shell preview may paint early, but protected content
must still respect initial role resolution and authenticated read readiness.

### Committed data and independent navigation

Use the existing shell, character-detail, and paginated-message APIs. Extend
reader projections only with confirmed fields needed for navigation and passive
display: order, folders, pins, labels, and audited theme/background metadata.
Preserve revision, session-generation, and database-lineage fences and lazy
hydration. Prefer existing payload fields; a wire change requires explicit
schema, producer, consumer, and compatibility coverage if one proves necessary.

Reader character/chat IDs come from the local route and reader controller.
Browsing must not dispatch writer selection or change shared `chatPage` or
`selectedCharID`. Keep folder expansion, search, scroll, and unread presentation
local. Do not persist reader expansion through the writer's optimistic metadata
path. Missing or deleted targets resolve to a readable empty/missing state or
valid local fallback without mutating writer selection.

On demotion, discard optimistic display projections while preserving pending
writer intent in its existing draft/recovery owners. Readers neither create
domain commands nor enqueue or replay retained writer intent. Read/cache traffic
and existing authenticated operational traffic are not domain mutations.

### Authority and lifecycle

Derive capabilities from the existing client-session and startup-readiness
authorities. Avoid a second role flag that can drift from acquisition, recovery,
or writer-loss state. UI guards do not replace server write authorization.

Every newly shared surface ships with its own handler/effect/shortcut/drop and
async-continuation guards. Phase 4 verifies their combined behavior; it is not
the point at which earlier surfaces first become protected.

Preserve these transitions:

- Promotion retains the latest valid reader route throughout confirmation,
  acquisition, recovery, cancellation, failure, and ownership races. Enable
  editing only after confirmed authority and recovery; enable generation only
  after its additional readiness gate.
- Writer loss immediately revokes actions, captures drafts, stops writer work,
  and closes restricted overlays. Deferred callbacks cannot reopen or execute
  Settings, plugins, or scripts after demotion.
- Reconnect and replay-gap recovery retain valid reader selection and refresh
  confirmed resources. Stale reads and stream events cannot overwrite a newer
  session, route selection, revision, or database lineage.
- Authentication loss clears protected content. Database replacement clears
  old identities and local view state tied to that lineage.
- Reader generation observation remains independent from the client session's
  lifecycle-generation counter. Streaming and persisted messages reconcile
  without duplicates, and reader navigation never cancels writer generation.

## Scope and Rollout

This is a frontend presentation/ownership refactor using the existing single-writer
backend. It does not add multi-writer support, offline authoring, a new persistence
model, Settings inspection, plugin-panel compatibility, or interactive scripts
for readers. No database migration is expected.

Introduce a temporary shared-presentation switch only if needed to stage the
refactor. It must be independent of the existing `VITE_FAST_BOOTSTRAP_OBSERVER`
reader-authority rollout. A presentation fallback must retain connected-reader
authority and the exclusions above. Do not use rollout to give a reader the
writer runtime. After acceptance, make shared presentation the normal reader
view and remove duplicated dedicated layout and temporary rollout scaffolding.
Retain reader controllers, projections, synchronization, and lifecycle tests.

## Phase Order

| Phase                                                                                        | Outcome                                                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                        | Complete entry/action matrix, component interfaces, committed-field map, and first testable slice |
| [1. Reader boundary and navigation data](phases/phase-1-reader-boundary-and-data.md)         | Capability/route denial and committed navigation projection before shared UI exposure             |
| [2. Shared shell and navigation](phases/phase-2-shared-shell-and-navigation.md)              | Familiar Home, character/sidebar, and chat-list browsing with independent selection               |
| [3. Shared transcript and passive display](phases/phase-3-transcript-and-passive-display.md) | Familiar transcript chrome and appearance using reader-safe data and rendering                    |
| [4. Lifecycle and action containment](phases/phase-4-lifecycle-and-containment.md)           | Integrated role changes, stale-callback denial, recovery, and live observation                    |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                    | Desktop/mobile browser proof, final checks, shared-view default, and layout cleanup               |

## Validation and Completion

Use focused ownership, route, projection, component, rendering, and lifecycle
tests with each relevant slice. Add tests for behavioral boundaries and actual
regressions, not static copies of the implementation. Use the existing browser
smoke harness with disposable agent data for real two-client proof.

Completion requires evidence that writer and reader can browse different chats;
reader browsing and blocked activation create no domain writes or new outbox
entries; Settings, plugin panels, and interactive scripts cannot enter through
alternate paths; passive rendering and live generation remain usable; writer
behavior, takeover, demotion, drafts, reconnect, and lineage isolation survive;
and desktop/mobile keyboard, focus, scrolling, and layout remain usable.

After implementation and self-review are complete, run `pnpm test:agent` because
this change crosses shared routing, state ownership, and role transitions. Run
the relevant focused browser journeys as well; the aggregate's smoke build is
not evidence that those journeys executed. Follow root guidance on failure
rechecks. Do not run `pnpm test:all` unless explicitly requested.

Documentation changes require `pnpm check:docs`, the
[explicit plan/index check](phases/README.md#plan-document-validation), formatting,
and whitespace validation. Planning alone requires no runtime suite. Update
current architecture and test guides when behavior ships, then archive the
completed planning package with its evidence and update the active-plan index.
