# Connected Read-Only Clients Status

Updated: 2026-09-07

## Execution Cursor

- State: Stage 1 smoke prerequisite and reader Phases 0–1 accepted; Phase 2 is ready.
- Planning source: `696aecef2dd22dc50ebeca47144cad2b8f5c68b0`.
- Current task scope: implement the coordinated connected-reader plan after the
  accepted smoke prerequisite. Reader Phases 0–1 are accepted.
- Current slice: [Phase 2](phases/phase-2-connected-read-only-browsing.md),
  authenticated reader startup/event services and explicit local transcript
  read context. Phase 1 guard/read/gate proof and both aggregate gates passed.
  The public rollout default remains disabled until Phase 5.
- Production behavior: conservative writer flow remains the default. Additive
  ownership metadata/preconditions are available; connected readers are not
  publicly enabled.
- Blockers: none. Phase 0 implementation choices and its required baseline gate
  and Phase 1 protection gates are accepted below.

Read [PLAN.md](PLAN.md) for stable behavior and invariants,
[inventory](inventory.md) for source owners and dispositions, and only the
active [phase](phases/README.md) for detailed execution instructions.

## Phase Router

| Phase                                                                                             | State    | Next evidence required                                                                        |
| ------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                             | Accepted | Source/transition/draft contract, 34 dispositions and required full suite passed.             |
| [1. Capabilities and mutation protection](phases/phase-1-capabilities-and-mutation-protection.md) | Accepted | All 34 entry dispositions, focused races, test:agent and all 13 test:all lanes passed.        |
| [2. Connected read-only browsing](phases/phase-2-connected-read-only-browsing.md)                 | Pending  | Begin reader startup/service separation and scoped transcript; then actual two-session proof. |
| [3. Explicit writer switching](phases/phase-3-explicit-writer-switching.md)                       | Pending  | UI-driven takeover/demotion; pending work, drafts, and stale-response race proof.             |
| [4. Live generation observation](phases/phase-4-live-generation-observation.md)                   | Pending  | Streaming continuity; observers execute no writer-only actions or effects.                    |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                         | Pending  | Combined browser/aggregate evidence, rollout disposition, docs, and residuals.                |

## Verification Ledger

2026-09-07 coordination-policy update: shared documentation checks passed as
recorded in the [smoke verification ledger](../browser-smoke-effectiveness/status.md#verification-ledger).
This validates the policy edit only; no implementation phase ended and
`pnpm test:all` was not run for this edit.

| Scope                         | Source/date                                     | Result                                                                                                                                                                                   | Limit                                                                                                      |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Planning source review        | Planning source, 2026-09-06                     | Confirmed existing writer-loss teardown, event gating, partial observer shell, persisted navigation, and recovery owners.                                                                | Source assessment only; no production reproduction or new feature execution.                               |
| Parallel planning cross-check | Planning worktree, 2026-09-06                   | Two read-only source reviews cross-checked; confirmed observer SSE gap, routed persona writes, and distinct draft/outbox/effect ownership.                                               | Plan input only; no implementation phase accepted.                                                         |
| Plan validation               | Planning worktree, 2026-09-06                   | Explicit validation passed for all 11 plan/index documents; `pnpm check:docs` passed for 49 current documents; explicit Prettier and whitespace checks passed.                           | Document integrity only; implementation phases remain pending.                                             |
| Agent aggregate               | Planning source plus plan documents, 2026-09-06 | `pnpm test:agent` passed in 2m 16.2s: server/browser types, topology, current docs, frontend tests/check, server tests, and smoke build. Five tests were skipped by the existing suites. | Workspace baseline only; no Playwright execution, new feature behavior, or user/CI compatibility evidence. |

Plan review: two additional read-only reviews were reconciled against source.
The plan now specifies finite lifecycle capabilities, reader handling of writer
frames and replay/live transitions, bounded mutation inventory, operational
job events, incomplete generation metadata, and mixed-version behavior. These
are planning contracts, not reproduced defects or implemented fixes.

After each completed slice record the source/commit when available, changed
boundaries, exact commands and outcomes, acceptance evidence, and residual
limits. Link long evidence separately only when necessary. Keep the current
cursor at the top; do not duplicate it in the plan or phase files.

## Decisions and Scope

- 2026-09-06: Preserve one server-authorized writer and permit multiple
  authenticated connected readers. Explicit **Use this device** is the switch
  action; readers never acquire write access through focus/reload/reconnect.
- 2026-09-06: Reader selection is local. Preserve originating-client drafts;
  new observer edits and cross-device draft transfer are outside the initial
  feature. Live generation observation is required by Phase 4.
- 2026-09-06: Named-device lists, remote assignment, automatic navigation
  following, collaborative editing, and authoritative offline storage are
  follow-up work.
- 2026-09-06 planning baseline prepared the documents only. The coordinated
  implementation task began Phase 0 on 2026-09-07 after Stage 1 acceptance.
- 2026-09-07: The user confirmed the rollout default: keep the public feature
  disabled during implementation, then enable connected readers by default
  after all required feature evidence passes. Phase 5 verifies the final default
  and conservative-writer fallback, preserving drafts and pending intent.
- 2026-09-07: The user explicitly requires the implementing agent to run
  `pnpm test:all` at the end of every phase without additional user consent,
  before acceptance or handoff. This supersedes the earlier user/CI-only command
  ownership for this workstream. Record final-source results and keep failed or
  unavailable required checks pending. Later entries record phase implementation and acceptance separately.

Record future scope or sequencing changes here with rationale, affected phase,
dependency, evidence, and remaining consequence. Update the plan and affected
phase when stable behavior or dependencies change.

## Phase 0 Implementation Decisions

These choices have acceptance criteria in Phase 0; they are not open-ended
product questions requiring another approval round.

1. Live role/connectivity owner and how existing startup capabilities consume it.
2. Reader selection ownership and interaction with shared selection projections.
3. Observer-safe runtime set, including plugin/display and operational routes.
4. How retained drafts/intent are separated from authoritative reader content;
   which current editors need additional demotion preservation.
5. Rollout flag ownership and old-client/protocol compatibility under the agreed
   disabled-during-implementation, enabled-after-verification default policy.

## Stage 1 Smoke Prerequisite

Received 2026-09-07: [smoke Phases 0–2 accepted](../browser-smoke-effectiveness/status.md#phase-2-acceptance-and-stage-1-handoff-2026-09-07),
including all four critical contracts, their required fault demonstrations and
restored browser proof, and the phase-ending agent-executed `pnpm test:all`
(**79/79 browser cases, all 13 lanes pass**). No high-risk critical gap remains
at the handoff source. See the smoke inventory/findings for exact source limits.

This accepts the prerequisite only; reader Phases 0–5 remain pending. Start
Phase 0 with current source confirmation, transition/entry-point/draft inventory
and the rollout decision. Keep connected readers disabled during implementation,
then apply the agreed enabled-by-default policy with fallback proof in Phase 5.
Maintain affected smoke tests as behavior changes; replace obsolete old-writer
freeze expectations while retaining ownership, draft, durability and exactly-once
protections. The smoke workstream resumes with Stage 3 reconciliation and its
remaining Phases 3–4 after reader completion.

## Phase 0 Contract Review — 2026-09-07

Source: `058e2ca2e`; production behavior unchanged. Read the active plan,
phase, boundary owners and current startup/resources/recovery guides. Five
independent read-only Luna reviews covered wire/identity, mutations, navigation
and events, drafts, and runtime effects. Parent review checked cited source,
corrected three stale paths, and resolved the identity recommendation: exclusive
page-lifetime Web Locks with a fail-closed unsupported path are stronger than a
BroadcastChannel timeout that could mistake a suspended tab for no live owner.
These are source findings, not production reproductions or feature passes.

The [expanded inventory](inventory.md#source-confirmed-transition-contract)
records all named lifecycle transitions and their read/write/runtime policy,
**34 reviewed entry families, 34 dispositions and 0 unclassified**, a mounted
editor/draft map, intent lifecycle policy, and test owners. All 34 implementation
proofs remain pending. The source checks found command-unavailable local writes,
provider operations that are auth-only, display fallback into general scripts,
and component-local drafts that existing outbox retention does not cover.

Concrete Phase 0 decisions:

1. Add a live `clientSession` state owner with six lifecycle states, independent
   connection health and an async generation fence. Existing startup milestones
   remain monotonic history; selectors consume current authority.
2. Use local stable route IDs for reader selection. Gate authoring routes;
   render supported conversation/history/copy through audited read dependencies.
   Preserve reader IDs through refresh and promotion without reader selection
   commands.
3. Separate canonical event/resource/job observation from replay, flush,
   optimistic merge hooks, plugin execution and completion effects. In readers,
   allow server-isolated display processing and safe markup; unsafe client
   fallbacks show readable source with a localized explanation.
4. Capture mounted drafts synchronously before demotion teardown. Retain scope,
   baseline and generation outside authoritative projection; protect credential
   drafts. Preserve exact staged/in-flight/accepted identities and defer
   writer-protected receipt writes; dormant intent must not block reading.
5. Reuse `VITE_FAST_BOOTSTRAP_OBSERVER` as the one rollout switch, disabled
   through Phase 4 and enabled by default in Phase 5 with explicit `FALSE`
   conservative fallback. Add a compatible bootstrap writer snapshot and
   expected-epoch acquisition precondition; preserve legacy handshake/guards.
   Deduplicate copied session IDs before discovery and prohibit arbitrary
   outbox-owner adoption in reader startup.

First Phase 1 slice after this gate: implement the live capability/authority
owner and selectors, then guard ordinary/recovery command admission, queued
execution and lifecycle flush. Owners: `startupReadiness.ts`,
`activeWriterSession.ts`, `commands.ts`, `ownerMutationLifecycle.ts`, and the new
browser role owner. Exit: reader/recovery states never enable ordinary writes;
a queued command and lifecycle callback held before dispatch stay unsent after
synchronous demotion; already-sent acceptance retains exact settlement. Keep the
feature disabled. Subsequent Phase 1 commits close plugin/direct-operation,
local-fallback, display and draft/UI dispositions before Phase 2 exposure.

Planned browser proof (not yet created/executed): a focused connected-reader
spec will use a disposable server and separate authenticated browser sessions,
with a writer fixture performing real commands. Phase 2 opens/reloads/focuses B
as a reader and navigates independent conversations while A commits; inspect
rendered transcript, durable writer metadata and B's forbidden-request count.
Exercise history/copy, foreign selection, deletion, replay gaps and mobile-sized
layout. Phase 3 drives **Use this device** for A → B → A, holding queued commands,
accepted responses/receipt cleanup, replay and hydration across transitions.
Phase 4 adds a held streaming provider, exact operation/message/effect identities
and reader close/reconnect/chat-switch cases. Phase 5 runs one writer plus two
readers, default/fallback and legacy-handshake evidence. Fixture helpers may seed
unrelated state but cannot substitute store assignments for the transition under
claim. Each materially new/repaired browser contract receives the coordinated
smoke fault-detection evidence.

Phase 0 accepted after final review and verification:

- `pnpm check:docs`: 49 current documents passed. Explicit
  `validateCurrentDocumentation` with both bundles, coordination file and active
  index: 22 documents passed with empty index specs/exemptions.
- Changed Markdown formatted with the ignore override; whitespace check passed.
- Agent-executed `pnpm test:all` at `058e2ca2e` plus these documentation-only
  changes: **all 13 lanes passed in 5m 50.9s; 79/79 browser cases passed** (browser
  lane including build 3m 5.3s). Frontend 8,113 and server 4,164 tests passed;
  five existing ordinary-suite skips remain. The selected scale gate keeps its
  existing title exclusions. Current compatibility executed; additional pinned
  comparison and opt-in cost lanes were not executed.

This accepts the executable boundary contract and current-source baseline only.
No connected-reader implementation or feature behavior is certified yet.
Phases 1–5 retain their required focused, browser and aggregate proof.

## Phase 1 Implementation Evidence

### Compatible ownership discovery and conditional acquisition

Source: `faeb5ee1d` plus this bounded wire/test slice. Bootstrap now exposes
`writer: { sessionId, epoch }` from durable metadata. Optional
`risu-expected-writer-epoch` and `risu-expected-database-lineage` acquisition
headers are checked together before registration; mismatch returns
`409 active_writer_changed`, with no implicit retry or writer registration.
The lineage precondition also prevents a replaced database with the same epoch
from accepting a stale acquisition. Missing headers preserve legacy acquisition
and its connected-writer confirmation handshake. Missing response metadata stays
unknown for old server responses; malformed supplied metadata fails parsing
before caching a command revision.

Focused proof: server active-writer **27/27**, bootstrap **7/7**, existing server
events **25/25**, and client bootstrap **28/28** pass. Real route tests cover
simultaneous no-owner acquisition (one success/one conflict), disconnected and
connected owners, explicit disconnect confirmation, zero-write readonly reads,
and actual replacement followed by matching SQLite metadata, initial SSE frame
and stale/current mutation guard responses. Parent rechecked the client parser
narrowing and bounded the lineage header grammar; the affected active-writer and
client-bootstrap suites passed again. Server and browser-smoke typechecks passed
for the agent slice; broader Phase 1 validation remains pending after all work.

This implements the wire prerequisite for E01 and startup/switching. It does
not certify a new reader startup or explicit UI promotion; those remain later
phase evidence. Live capability/entry/draft protection is still in progress, and
Phase 1 is not accepted.

### Live capability, queue and shell protection

Source: `36ee0e33c` plus this capability/queue/UI slice. `clientSession.ts` owns
six live states, connection health, authenticated ownership and opaque operation
identities. Only a current startup/promotion/revalidated-resume operation can
finish writer recovery. Reader frames and read readiness cannot grant writing.
Startup milestones stay monotonic; managed read-route capability is independent
from the app's writer route handlers and editor overlays. Managed activation is
reserved for the Phase 2 coordinator; the public default remains conservative.

Command admission, execution factories, revision/auth awaits, replay and
receipt acknowledgement now consume that live authority. A captured queue
generation remains invalid after demotion and a later promotion; denied
sequences return `unavailable` rather than the `null` success sentinel. Valid
late acceptance can settle its exact receipt while old local effects, rollbacks,
revision updates and reconciliation continuations cannot overwrite a newer
role. Real stale-writer bodies may include the server's `reason`; originating
generations fence their effect on current authority. Direct adapters are being
updated to supply that origin as part of the parallel operation slices.

Synchronous writer-loss hooks run after dispatch closes and before subscribers
can unmount an editor. Lifecycle and registered-owner flushes deny reader work.
The managed shell gates authoring routes, while Home/Settings route navigation,
text-copy shortcuts and local adjacent-character URLs remain usable. It does
not use global CSS freezing for this protection.

Focused proof: 11 core/command/lifecycle/mounted-shell/hotkey suites passed
**277 tests**; the final two hotkey suites passed **34 tests** after adding the
reader shortcut/local-selection cases. These include held auth, queued replay,
accepted response, direct-event draining and batch-flush races, A → B → A
capability changes, and actual mounted UI/keydown checks. The wider operation,
plugin, local-owner and draft integration work and phase-ending aggregate/browser
gates are still pending. No Phase 1 acceptance is implied by this slice.

### Direct operations, local owners and retained fields

`29822f4d0` guards direct provider/media/storage adapters, asset batches,
external fetch/plugin proxy continuations, translations, push registration and
local completion notification/audio. The original role generation is checked
before transport and after asynchronous work; a later promotion cannot revive
an old operation. Already accepted backup/import results retain their identity
without adopting stale replacement ownership. Focused operation evidence:
23 suites, **369 tests passed**, including held auth/provider/file results and
reader attempts; formatting and whitespace checks passed.

`c84a0b7ea` closes command-unavailable local acceptance and optimistic mutation
paths for character/chat/module/persona/loadout/preset owners. Debounced
settings, lorebook, character and script owners keep old intent dormant after
loss rather than dispatching it on a later role generation. Detached getters
retain the dirty value and its normalized baseline. Focused evidence:
19 suites, **856 tests passed**, plus final affected subsets of **97** and
**72** tests; **28** new reader/delayed-owner cases exercise actual entry points
and timer continuations. These counts describe the bounded agent runs, not an
aggregate phase pass.

`1d0add206` adds a separate encrypted local recovery store. Writer-loss capture
runs synchronously before subscriber teardown; each copy keeps its originating
lineage/session, immutable generation, field values and optional structured
baseline. Secret-bearing content and record labels/routes are encrypted at
rest. Scope/auth changes hide the view without deleting originating drafts;
late loads and exact-generation discard cannot replace or delete a newer copy.
The store retains fresh in-memory copies on quota/serialization failures and
reports reload-persistence failure. **25** focused store tests passed.
Controlled reload callers must await capture/persistence and handle failure;
an abrupt process termination during asynchronous page-exit storage is not a
crash-recovery guarantee.

Mounted editor integration and chat controls are still under final review.
The new partial-edit regression captures the just-typed range before unmount,
then rejects a retained Save after demotion and promotion; explicit Cancel
remains cancellation. The composer regression holds hydration, captures newer
unsent input on writer loss and proves the old preflight does not append/send
when hydration resolves after promotion. Their affected suites passed
**14** and **19** tests respectively. Final outbox/replay/replacement,
plugin-effect readiness and retained generation-entry continuations remain in
progress. Phase 1 gates have not run and Phase 2 remains pending.

### Mounted editor and transcript boundaries

`b040edee3` retires writer plugin registrations and fences scripting callbacks;
`0ca3dcafd` adds explicit read-only Chat/Chats/ChatBody props and cache separation.
Reader rendering preserves plain copy and existing persisted translation display
without starting translation, TTS, triggers, rerolls or general browser display
scripts. The final Chat/parser/ChatBody/Chats focused set passed **162 tests in
7 files**, including delayed callbacks across demotion and promotion. The earlier
plugin/display/script set passed **253 tests in 9 files**. Explicit local reader
read-owner scoping is still a Phase 2 prerequisite; display IDs currently constrain
writes and server display requests but do not retarget every surrounding read.

`459899b65` mounts the local recovery panel in the ready app shell; its **12**
mounted cases cover real captures, secret masking/reveal, copy/export, exact
newer-copy discard protection, safe local navigation, stale DOM actions and auth
loss. The final App/panel/field-helper group passed **36 tests in 3 files**.
`6dccc5469` and `484a23885` integrate the character/persona/lore/script/module/
popup and model/memory/settings/sidebar editor families. Final focused UI checks
passed for CharConfig, author notes, personas, popup fields, lore rows/settings,
triggers, regex and modules. The settings/memory/sidebar agent's final combined
run passed **429 tests in 14 suites**; its final affected baseline/control subset
passed **63 tests in 2 suites**. Captures include collapsed/nested raw values,
provider secrets, just-typed fields before child effects, and later input after
an earlier Save. Pristine and explicitly cancelled forms are not fabricated edits.

`ee504f145` adds composer/partial capture and original-generation continuation
checks. Five affected parent chat suites passed **149 tests**. `251e98d76` fences
App drop and runtime-repair callbacks; **24** mounted App tests passed, including
a preset file read held across a full role cycle with zero import calls.

`18d1c65d0` fixes retained chat projections found during final review. Before the
fix, three unchanged held-failure cases reproduced old chat names, folder names
and message text overwriting the current view after demotion and promotion. A
separate replay-discard case reproduced a stale transcript rebase. Attempt-origin
checks now cover result and retained-service reapply, rollback and later-attempt
baseline rebasing while exact terminal settlement remains intact. The complete
chat-command suite passed **231 tests**, including eight new race cases. A later
typecheck found a test fixture using a string for structured translation; the
fixture was corrected to a valid independent message-name field without changing
the rebase scenario. Final aggregate verification must cover that correction.

### Final continuation review and phase gates

`5490dbd3f` protects generation transport, recovery/finalization, accepted-send,
request, reroll and input-hook boundaries. Managed effects wait for ordinary
writing **and** coherent plugins before claiming ledger rows; the real ledger
regression proves early plugin output remains unclaimed. `0c1d9a067` closes
historical PNG/CharX/Realm/URL/module import fallbacks, including embedded asset
batches and held confirmations. The initial generation set passed **380 tests
in 18 suites**; the final caller/request set passed **109 tests in 8 suites**.
Import compatibility and new reachable-path checks passed **109 tests**, with
ordinary-writer positive controls. No production fault was left injected.

`9678be782` preserves caller generation through compatibility accepted-append
handoffs, slash-command pipelines and display-plugin Retry. A superseded
accepted or queued-then-accepted append keeps its accepted message identity and
exact settlement without launching a provider. The final command/chat set
passed **260 tests in 2 files**. The display Retry file passed **107 tests**,
including a role-cycle hold followed by a successful fresh explicit Retry.

`0842cf3a7` completes outbox/replacement recovery guards. Reader startup cannot
adopt/discover a pending writer, stage or replay intent, or perform receipt
cleanup. Authorized recovery uses origin-stamped handles, lock/transaction
checks and loop generations. Already-admitted encryption completes under its
captured scope and recovery waits for it. Same-lineage epoch changes retain
pending intent and skip destructive owner reset. Late ordinary/replay/predecessor
results can settle exact local rows while old-generation ACK, notification,
reload and successor dispatch stay stopped. Writer loss invalidates optimistic
projection fences even when the same session later resumes the same epoch.
The final focused set passed **340 tests in 8 suites**; outbox TypeScript,
formatting and whitespace checks passed. An earlier predecessor timeout was
isolated and then passed in the final serial focused run; the timeout was not
counted as passing evidence.

All 34 entry families now have an implemented guard/read disposition or an
explicit gated surface with a behavioral proof owner in the inventory. Final
source review was complete before the aggregate attempts recorded below. Their
passing final results accept Phase 1 and permit Phase 2 implementation.
The public connected-reader activation remains disabled. Read-only preparation
for the next phase does not expose its startup, route, or viewer surfaces.

First combined `pnpm test:agent` attempt: **failed** after 2m 27.9s. Frontend
check, server tests, topology/docs and smoke build passed. The remaining issues
were Korean translation-path parity, one STScript test expecting the pre-origin
handoff shape, and architecture baseline drift from reviewed recovery helpers
and new test fixtures. `1e2dd3b01` supplies Korean strings; the handoff expectation
and generated inventory bookkeeping were corrected. Inventory review confirms
**no change** to production aggregate consumers, owner policies, bridges or
seams: two existing persona probe counts changed and test-fixture references
increased by 29 to 4,262. Its companion matrix count was updated consistently.
Focused language/trigger checks passed **37 tests**, architecture inventory tests
passed **7**, and the complete `pnpm check:server` chain passed, including Fastify
and browser-smoke TypeScript. The combined aggregate must pass on retry before
the required full suite is accepted.

Combined `pnpm test:agent` retry at `0b7d40fee` plus these status/inventory
updates: **all 7 lanes passed in 2m 25.3s**. Frontend TypeScript/Svelte reported
zero errors and warnings. The separate required phase-ending `pnpm test:all`
result follows below.

### Phase 1 acceptance

At `0b7d40fee` plus these documentation updates, agent-executed
`pnpm test:all` **passed all 13 lanes in 5m 53.0s**, including **79/79 browser
cases** (browser lane with build 3m 2.8s). Frontend normal/UI-map tests passed
**8,699** cases, server tests passed **4,183**, and the selected Realm scale,
current compatibility, formatting, coverage and frontend performance gates
passed. Five existing ordinary-suite skips remain; the scale command retains
its existing title exclusions. No additional pinned comparison or opt-in
external-cost lane was run. The preceding final `pnpm test:agent` passed all
7 lanes in 2m 25.3s. Current-document validation covered 49 files; explicit
coordinated-plan validation covered all 22 plan/index files.

**Phase 1 is accepted.** Live capabilities, mutation/effect admission, stale
continuations, local draft capture and the bounded 34-family guard/read/gate
mapping have their required proof. Public activation is still disabled; this
acceptance does not claim connected browsing, promotion, or a live viewer.

Phase 2 starts with three source-reviewed concerns: the existing bootstrap and
event loop still compose writer recovery with reads; Chat/ChatBody module and
asset reads still follow canonical selected owners; and flag-enabled browser
fixtures must represent their intended initial owner rather than accidentally
leaving a foreign import session. Preserve the existing read/cache/cursor and
scroll/hydration owners, separate their reader policies, and prove actual
startup and visible two-session convergence before opening Phase 3. The
read-only source cross-check completed three independent Luna tasks; it added
no implementation or browser evidence.
