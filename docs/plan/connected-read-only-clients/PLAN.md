# Connected Read-Only Clients Plan

Date: 2026-09-06

Planning prepared; implementation has not started. Read [status](status.md)
for the current phase, next slice, decisions, and verification evidence.

## Objective and Document Ownership

Keep authenticated clients connected when they do not own write access. They
can browse conversations and receive updates. An explicit **Use this device**
action transfers write access; the previous writer becomes a connected reader.
Preserve the server's single-writer architecture.

This plan owns product behavior, scope, invariants, dependencies, and completion
criteria. [Phase documents](phases/README.md) own bounded implementation work
and acceptance checks. [Inventory](inventory.md) owns the source-boundary map
and its implementation dispositions. Only `status.md` owns execution progress,
phase acceptance, source anchors, and verification summaries. Planning a phase
does not complete it. Current source and the
[architecture guides](../../structure/README.md) remain authoritative for
shipped behavior.

Use the project's stable-plan, moving-status, bounded-phase structure, as in
the [maintainability workstream](../../../.archived-docs/performance-and-stability/maintainability-and-performance/PLAN.md).
The [fast-bootstrap observer work](../../../.archived-docs/fast-bootstrap/06-observer-shell.md)
is historical background. Recheck its claims against current code; extend the
current observer foundations in this new workstream.

## Planning Evidence

Source anchor: `696aecef2dd22dc50ebeca47144cad2b8f5c68b0`.

- `server/fastify/src/activeWriter.ts` enforces mutation ownership and tracks
  connected sessions. Authenticated resource reads, command events, and
  generation observation have separate policies in
  `server/fastify/src/routeManifest.ts`.
- `src/ts/server/activeWriterSession.ts` stops resource events, translation
  refresh, generation reattach/finalization refresh, and chat hydration after
  writer loss. Its stay-on-page choice enters the frozen offline state.
  `src/ts/server/events.ts` also rejects subscriptions after writer access loss.
- `src/ts/observerShellFlag.ts` gates a partial observer shell.
  `src/lib/ObserverShell.svelte` displays character information and chat lists;
  it does not render a continuously synchronized transcript. Startup in
  `src/ts/bootstrap.ts` still attempts writer acquisition after the optional
  observer read, and event subscription currently publishes writer readiness.
- `src/ts/startupReadiness.ts` ties ordinary route application and mutation to
  writer readiness. `src/ts/characters.ts` and `src/ts/globalApi.svelte.ts`
  dispatch persisted selection changes during normal navigation.
- Pending mutation recovery, scoped drafts, generation observation, and
  writer-owned effects already have separate owners. Several plugin setters
  still change local resource projections when command access is unavailable.
  Central server rejection alone therefore does not establish a read-only UI.

These are source observations, not production incident reproductions or proof
that the proposed behavior already works. The initial inventory identifies
test owners; implementation must add and execute the required behavioral proof.

## Product Contract

### Role, connectivity, and readiness

Represent write role separately from connection health and resource readiness.
An authenticated event connection does not grant write access. Losing writer
ownership does not imply loss of server connectivity. Startup milestones remain
diagnostic history; current capabilities must reflect live authority.

| Situation                     | Required behavior                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connected reader              | Browse supported character/chat routes, load history, select/copy text, receive committed updates, and request write access. Editing and mutation controls are unavailable.           |
| Connected writer              | Existing editing and generation behavior, subject to the current resource, plugin, recovery, and server ownership checks.                                                             |
| Promotion in progress         | Keep readable content and progress visible; ordinary writes remain blocked until ownership and recovery are established.                                                              |
| Reader connection interrupted | Show connection/retry status and the last usable view with clear freshness status. Reconnect as a reader; never acquire write access as a side effect.                                |
| Writer connection interrupted | Report connectivity honestly and preserve the existing pending-intent/draft recovery guarantees. Queued work is not shown as accepted. Revalidate ownership before resuming dispatch. |
| Authentication lost           | Clear authenticated projections, selection, disposable caches, and subscriptions through the existing auth-loss boundary; show authentication UI.                                     |

The initial observer surface covers character/chat lists and conversation
reading. Authoring routes and controls must have an explicit disposition:
read-only display where safe, or an explanatory write-access gate. Reproducing
every editor as a read-only editor is not a release requirement.

The live lifecycle must express the following finite capability contract. These
are semantic states; Phase 0 chooses the concrete store/type names and maps
existing selectors to them. Connection health (connecting, live, interrupted)
is a separate dimension. Authenticated reads require valid auth; route rendering
requires coherent data; generation submission retains its additional readiness
checks.

| Live lifecycle          | Read services and routes                                                      | Ordinary mutations                                 | Ownership/recovery work                                                          |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Resolving session       | Authenticated bootstrap/shell/ownership reads; loading or coherent read view. | Blocked.                                           | Initial acquisition only after authoritative no-owner/first-run decision.        |
| Reading                 | Observer subscriptions and supported read routes.                             | Blocked.                                           | No writer acquisition, outbox adoption/replay, or effect claims.                 |
| Promoting               | Continue coherent reader view and synchronization.                            | Blocked.                                           | One explicit takeover attempt; scoped recovery only after ownership is obtained. |
| Recovering writer       | Read services and coherent read view.                                         | Blocked.                                           | Revalidate ownership, then authorized receipt/outbox/resource recovery.          |
| Writing                 | Normal routes and shared read services.                                       | Allowed under current writer and readiness checks. | Current-owner services only.                                                     |
| Authentication required | Auth flow; authenticated projections and subscriptions cleared.               | Blocked.                                           | No domain recovery until authentication succeeds.                                |

An interrupted writer revalidates authority before transport dispatch resumes;
retaining local pending intent does not authorize network writes. No event
subscription or resource-read completion can transition a reader to writing.

### Startup and explicit switching

1. On an initialized server, determine ownership through authenticated reads
   and current writer state before enabling commands. A client whose session
   differs from the durable writer opens as a reader, even when that writer is
   currently disconnected. Opening, refreshing, focusing, or reconnecting that
   client must not steal ownership.
2. A returning session that still owns the writer may perform existing recovery
   before enabling writes. If there is no registered writer, normal initial
   acquisition remains possible. Preserve first-run initialization and its race
   handling; an uninitialized database is not a usable observer projection.
3. **Use this device** is an explicit request to move write access to the
   requesting client. Explain this consequence in the UI and satisfy the
   server takeover handshake. Opening a reader must not present repeated
   takeover dialogs. The old writer receives a passive read-only status.
4. A failed or superseded promotion returns to a usable reader state. Ordinary
   network recovery does not retry a takeover. Repeated clicks share one local
   promotion operation; simultaneous clients remain subject to server ordering
   and authoritative rejection.
5. Reader navigation is local to its URL/view state. Another writer's selection
   updates must not move the reader to a different conversation. On promotion,
   retain the reader's selected stable IDs when they still exist; any persisted
   selection command happens only after write capability is established.

### Pending edits and generation

- Readers cannot compose new messages or edit shared data in the initial scope.
  Existing unsent text and editor drafts remain recoverable on their originating
  client. Demotion must preserve them before an editor is unmounted or replaced.
- Demotion stops new mutation dispatch, autosave, replay, and writer effects.
  Already-sent work is settled by server receipts and authoritative state;
  transport interruption is not proof of rejection or permission to delete it.
- Retained pending intent must not masquerade as committed reader content or
  indefinitely block observer hydration. Separate its recoverable local state
  from the server projection. Promotion retains receipt, dependency, scope, and
  revision checks; never blindly replay stale optimistic state over newer edits.
- Server-owned generation continues through viewer detachment. Phase 2 readers
  receive persisted results; Phase 4 adds live output for the selected chat.
  Observers cannot submit/cancel/retry generation, claim recovery effects, or
  execute writer-owned completion actions. Durable effects retain their
  idempotency and ownership checks.

## Scope and Invariants

In scope: the role/capability lifecycle, observer startup and synchronization,
local read navigation, mutation entry guards, explicit takeover and demotion,
draft/outbox preservation, live generation viewing, localization/accessibility,
and focused client/server/browser verification.

Follow-up scope: named-device discovery, a device list, remotely assigning some
other device as writer, automatically following another device's navigation,
cross-device draft transfer, collaborative editing, and a full offline database.
No new account permission model is implied: readers remain authenticated users
of the same server and may explicitly request writer ownership.

Preserve these guarantees throughout implementation:

1. Fastify/SQLite and server files remain authoritative. Keep the single-writer
   guard, lineage boundaries, command revision ordering, receipts, and atomic
   command/event persistence. No persistence migration is expected; justify any
   discovered schema or wire change with its compatibility and recovery plan.
2. Reader status cannot enable writes by granting route or event readiness.
   UI affordances, command queues, direct transports, and background callbacks
   must agree. Authentication-only operational routes are not automatically
   harmless observer actions; classify their effects explicitly.
3. Read synchronization retains separate known-server and applied-resource
   cursors, ordered reconciliation, stale-response fences, replay-gap refresh,
   and bounded reconnect/backpressure. Promotion still reconciles pending work
   and reads a coherent post-recovery projection before write readiness.
4. Draft retention, queued intent, accepted mutations, and disposable optimistic
   projections remain distinct. Preserve newer edits when an older request or
   rollback finishes. Same-lineage foreign-owner intent stays dormant; database
   replacement follows the existing lineage disposal rules.
   A writer-epoch change alone is not authentication loss or database replacement
   and must not discard same-lineage drafts or retained intent.
5. Repeated role changes tear down writer runtimes without leaking subscriptions,
   timers, plugin callbacks, or resource requests. Late responses from the old
   role cannot restore authority or overwrite newer state.
6. Keep responsive mobile reading, scroll anchors, history loading, copy,
   keyboard navigation, and supported display processing. Route/role changes
   may not silently execute generation, scripts, or provider actions.
7. New frontend strings belong in `src/lang`. Explain read-only, connecting,
   interrupted, and failed-promotion states accurately without exposing protocol
   internals in the product UI.

## Phases and Delivery

| Phase                                                                                             | Outcome                                                                    | Dependency              |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                             | Rechecked boundaries, transition contract, test map, and rollout decision. | Planning baseline only. |
| [1. Capabilities and mutation protection](phases/phase-1-capabilities-and-mutation-protection.md) | Independent read/write capabilities and guarded mutation boundaries.       | Phase 0 accepted.       |
| [2. Connected read-only browsing](phases/phase-2-connected-read-only-browsing.md)                 | Observer startup, local navigation, committed updates, and recovery.       | Phase 1 accepted.       |
| [3. Explicit writer switching](phases/phase-3-explicit-writer-switching.md)                       | Safe demotion/promotion, pending edits, and a usable switch action.        | Phase 2 accepted.       |
| [4. Live generation observation](phases/phase-4-live-generation-observation.md)                   | Selected-chat streaming with isolated writer effects.                      | Phase 3 accepted.       |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                         | Combined browser proof, rollout decision, docs, and closeout.              | Phases 0–4 accepted.    |

Implement one bounded slice at a time; a phase may span several reviewable
commits or tasks. Later tasks start at `status.md`, confirm the source anchor,
then read the plan and the active phase. Refine later slices from verified
evidence without silently changing the product contract. Routine phase gates
are evidence checks, not new user-approval requirements.

Keep partial implementation behind a coherent rollout boundary until its
dependencies pass. Phase 0 determines whether the existing observer flag can
own the complete new behavior or requires a clearly scoped successor. Enabling
the current flag alone is not this feature. Earlier phases may be independently
merged with the public behavior disabled; release acceptance includes Phase 4.
The user confirmed the final default policy on 2026-09-07: keep the public
feature disabled during implementation, then enable connected readers by default
after all required feature evidence passes. Phase 5 applies this policy, verifies
the resulting default and conservative-writer fallback, and records rollback
behavior and the flag's final disposition. Its phase-ending `pnpm test:all` must
cover the final default configuration. Falling back must preserve drafts and
pending intent.

Mixed-version policy: unchanged older clients retain their existing writer-first
startup, takeover confirmation, and frozen-page behavior. They do not acquire
the new connected-reader UX through server changes alone. New clients must
remain coherent when an older client's existing acquisition flow changes the
writer. Preserve the established handshake and server guard for both versions;
any added wire fields must be compatible or explicitly versioned. The new
no-implicit-takeover UX guarantee applies to upgraded clients. No separate server
compatibility mode or forced upgrade is assumed by this plan.

## Verification and Completion

Follow the [current test workflow](../../tests/README.md#running-the-suite).
During implementation use `pnpm test -- <one-test-or-source-file>` for a named
contract. A selected browser-smoke spec builds and executes that spec. Required
browser cases must use separate authenticated sessions and the real UI/server
ownership transition; direct store assignments cannot stand in for the handoff.
Assert both visible behavior and server state/command counts where relevant.

After the implementation batch is complete, run `pnpm test:agent`. It includes
the smoke build, not Playwright execution. Run the exact required browser cases
separately.

By explicit user instruction dated 2026-09-07, at the end of every phase
(Phases 0–5), the implementing agent must run `pnpm test:all` without requesting
additional user consent. Run it after phase work and self-review, before phase
acceptance or handoff, and record the tested source, command, result, and
exclusions in status. Repair failures and establish a passing result at the
phase's final source; missing required evidence leaves the phase pending. This
overrides the default user/CI-only ownership for this workstream. The command
includes full browser execution and current compatibility; additional pinned
compatibility lanes retain their existing user/CI ownership. See the
[coordination policy](../browser-smoke-and-connected-readers.md#verification-and-completion).
Do not claim that a planning check or an earlier passing commit proves later
behavior.

Documentation changes require `pnpm check:docs` plus explicit validation of this
active plan, which is outside the default current-document set. Use
`validateCurrentDocumentation` from `util/current-documentation-validator.ts`
with all workstream Markdown files and the active-plan index in `documentPaths`,
and empty `indexSpecs` and `literalPathExemptions`. Format the changed Markdown
with Prettier and check whitespace. No validator expansion is needed.

Completion requires every phase's acceptance evidence, no undisposed in-scope
mutation surface, repeated reader/writer transitions without data loss, and
current architecture/test guidance describing the shipped behavior. Archive the
intact completed workstream under the UI/user-input archive topic, repair links,
update its archive index, and remove its active-plan entry only at closeout.
