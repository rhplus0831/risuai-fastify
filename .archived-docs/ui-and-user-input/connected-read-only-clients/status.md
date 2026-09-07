# Connected Read-Only Clients Status

Updated: 2026-09-08

## Execution Cursor

- State: all reader Phases 0–5 accepted; the subsequent writer-startup repair,
  affected normal/fallback controls and combined final gates are also accepted.
- Planning source: `696aecef2dd22dc50ebeca47144cad2b8f5c68b0`.
- Accepted implementation: production through `a703b9d4b`, browser repairs through
  `60ac61bde`, with final agent/full gates at clean `eb9673942`.
- Rollout: normal builds enable connected readers. Exact build-time
  `VITE_FAST_BOOTSTRAP_OBSERVER=FALSE` retains the verified conservative fallback,
  preserving originating-client drafts and pending intent.
- Phase 5 evidence: all 92 browser cases and all 13 full-suite lanes pass; normal/
  FALSE builds, named production faults and restored controls are recorded below.
- Final maintenance validation: production/browser through `7aad1bb37`, focused
  controls at `985da9bc8`, and both final gates at clean `39356086c` pass.
- Archive: this intact bundle is preserved under UI/user input. Continue the
  [smoke workstream](../../../docs/plan/browser-smoke-effectiveness/status.md) through its final archival action.
- Follow-up: [BSE-009](../../../docs/plan/browser-smoke-effectiveness/status.md#phase-4-first-full-gate-failure-and-targeted-follow-up)
  changes writer startup when the retained route supersedes pending hydration.
  Focused red/green, two qualified browser negatives, both 18-case normal
  cohorts and two actual compiled-FALSE controls pass at `985da9bc8` as recorded
  in the [follow-up evidence](../../../docs/plan/browser-smoke-effectiveness/status.md#bse-009-writer-startup-and-reader-revalidation).
  Final-source agent/full verification passes at `39356086c`. Original product
  follow-up scope and browser/provider/device limits remain explicit below.

Read [PLAN.md](PLAN.md) for stable behavior and invariants,
[inventory](inventory.md) for source owners and dispositions, and only the
active [phase](phases/README.md) for detailed execution instructions.

## Phase Router

| Phase                                                                                             | State    | Next evidence required                                                                               |
| ------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                             | Accepted | Source/transition/draft contract, 34 dispositions and required full suite passed.                    |
| [1. Capabilities and mutation protection](phases/phase-1-capabilities-and-mutation-protection.md) | Accepted | All 34 entry dispositions, focused races, test:agent and all 13 test:all lanes passed.               |
| [2. Connected read-only browsing](phases/phase-2-connected-read-only-browsing.md)                 | Accepted | Reader/browser/fault controls, final test:agent and all 13 test:all lanes passed.                    |
| [3. Explicit writer switching](phases/phase-3-explicit-writer-switching.md)                       | Accepted | Projection review, UI switching/setup/durable-generation browser faults and both phase gates passed. |
| [4. Live generation observation](phases/phase-4-live-generation-observation.md)                   | Accepted | Five browser journeys, six qualified faults/restored controls and both final phase gates passed.     |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                         | Accepted | Combined/default/FALSE proof, final agent and all 13 full-suite lanes passed; guides complete.       |

## Verification Ledger

2026-09-07 coordination-policy update: shared documentation checks passed as
recorded in the [smoke verification ledger](../../../docs/plan/browser-smoke-effectiveness/status.md#verification-ledger).
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

Received 2026-09-07: [smoke Phases 0–2 accepted](../../../docs/plan/browser-smoke-effectiveness/status.md#phase-2-acceptance-and-stage-1-handoff-2026-09-07),
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

## Phase 2 Implementation — 2026-09-07

Prerequisite: Phase 1 accepted at `95a70ed44`. Public activation remains disabled
by default. Read-only Luna preparation covered startup/services, local read
context and the real browser fixture. Scoped implementation and an independent
coordinator review were reconciled against current source.

Implementation slices, accepted after the final gates below:

- `f3e6f9103` scopes existing transcript owners, translations, metadata, module
  activation/assets and portraits to the reader's stable character/chat IDs.
  Existing history/residency and safe mobile copy remain in the shared transcript.
  Seven focused suites passed 164 tests.
- `c984321e2` deduplicates copied tab identities with exclusive page-lifetime Web
  Locks, retains the same ID on legitimate reload, and preserves originating
  recovery metadata on unsupported lock facilities. Six focused tests passed,
  including a lock callback delivered after teardown.
- `5fbdd01f5` adds reader-only event transport, ordered targeted/full refresh,
  bounded reconnect, separate known/applied cursors, memory/BardWiki snapshots,
  local greeting updates and auth/lineage response fences. Ten focused suites
  passed 281 tests; five affected suites passed again after final transport
  admission changes (206 tests, overlapping the earlier group).
- `b2bf25116` fences writer-only authoritative refresh completion and applies
  synchronous auth/lineage projection resets. `28ea39cd0` includes actively
  loading resources in invalidation; the final affected set passed 120 tests.
- `eba3973a6` implements the local reader shell/transcript and read-only display
  dependency loader. Initial UI proof passed 34 tests; final display-loader and
  transcript proof passed 16 tests, including the held-demand/committed-update
  race. Mobile copy, scoped history and graceful dependency retry are covered.
- `af7903297` composes managed startup, read-only authentication, conditional
  acquisition, passive demotion, owner revalidation, recovery and generation
  fences. Parent proof passed 253 tests across six suites; route/App proof
  passed 65 tests and event transport proof passed 15. Delayed plugin, chat and
  background completions cannot revive stale readiness or demote a newer writer.
- `e8beb57bb` fences pending settings overlays by their originating writer
  generation and separates new edits from dormant encrypted intent. Four
  focused suites passed 102 tests. `41b9f8763` types their sparse fixtures;
  its two affected suites passed 54 tests and Svelte check reported zero errors
  and warnings.
- `54db7b589` supports identities on insecure origins without `randomUUID`;
  seven identity tests passed. `81efb67c3` adds prompt offline interruption,
  bounded online recovery and authoritative full read refresh after demotion.
  Its two affected suites passed 207 tests; final bootstrap proof passed 187.

The real disposable-server browser implementation exposed and fixed two
production gaps: App stopped tracking live URLs after consuming a nonreactive
reader intent, and initial shell data lacked display preferences/module/persona
inputs needed by shared transcript rendering and mobile copy. Mounted
regressions cover both. Canonical normalization was separately added to the
unowned migration fixture; this repaired fixture-only missing greeting and
character fields without changing production display-source validation.

The complete Reader scenario proves actual unowned initialization, separate
writer/reader startup, copied-session-storage isolation, stable writer reload
identity, older-history wheel input, visible committed updates, actual clipboard
copy, local navigation/history, reader reload/focus, unchanged writer URL and
full durable SQLite snapshot, and offline committed catch-up. It observes zero
forbidden reader requests and zero page errors. Observation includes service
worker requests. The exact read-only cache/display POST allowlist follows server
route policy; writer headers on bootstrap/events are forbidden even when empty.

The full Reader scenario is S80; S32/S60 retain their IDs while changing their
mixed-client expectations. Artifact identities and required payload semantics
remain unchanged. Pending-edit presentation across a complete A → B → A switch
and live generation viewing remain Phases 3 and 4; these results do not certify
those transitions.

### Final Phase 2 browser and production-fault controls

At browser source `6003c596e` (production `81efb67c3`, fixture typing
`41b9f8763`), the emitted build passed. Single-worker Playwright executed
`connectedReaderBrowsing.spec.ts` plus `startupRecoveryIntegrationMatrix.spec.ts`:
**8/8 passed in 27.9s**. The unique S32 title in `fastifyBrowserSmoke.spec.ts`
then passed **1/1 in 4.3s**. An initial overly anchored grep collected zero tests
and is excluded. Browser TypeScript, formatting and whitespace checks passed.

S80 verifies separate sessions, read/history/copy/mobile/status behavior and zero
domain mutation observations. S60 verifies passive upgraded-writer demotion after
a legacy takeover and subsequent settings convergence. S32 preserves the older
client's frozen choice while an upgraded reader receives a visible committed
rename. Both changed journeys retain server guards and no-pre-authority mutation
assertions. At `e8431655d`, the source inventory and discovery were reconciled to
80 browser cases/19 specs; current docs and explicit plan validation passed.

Three independent faults at `6003c596e` failed their intended unchanged browser
oracles after real accepted server commands: skipped message projection (S80),
omitted demotion resubscription (S60), and reader teardown on a subsequent foreign
writer frame (S32). R2-F1 additionally retains independent SQLite message/event
origin proof. Exact hunks, commands, hashes and limits are recorded in the
[smoke findings](../../../docs/plan/browser-smoke-effectiveness/findings.md#reader-phase-2-production-fault-evidence).
Both production files were restored; a clean build and the same three selected
controls passed **3/3 in 13.6s**. Production remains unchanged by the later test
repairs, so these three results retain their source scope.

### Phase 2 aggregate verification and transcript repair

`b7d3f88f1` establishes actual readiness in existing generation lifecycle race
fixtures. The subsequent `pnpm test:agent` passed in **2m 20.3s**. The first
phase-ending `pnpm test:all` failed in **6m 0.2s**: all 12 nonbrowser lanes passed,
including frontend tests (8,611 plus 241 UI cases), 4,183 server tests, current
compatibility (18), scale and performance; browser passed 79/80 cases. S22 alone
failed its nonempty pause-coverage guard. Saved observations contained a stable
readable pause after its first sample; no production scroll defect was shown.

[BSE-005](../../../docs/plan/browser-smoke-effectiveness/findings.md#bse-005-pause-sampling-misses-readable-anchors-after-hydration)
owns the bounded repair. The unchanged test passed two isolated controls, but
that did not erase the failed full gate. `38604f7f9` adds a fixed second pass over
recently measured history, preserving the original sample-zero anchor oracle.
`d75ecfe375` moves the unchanged coverage guard after the independent traversal
checks. Neither the cached-height omission nor anchor-restoration omission
produced qualifying geometry failures at that source; their unqualified results
are retained separately. The direct message-298 unmount/remount oracle at `9387d1464974` now detects
a separately declared cache-owner fault in both repetitions. No test oracle
selects anchors from future outcomes or weakens readability/geometry tolerances.

At `9387d1464974`, final isolated baselines passed twice (44.3s, 44.5s).
The cache-owner fault failed the intended remount assertion twice (20.0s,
19.3s), with exact message-298 markers and received fault-chunk evidence.
Restoration, rebuild and the same controls passed twice (44.0s, 43.8s).
All runs used one worker, trace off and no concurrent checks. The test stayed
byte-identical; no production fault remains in the main or disposable source.

Final documentation validation passed for 49 current guides and all 22 explicit
plan/index documents. At `9387d1464974` plus these six evidence records, the final
`pnpm test:agent` passed in **2m 26.6s**: server/browser typechecks, topology,
current documentation, frontend tests/check, server tests and smoke build.
The required phase-ending `pnpm test:all` then passed at that same source in
**5m 49.2s**, including every required lane and all 80 browser cases. Detailed
acceptance follows; earlier failed or exploratory runs remain excluded.

### Phase 2 Acceptance and Phase 3 Handoff — 2026-09-07

Final tested source: `9387d1464974`; production through `81efb67c3`, followed by
the documented fixture/readiness/transcript test repairs and these six evidence
records. `pnpm test:agent` passed in 2m 26.6s and `pnpm test:all` passed in
5m 49.2s. All 13 full-suite lanes passed: server/browser typechecks, topology,
current documentation, frontend tests/check, compatibility register/current
harness, server tests, Realm scale, browser smoke, UI coverage, formatting and
frontend performance. The full browser lane passed **80/80 in 3m 0s**
(3m 10.6s including its build/runner); S22 passed in 44.9s, S80 in 11.8s, and
both changed mixed-client cases passed. Existing suite skips and the Realm
scale command's deliberate name exclusions remain unchanged. Additional pinned
compatibility comparisons were not run and are not claimed.

The current-guide validator passed 49 files; explicit coordination/index/bundle
validation passed all 22 documents. Final Markdown formatting and whitespace
checks passed. Logs are `/tmp/reader-phase2-final-test-agent.log` and
`/tmp/reader-phase2-final-test-all.log`; BSE-005 retains its own frozen baseline,
fault and restored artifacts. R2-F1/F2/F3 source remains unchanged and all three
normal browser controls passed again in the full run.

**Phase 2 accepted.** The public feature remains disabled as agreed. Phase 3
now owns explicit A → B → A switching, authoritative reader presentation during
pending work, late settlement and draft restoration, and durable generation
survival through takeover. Phase 4 owns live reader generation attachment and
effects separation. Smoke Phases 3–4 remain pending until reader Phase 5 hands
back the completed implementation.

## Phase 3 Implementation — 2026-09-07

Prerequisite: Phase 2 accepted in `4b192edbf`, including the final 13-lane full
suite. Public activation remains disabled. Read-only Luna preparation and
independent coordinator review were reconciled against source before the
bounded implementation slices. The second two-worker projection review is
resolved in the final source review below.

- `4d9c69cbf` adds the localized **Use this device** action, progress and
  recoverable outcomes while retaining reader navigation/focus. Its 20 mounted
  tests passed. `6bfb0f436` adds owner-scoped abort support to required selection
  dialogs so an obsolete promotion cannot leave a blocking confirmation; all
  42 alert tests passed, including queue/ownership/listener controls.
- `aac25f762` composes explicit conditional acquisition, current reader
  synchronization during confirmation, ordered outbox/receipt/replay/resource
  recovery, an actual writer subscription, and current-generation startup
  services. It coalesces repeated calls and returns failures to reading without
  automatic takeover. The final coordinator suite passed 207 tests and the
  access-interaction suite passed 12. Review identified and fixed teardown
  after completed core recovery and inherited reader connection readiness when
  the writer stream returned replay-unavailable. Held-step tests now cover both.
- `825a92f73` separates certified reader bodies and bounded visible metadata
  from pending writer overlays. Initial final focused groups passed 122 reader,
  hydration and real-outbox tests, 231 command tests, and 79 resource tests.
  Retained-body identity after batched deletion/re-add and persona compact
  acknowledgement updates are resolved by the final review follow-up below.
- `c9a8e6d30` and `65ca5b7ae` repair a first-run combination omitted by earlier
  tests: an empty unowned server without Web Locks had no explicit setup path.
  The owned pre-shell setup action uses the fresh fallback identity, requires a
  current user decision and the existing expected-owner acquisition, and never
  exposes uninitialized data as a reader view. Another initializer winning
  falls through the existing ownership reread. Eighteen startup tests and the
  extended 210-case bootstrap suite passed, including pagehide/late decisions.

The actual browser batch covers A → B → A with stable local routes, SQL
ownership, stale-write rejection and originating composer recovery; a held
server generation surviving takeover with one durable result; and explicit
first-run setup without Web Locks. Its results and production-fault controls
follow below; the aggregate gates remain required before acceptance.

The second projection review correctly identified missing mounted/batched
membership-incarnation coverage and absent reader updates on some compact
persona acknowledgements. Other leads were rejected against source: accepted
canonical settings must remain separate from newer optimism, and the cited
creator-notes/pinned-chat UI belongs to the legacy shell. Sparse-character
hydration depends on the existing detail loader and its Retry surface; a
low-level hydration guard alone does not establish a broken reader journey.

### Phase 3 final source review before browser execution

`2c8265d41` fixes the reproduced mounted/batched same-ID retention problem and
updates reader persona state from certified PATCH fields or targeted reads.
Its six focused suites passed 197 tests. `d0e0ef4c1` adds an explicit reader
session-generation fence after a held read with an already-retained body was
shown to publish across promotion; all 86 hydration tests passed. Writer
hydration semantics are unchanged. `783d48469` makes the bounded character-view
type adaptation explicit; final Svelte check reports zero errors and warnings.
Server/browser typechecks passed, and architecture inventory remains at 4,274
fixture compatibility references with no new cross-runtime or bridge edges.

The first three-case browser baseline passed switching/draft recovery (3.6s)
and empty-server setup (1.3s). The generation case reached its exact completed
operation/result but had an incorrect terminal current-attempt expectation.
`completeGenerationOperationFinalizationInTransaction` deliberately clears that
pointer while retaining the exact completed attempt row. Only the terminal
expectation is corrected to null; running identity and final attempt/result
oracles remain. This is a test contract correction, not a production defect.
The initial run remains preserved in `/tmp/reader-phase3-browser-baseline`;
the final baseline, test freeze and fault controls are recorded below.

### Phase 3 browser and production-fault verification

The frozen three-case spec and harness are committed in `7c3da2160`.
After the terminal-pointer correction above, the emitted-build baseline passed
**3/3 in 9.9s**: A → B → A (3.5s), generation survival (3.7s), and empty setup
(0.95s). Browser typechecks, formatting and whitespace checks passed. Current
discovery is 83 cases in 20 specs; the smoke
[inventory](../../../docs/plan/browser-smoke-effectiveness/inventory.md#reader-phase-3-smoke-reconciliation)
records every new control and oracle.

Three separately declared production faults each fail the unchanged intended
assertion after its actual action preconditions: omitted explicit promotion
recovery leaves writer capabilities closed after SQL ownership transfers;
viewer-detach cancellation destroys the exact already-running durable job;
and dropped accepted setup consent leaves the genuinely empty server
uninitialized after the real button click. The
[findings](../../../docs/plan/browser-smoke-effectiveness/findings.md#reader-phase-3-production-fault-evidence)
record exact hunks, source/test/chunk hashes, commands, independent SQL/provider
truth and exclusions. All three are qualified fault detections, with no page
errors or test/fixture changes. No injected fault remains in production.

After all production files were restored byte-for-byte, a clean smoke build
and all three unchanged single-worker controls passed **3/3 in 10.0s**
(3.7s, 3.7s, 0.98s). Evidence is retained under
`/tmp/reader-phase3-writer-switching-fault-evidence` and the corrected baseline
under `/tmp/reader-phase3-browser-baseline-corrected`. Phase 3 remains pending
its `pnpm test:agent` and required `pnpm test:all`. Current documentation
validation passed 49 guides and explicit validation passed all 22 plan/index
documents; formatted Markdown and whitespace checks passed. Playwright
`--list` independently confirmed 83 cases in 20 specs.

### Phase 3 Acceptance and Phase 4 Handoff — 2026-09-07

Final tested source: `7c3da2160`, with production through `783d48469` and these
six evidence documents. `pnpm test:agent` passed in **2m 31.9s**: 709 frontend
suites/8,923 tests, 222 server suites/4,183 tests, zero Svelte errors/warnings,
server/browser types, topology, current documentation and smoke build.

The required phase-ending `pnpm test:all` passed all 13 lanes in **5m 54.3s**,
including **83/83 browser cases in 2.9m** (3m 10.0s including build/runner).
S81/S82/S83 passed in 5.5s/6.3s/1.6s; S80 passed in 12.0s, S22 in 46.4s,
and both changed mixed-client companions passed. Compatibility register/current
harness, UI coverage, scale, formatting and performance passed. Existing three
frontend/two server skips and the scale lane's deliberate name exclusions remain
unchanged. Additional pinned compatibility comparisons, other browser engines
and physical devices are not claimed.

Current guides (49) and explicit coordination/index/plan documents (22) passed
validation; Markdown formatting and whitespace passed. Logs are
`/tmp/reader-phase3-final-test-agent.log` and
`/tmp/reader-phase3-final-test-all.log`. The three isolated negative/restored
controls retain their frozen source and artifact manifest in the linked findings.

**Phase 3 accepted.** Phase 4 owns selected-reader live partial/final display,
missing-descriptor/EOF/replay recovery, detach without cancellation, and strict
separation from writer controls/effects. Four read-only Luna preparations were
cross-checked against source; they are implementation input only. In particular,
current reattach consumes presentation before checking the stream descriptor,
but a focused reproduction is still required before calling it a demonstrated
defect. The public feature remains disabled. Smoke Phases 3–4 remain pending
until reader Phase 5's completed-feature handoff.

## Phase 4 Implementation — 2026-09-07

Prerequisite: Phase 3 accepted in `e075d3f64`. Four independent read-only Luna
reviews were reconciled against actual transport, presentation, effects and
browser owners. Permanent readers use a separate viewing path; the writer
reattach coordinator retains its existing recovery/effect ownership. Public
activation stays disabled.

- `8812e9895` adds authenticated GET-only stream observation with immutable
  lineage/operation/attempt/job checks, replay-aware parsing, verified job-only
  registry wrappers, exact terminal snapshot references and bounded auth/open/
  read/snapshot waits. All 54 focused transport tests pass. It never sends a
  writer header, cancellation, generation submission or completion effect.
- `70ec31f64` fixes the now-reproduced missing-descriptor reattach gap. The
  pre-fix test used the actual protocol/descriptor helpers: presented eligibility
  disappeared, the authoritative job remained, no refresh ran and the lifecycle
  stayed retrying. Descriptor validation now precedes consumption, with one
  bounded status/bootstrap probe, retained recovery eligibility, no unchanged
  metadata loop and stale replacement/lineage fences. All 49 reattach tests pass.
- `6bcd8ce9c` adds reader-owned send/Continue/regenerate presentation, stable
  operation/attempt and target row keys, explicit isolation from writer display
  stores, localized interruption status, scoped lifecycle/Refresh and safe
  partial copy. The 22 mounted reader, eight identity and six existing startup
  tests pass. Stream rows remain outside canonical messages and retained drafts.
- `fc5f03ea7` adds selected-chat discovery, one viewer/request/probe timer,
  bounded EOF/read retries, hidden/offline/session teardown and exact terminal
  hydration. Thirty-three coordinator tests cover stale reads, missing and
  replaced descriptors, command-before-terminal, newer already-terminal attempts,
  half-stream replay, Continue bases, finalization and current auth loss.
  Exact generation-suffix reads support targets outside the initial window and
  preserve certified prefixes/omitted Hypa state. All 89 hydration tests pass;
  aborted non-cooperative reads promptly release ownership for a new read.

Independent coordinator review identified and fixed a terminal newer-attempt
handoff, incomplete new-operation replacement and a stale false-hydration
continuation. Root review also fenced older active bootstrap responses after a
newer terminal frame and added target-specific hydration. The final combined
coordinator/hydration run passes 122 tests. Initial integration typechecks found
two test typing errors, both corrected. Final Svelte check reports zero errors
and warnings; protocol/shared-core/Fastify/browser typechecks pass.

The architecture check detected two new endpoint strings in the browser
read-only allowlist. `33ad31c87` records those reviewed test-only markers (20 →
22); production aggregate consumers/bridges remain zero and fixture compatibility
references remain 4,274. No owner policy or runtime allowance changed.

`586ad4591` drafts four independent real-browser journeys: same-owner partial
and terminal viewing, chat-switch/close/reopen detachment, streaming/stopping
role transfers and cancelled partial, and queued-finalization transfer/recovery.
`1dc49b259` and `b8e4f5970` add a read-only session snapshot to classify each
fetch at dispatch, distinguish authorized recovery from ordinary mutation
readiness and retain the actual 409 confirmation handshake. The production
writer session/epoch is independently checked against SQL.

The first four-case browser baseline at `a45fa4b39` built successfully but all
four cases failed (`/tmp/reader-phase4-browser-baseline-i9vgys8x`). The first two
completed their visible partial/final or chat-switch prerequisites before an
overly strict assertion rejected the existing read-only display-sources POST
identity header. The third reached actual writer transfer and exposed a Stop
TypeError when bootstrapped operation authority had no local cancellation row.
`3ab2f74fb` fixes the optional row access; the pre-fix regression reproduced it
and all 29 operation tests pass. `7188599b3` corrects the request classification,
retains the genuine confirmation handshake, and checks cancellation across all
non-read methods. The earlier Phase 3 durable-detach negative was independently
re-audited across all recorded API methods: no cancellation request occurred.

The fourth browser case reached a real queued finalization journal, transferred
the writer and committed one result, but its configured IGP effect was skipped.
A focused server regression proved the full settings read retained `igpPrompt`
while the narrow advanced read omitted it. `2c44274ac` exposes that retained
configuration through the read-only advanced projection without adding generic
write ownership, waits for scoped generation resources before recovered effect
claims, and supplies that resource view to the IGP request. The 110 frontend
and 49 server focused tests pass; Svelte reports zero errors/warnings and all
server/browser/architecture checks pass, with 4,274 fixture references unchanged.

An additional source review identified an independent persistence gap: an IGP
message PATCH could commit before writer loss suppressed its separate effect
receipt. The next writer could reclaim the lease and append again. A real route
regression now reproduces two suffixes and an extra revision in
`/tmp/phase4-igp-server-red.log`. `a5acf1883` now completes the exact unexpired IGP claim in the message command
transaction, checking lineage, character/chat/message and stored generation
identity. Message/effect failures roll back together; a later same-claim completed
receipt acknowledges the existing result. All 56 focused server tests pass,
including the red ordering, command replay, stale authority, rollback and legacy
compatibility. `6859f2096` carries that claim through both live and recovered IGP
into the frozen durable command, with no claim for legacy or unrelated effects.
All 432 focused client tests, 27 route-backed send tests and Svelte checking
(zero errors/warnings) pass.

The fifth browser journey holding the accepted PATCH response is drafted. Final
clean-build baseline, production-fault/restored evidence and both aggregate
gates remain pending. None of the initial four failed cases is counted as a pass.

The five-case baseline at `aee6815c3` built in 12.94s and passed S84–S86,
including Reader close/reopen and both streaming/stopping role transfers.
S87 completed its queued transfer, canonical result and configured IGP effect,
but the Reader Refresh click was blocked by the exact deliberately injected
storage-error alert. Source review shows the still-current writer reports that
queued terminal failure; the corrected journey will explicitly assert and
acknowledge that error through OK before transfer, retaining the same queued
journal and all recovery oracles.

S88 reached a real accepted IGP PATCH and atomic completed receipt, but appended
`Request settings are not ready.` instead of the configured output. Live IGP
had not passed the request-scoped settings view, and failed provider results
were treated as appendable text. Two focused tests reproduced those separate
failures before fixing the live caller and rejecting failed request results.
The four final focused suites pass 63 tests. Evidence and exact gate/alert
snapshots are under `/tmp/reader-phase4-five-baseline-utchvix2`; this run remains
3/5, and no production fault has yet run.

`25764dced` commits the live IGP correction. The next baseline at `b56d9275e`
passes S84–S87 (4/5 in 46.9s). S88 now has the correct real echo request,
appended suffix and atomic completed IGP receipt, but its held-state assertion
incorrectly expected TTS to remain pending. The live terminal settles TTS as
`skipped/live_terminal/not_requested` before plugin output and IGP; this is the
observed, source-backed behavior. The browser correction retains that exact TTS
receipt unchanged across transfers. `/tmp/reader-phase4-final-five-baseline-gg4d0il3`
preserves the 4/5 result and gate evidence; it is not final acceptance.

### Phase 4 Final Browser Baseline — 2026-09-07

At `40b3eb516`, the final clean build passes in 14.88s and all five unchanged
browser cases pass in 49.2s. Every case has a nonempty role audit, no page errors
and no forbidden Reader calls. S88 completes A→B, late original PATCH response,
B→A and Reader Refresh with one real IGP completion request, one PATCH transport,
one granted claim plus a harmless recovery probe, one suffix/message.updated
and the same completed live-terminal IGP receipt throughout. Earlier 0/4, 3/5
and 4/5 runs remain recorded with their exact causes and source limits.

The baseline artifact is `/tmp/reader-phase4-five-baseline-final-hr9fcca2`.
All 1,322 successful script URLs match the frozen 503-file emission catalog;
source inputs are unchanged throughout. This is URL-to-emission attribution,
not an independent hash of downloaded script response bytes. Six declared
production-fault controls and final restoration, then phase-ending agent/full
suite verification, remain pending. The feature remains disabled by default.

### Phase 4 Fault Controls and Aggregate Verification — 2026-09-08

All six exact production-fault negatives at `40b3eb516` qualify: missing Reader
partial, missing canonical publication, retained detached viewer, the reproduced
promoted Stop exception, omitted configured IGP read and missing atomic IGP
receipt. Their unchanged browser oracles fail after their declared prerequisites;
downstream actions not reached are explicitly excluded. Source is restored
byte-for-byte between every fault. Full protocol, literal hunks, SHA-256 values,
branch/chunk/trace/SQL evidence and precise results are in the
[smoke findings](../../../docs/plan/browser-smoke-effectiveness/findings.md#reader-phase-4-production-fault-evidence).

The final clean restored build passes in 12.32s and the same five cases pass
in 51.1s. All frozen main/lab inputs match; the lab is clean, emitted scripts
contain no fault markers, and no browser/build job remains running. All five
have nonempty Reader audits with no forbidden calls or page errors. The final
atomic IGP case again completes A→B, late original response, B→A and Refresh
with one provider effect, one append and unchanged receipt state. The manifest
is `/tmp/reader-phase4-fault-campaign-p0d1439n/campaign-summary.json`.

Implementation and self-review are complete. Current documentation validation
passes all 49 guides, explicit validation passes all 22 plan/index documents,
and Playwright discovery confirms 88 cases in 21 specs. Changed Markdown is
formatted and whitespace checks pass. The required phase-ending
`pnpm test:agent` and `pnpm test:all` are the remaining acceptance gates. The public flag stays disabled until the
Phase 5 rollout work and evidence are complete.

`pnpm test:agent` passes at `40b3eb516` plus these evidence documents in
2m 34.9s: 712 frontend suites / 9,045 passed tests (three existing skips),
223 server suites / 4,222 passed tests (two existing skips), zero Svelte
errors/warnings, server/browser types, topology, current documentation and
smoke build. Log: `/tmp/reader-phase4-final-test-agent.log`. The required
`pnpm test:all` is running at that implementation; Phase 4 remains pending its
result before the Phase 5 handoff.

### Phase 4 Acceptance and Phase 5 Handoff — 2026-09-08

Final implementation: `40b3eb516`, with the six evidence documents committed
with this acceptance. `pnpm test:all` passes all 13 lanes in **6m 4.9s**,
including **88/88 browser cases in 3.1m** (3m 19.2s including build/runner),
current compatibility, UI coverage, Realm scale and frontend performance.
S22's full input/remount case passes in 44.7s. The existing three frontend/two
server skips and deliberately filtered scale/performance lanes retain their
stated scope; no new skip or exclusion was added. Physical devices, other
browser engines and the separate pinned compatibility lane are not claimed.
Log: `/tmp/reader-phase4-final-test-all.log`.

Current documentation (49) and the explicit coordination/index/bundle check
(22) pass, with Markdown formatting and whitespace checks. The final five-case
baseline and restored controls remain tied to their frozen inputs and six
qualified negatives in the linked smoke findings.

**Phase 4 accepted.** Phase 5 now owns default-enabled startup, simultaneous
readers, combined lifecycle/security/operational evidence, fallback preserving
local work, and current guide updates. Read-only preparation has identified
fixture ownership and evidence gaps; it does not establish rollout acceptance.
The public flag stays disabled until Phase 5 applies the authorized default and
verifies it. Smoke Phases 3–4 remain pending until the completed reader handoff.

## Phase 5 Combined Verification and Rollout — 2026-09-08

Prerequisite: Phase 4 accepted in `987ea4745`. The public default remains
disabled while the remaining combined evidence is prepared. Four read-only
Luna preparations and a separate lifecycle/operational review were reconciled
with the actual source and accepted test limits.

Three bounded implementation owners are active. The browser owner extends S80
to keep two Readers simultaneously connected and prepares a real server-restart
journey plus conservative fallback with an actual pending command and unsent
draft. The fixture owner preserves real authenticated API import but leaves
ordinary initial fixtures unowned, auditing null owner/epoch zero before and
after import. Explicit writer-import, migration and empty fixtures retain their
named purposes. A focused operational companion will exercise nonempty
memory/BardWiki projections, real listener delivery and zero mutation transport.
The existing source/gated-UI policy does not add a Reader authoring workspace.

Existing focused/mounted proof already covers heartbeat/replay-unavailable
recovery, authenticated projection clearing, old-lineage queries, stale direct
writes and operational version ordering. Those results retain their precise
scope; they are not relabeled as physical-device or full browser replacement
journeys. The missing actual Reader/server-restart composition is added rather
than expanding every ordering variant into a browser campaign.

After the combined feature evidence passes, this phase applies the authorized
default-enabled flag and verifies the normal no-override build and explicit
conservative fallback. Prepared guide edits remain unapplied while they would
state a default that the source has not yet adopted. Final-source focused,
fault/restored, aggregate, documentation and archive work remain pending.

The focused operational companion is committed in `d0fae009e`: all 20 reader
sync tests pass, including nonempty memory/BardWiki snapshots and listener
updates, independent stream versions, reconnect fences and exactly four
GETs with no mutation transport. This is actual projection-consumer execution
with controlled transport, not a mounted Reader BardWiki workspace.
`b898d6e6a` changes ordinary browser seeding to authenticated unowned import;
six fixture tests and browser TypeScript pass. The fixture proves null owner
and epoch zero around the real import rather than clearing ownership afterward.
Neither result enables the public default or accepts the pending browser work.

### Phase 5 Enabled-Build Baseline and Integration Repairs

`d3f3de973` extends S80 to keep two Readers live and adds S89/S90 for actual
Fastify/SQLite restart and fallback preserving a native encrypted command plus
a newer composer draft. The initial TRUE build passes, but its selected run is
**1 passed / 1 failed / 1 interrupted**: S80 passes; restart reaches successful
same-document reconnect, then the helper incorrectly expects an inline editor;
fallback is interrupted at that same helper before its distinct contract.
`4dfac6c1e` follows the actual Popup Editor → Plain text editor → Close save
entry and bounds action waits. The fresh TRUE build then passes in 12.81s and
all three cases pass in 16.1s. Both initial override values are null. S90 records
one encrypted row, one same-ID replay with only baseRevision rebased, one edit/
event/receipt/ACK, and the newer visible draft after conservative reload. S89
records interrupted retained content, same-document reconnect on the same port,
a real post-restart edit, and exact native SSE cleanup. This restarts the Fastify
instance and SQLite on the same data directory; it is not an external process kill.

The full TRUE cohort at `4dfac6c1e` then finishes **80 passed / 10 failed** in
3.7m. Required integration-artifact merging succeeds; all frozen source inputs
remain unchanged. Across selected/full runs, 21,977 successful script URLs map
to the emitted catalog (URL attribution, not independently downloaded-byte
hashing). The three new cases remain passing, but the failed cohort blocks
rollout. Artifacts are `/tmp/reader-phase5-true-baseline-vqzd3lau` and
`/tmp/reader-phase5-true-baseline-n6o1w41m`.

| Failed boundary                                            | Source-backed disposition                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S23/S24 raw startup text; S25 two older-display requests   | The automatic writer preview mounts Reader detail/transcript before conditional acquisition and writer plugin/display readiness. `36f0d33ff` retains shell/navigation preview but defers reader content until an actual reading/writing disposition, including interrupted initial recovery. Two mounted pre-fix failures reproduce the unwanted reads; 66 focused tests pass. Original browser display oracles remain unchanged and await rerun.          |
| S46 empty reroll candidates after visible completed reload | A deterministic real hydration/role/store regression reproduces a Reader-filled body satisfying writer fast paths without seeding persisted alternates. `f24d781ae` tracks unseeded body epochs across resets and metadata clones, requiring one authorized writer read; Reader event/bulk application cannot seed writer state. Hydration/reactivity/reroll-owner suites pass 102/6/6. Final browser composition remains pending.                         |
| S49 cold selected-locale failure loses its retry flow      | Initial preview failure silently settled as a Reader before acquisition. `a9e2ad06e` keeps unresolved shell/locale failures on acknowledged startup retry and fences auth/session loss during the alert. Three pre-fix cases fail; all 231 bootstrap/startup tests pass. A subsequent typecheck found two alert-fixture return types; those are corrected before the next browser source.                                                                  |
| S50 later fresh contexts; S76 later test startup           | Both reused a durable owner across new browser sessions. `e8333ffa2` creates one locale harness per cold/warm pair (all 12 samples retained) and one visible-state harness per case. Real auth-only import and all original actions/oracles are preserved.                                                                                                                                                                                                 |
| S44 offline route-loader error absent                      | Managed offline clients intentionally expose interrupted reading and cannot execute writer Grid route loading. `1f682514c` retains only this route-loader case under explicit conservative startup; its failed-chunk/Retry/focus oracles are unchanged. Normal Reader offline recovery remains S80.                                                                                                                                                        |
| S77 no forced reload after import                          | The real held PATCH receives 409 after a coherent new-lineage Reader has superseded its writer generation; the document correctly remains open. `ac83fdad2` retains the old forced-reload case explicitly conservative and adds S91: hold until actual Reader replacement, release the old conflict, prove no automatic acquisition, then Use this device and restore the original sidebar under same-owner authority. New browser/fault proof is pending. |
| S16 390px tall chat-list entry timeout                     | The trace-free case reports only a 30s timeout. Its 58 frame samples end at 2.296s with readable tall content and a −0.296875px offset. This does not establish a geometry failure. The unchanged eight-case entry suite must rerun after the preview fix; a repeated failure requires bounded boundary/cleanup diagnostics.                                                                                                                               |

The prior passing legacy takeover case also records three pre-navigation
sessionStorage SecurityErrors from its unguarded setup script. Its mode setup
now uses the existing guarded shared helper, preserving the exact modes and
ownership assertions; the focused companion will verify this correction.
The public default remains disabled. The next candidate must pass the seven
affected specs (28 cases), that legacy companion, and the complete 91-case TRUE
cohort before its frozen fault/restored campaign and default/FALSE-build checks.

`48288d595` corrects the alert fixture types; `262385732` reuses guarded legacy
mode setup. Final Svelte checking reports zero errors and warnings; protocol,
shared-core, Fastify and browser types pass. Architecture counts remain 4,274
fixture references and 22 reviewed seams, with no new owner allowance. Current
documentation (49), explicit plan/index validation (22), formatting and whitespace
pass. Playwright discovery confirms 91 cases in 22 specs. These are preparation
checks, not acceptance of the pending corrected browser cohort.

### Corrected Enabled Baseline and Qualified Fault Controls

The first corrected run at `88893facd` passes every product oracle in S23/S24/S25
but times out during harness shutdown: **25/28 affected cases pass**, while those
three hit their generic teardown deadline. The legacy companion also passes.
A temporary native diagnostic proves the writer SSE is already closed when the
page closes; the final asset response finishes, leaving one idle pooled HTTP
socket and no open response. Closing the owned BrowserContext allows Fastify's
normal close hook to run. This is a fixture transport-pool lifetime issue, not a
Reader SSE leak. The diagnostic helper was restored byte-for-byte.

`22da08cd1` changes exactly five owned fixture cleanup sites in four specs from
page closure to context closure. Product assertions, timeouts and shared server
shutdown remain unchanged. Browser types, formatting and whitespace pass.
The fresh TRUE build passes in 12.80s; its 503 emitted files are byte-identical
to the preceding build. All **28 affected cases**, the **S32 legacy companion**,
and then the **complete 91-case cohort** pass (full run 193.4s). The three rendering
cases also pass under four-worker load. The required integration-artifact merge
passes, frozen inputs are unchanged, and no page errors occur. Across these
runs, 26,827 successful script URLs map to the emitted catalog. This is URL
attribution, not independently downloaded-byte hashing.

Five predeclared production faults then qualify at `22da08cd1` with unchanged
tests, fixtures and configuration: cross-Reader revision deduplication; omitted
Reader reconnect; premature current-lineage outbox disposal during fallback;
omitted composer-draft restoration; and omitted guarded sidebar restoration.
Each reaches its named transition and fails the intended assertion. The clean
restored four-case cohort passes **4/4 in 18.3s** after a 13.14s build, with no
emitted/runtime fault markers, no page errors and 1,374 successful script URL
receipts. Both main and the detached lab retain their exact frozen inputs.
The [smoke findings](../../../docs/plan/browser-smoke-effectiveness/findings.md#reader-phase-5-production-fault-evidence)
contain the literal hunks, commands, hashes, prerequisites and assertion results.
Accepted Phase 4 controls retain their unchanged generation/effect source limits.

Baseline artifacts are `/tmp/reader-phase5-true-baseline-69qe4gge`; teardown
observations are `/tmp/reader-phase5-teardown-diagnostic-yvh8b6qn`; the complete
fault campaign is `/tmp/reader-phase5-fault-campaign-8i60779j`. The checked-in
reproduction record does not depend on retaining those temporary directories.

### Default Activation and Remaining Phase Gates

With the combined feature baseline and fault/restored evidence passing,
`70a8b18e1` applies the authorized default. All ten flag tests pass: unset/empty
values enable connected readers, exact `FALSE` selects conservative startup,
and smoke storage overrides cannot affect ordinary builds. `a394b1310` updates
ten shipped guides and three test guides, including initial shell-only preview,
acknowledged locale/shell retry, authorized reroll hydration after Reader use,
atomic IGP completion, draft/intent scope, and actual browser evidence limits.
Current documentation validation passes for 49 files; explicit validation covers
24 plan, coordination and index documents. Formatting and whitespace pass.
Original broad audit dates are retained with targeted source-check dates.

The normal no-override build, actual compiled-FALSE fallback, and final
`pnpm test:agent` / phase-ending `pnpm test:all` are still pending. Phase 5 is
not accepted and smoke Phases 3–4 remain pending until those checks pass.

### Normal and Compiled-FALSE Rollout Verification

At `a394b1310`, a separate clean checkout freezes 2,473 inputs while main receives
only evidence-document updates. With `VITE_FAST_BOOTSTRAP_OBSERVER` and
`RISU_READER_ROLLOUT_COMPILED_FALLBACK` both unset, the fresh normal build passes
and S89/S90/S91 pass **3/3 in 18.8s**. S89/S90 capture null initial browser
overrides; S91's null-override assertion and same-document sidebar recovery pass.
This establishes ordinary default behavior rather than relying on an enabled
smoke override.

A separate build with `VITE_FAST_BOOTSTRAP_OBSERVER=FALSE` then passes S90's
`RISU_READER_ROLLOUT_COMPILED_FALLBACK=TRUE` variant **1/1 in 5.6s**. Only initial
fixture establishment uses enabled overrides. Before the actual writer reload,
its override is removed; the new document is an unmanaged conservative writer
with the same identity, lineage and epoch one. The native encrypted mutation
replays with its same ID and semantic body, allowing only baseRevision rebasing.
One ACK settles the original receipt; SQL contains one edit/event/receipt and
no unsent draft text. The newer sequence-two composer draft is visibly restored,
queues empty, and the still-connected Reader makes no forbidden call.

Build-process durations are 15.55s normal, 13.19s FALSE and 14.30s restored
normal. Both catalogs have 503 files; FALSE differs as expected, while every
restored normal file hash exactly matches the first normal build. The latter is
an emission comparison, not an extra browser run. Normal/FALSE audits capture
702/343 successful script URL receipts, with no page errors and unchanged lab
inputs. Source and [reproduction commands](../../../docs/plan/browser-smoke-effectiveness/findings.md#reader-phase-5-default-and-fallback-build-proof)
are recorded in the smoke findings; temporary artifacts are
`/tmp/reader-phase5-default-verification-tfvklw0_`.

Implementation, guide review, fault controls, normal rollout and conservative
fallback are complete. The final `pnpm test:agent` and phase-ending
`pnpm test:all` now own the remaining acceptance evidence. No required phase
check has been transferred to the user.

### Final Aggregate Inventory Reconciliation

The first final `pnpm test:agent` at `b02341258` exits 1 in 2m 23.0s because
the architecture inventory detects two stale rollout-marker entries. Other
executed lanes pass: 712 frontend files (9,080 tests, three existing skips),
224 server files (4,228 tests, two existing skips), Svelte check with zero errors
or warnings, topology, current docs and the normal smoke build. The failed
server-check stops at inventory before Fastify/browser typechecking; neither the
build nor those passing lanes accept the failed aggregate.

A complete observation comparison identifies only two required baseline edits:
`src/ts/observerShellFlag.test.ts` now contains eight build-flag references rather
than five, and `262385732` removed the inline smoke storage marker from
`fastifyBrowserSmoke.spec.ts` when it reused the existing guarded helper. Updating
that count and deleting the obsolete row makes the comparison exact. The live
machine baseline retains 4,274 fixture references, 30 consumer groups, zero
bridge families and all existing owner/policy metadata; reviewed seam rows change
from 22 to 21. No production aggregate access or new exception is admitted.
The focused `pnpm check:server` now passes, including protocol/shared-core,
architecture, Fastify and browser types. Repeated final aggregate gates remain
pending.

### Final Full-Suite Failures and Bounded Repairs

The repeated `pnpm test:agent` at `90069ac9c` passes in **2m 24.2s**.
The required `pnpm test:all` at that same clean source exits 1 in **6m 20.0s**:
**89/91 browser cases pass**; S47 never reaches its language selector and S22
has zero readable sample-zero pause anchors. All twelve other lanes pass,
including 8,839 ordinary frontend tests, 241 UI tests, 4,228 server tests,
18 current compatibility cases, the Realm scale case and six performance cases.
There are three existing frontend and two existing server skips. The passing
agent aggregate and other lanes do not accept the failed phase-ending run.
Logs are `/tmp/reader-phase5-final-test-agent-restored.log` and
`/tmp/reader-phase5-final-test-all.log`.

S47's trace shows its actual character-handler chunk completing across newer
Settings navigation; `background-ready` had already completed. App still gave
the retained initial Reader intent priority over the newer writer URL, so no
Settings or Language chunk was requested. `a703b9d4b` compares semantic route
keys, discards only the superseded exact intent sequence and fences callbacks by
the route effect's lifetime. Matching aliases and failed matching retries remain
valid. Three mounted pre-fix regressions fail; the final App/router/intent suites
pass **28/40/4 tests**. `678876571` adds S92: hold the real emitted initial
character-handler request, establish writer capabilities, navigate through the
production router, and require visible Settings before releasing that handler.
The original three locale cases are unchanged. Its post-release two paint frames
are an observation; the mounted held-promise case owns exact completion fencing.

S22's fourteen pauses all lacked a readable first sample, so no pause geometry
assertion ran. Seven became readable later; pause 11's message 241 stayed readable
at zero drift through samples 1–29. This is diagnostic evidence, not a replacement
passing oracle. Prior accepted controls also contained four to seven wholly
unreadable pauses; the parser, scheduler and test bytes matched the earlier
BSE-005 source. No new production geometry or parse-delay regression is proven.
`d72f12a01` adds one bounded prepared pause at the existing real ordinary-row
remount return. Its first geometric readable snapshot becomes sample zero before
29 further fixed-cadence samples; identity, every-frame readability and the
one-pixel bound remain exact. Both original seven-gesture passes and all original
oracles are unchanged; all preparation/measured frames retain the 76-row bound.

At combined `678876571`, Svelte checking has zero errors/warnings and server,
browser, protocol and shared-core types pass. Architecture remains 4,274 fixture
references, 30 groups, zero bridge families and 21 reviewed seams. The frozen
normal-build campaign is pending: eleven navigation/recovery/switching cases and
two S22 controls, the retained parser-owner fault twice, the narrow S92 retained-
intent fault once, restored S22/S92 controls, actual compiled-FALSE S90, and a
byte-identical normal rebuild. No unrelated fault matrix is added. Final agent
and full phase-ending gates must run again after the production App change.
The [smoke findings](../../../docs/plan/browser-smoke-effectiveness/findings.md#reader-phase-5-final-gate-repairs)
own the reproducible campaign and its remaining source limits.

The first frozen combined baseline at `678876571` passes **10/11 in 29.0s**
after a 12.15s normal build. New S92 passes its held-handler visible Settings,
ready route, actual response and same-document assertions, then fails an
incorrect final `canGenerate=true` expectation. Both held and final snapshots
already show `canMutate=true`, writing/live authority and `canGenerate=false`:
Settings clears `selectedCharID`, so chat readiness is correctly revoked before
the older handler is released. This is a new test-contract error, not a product
regression. `60ac61bde` asserts that exact Settings capability state both before
and after release, plus retained writer authority; initial chat generation
readiness and all navigation/visibility oracles stay intact. No S22 or negatives
ran from the failed baseline. The campaign restarts from a fresh frozen source.

### Final-Gate Repair Controls and Renewed Fallback

At frozen `60ac61bde`, all eleven navigation/recovery/switching cases pass,
followed by two S22 baselines (50.7s, 45.5s). The retained parser-owner fault
qualifies twice at direct row-298 remount; the narrow App intent-priority fault
qualifies once at visible Settings before the held handler is released. Exact
restoration and a fresh normal build pass S22 twice (44.9s, 44.3s) and S92 once
(1.4s). All original fourteen pauses and the prepared thirty-frame pause remain;
its geometric sample-zero identity stays readable at zero drift with 31 maximum
residents. The failure does not depend on later survivor selection or relaxed
bounds. BSE-006's browser priority fault retains App's completion cleanup.

The actual compiled-FALSE S90 passes after removing the writer override before
real reload: same session/lineage/epoch one, native encrypted intent replay with
same ID/semantic patch, one ACK/edit event/receipt, and the newer sequence-two
draft restored locally and absent from SQL. The Reader remains live in its
original document with zero forbidden requests. Final normal restoration matches
every one of the 503 baseline output files. Across the completed campaign,
17 positive executions pass, three expected negatives qualify, 3,028 successful
script URLs map to their catalog, and zero page errors occur. All 2,473 lab inputs
remain frozen and both production faults are restored byte-for-byte.

The [renewed proof](../../../docs/plan/browser-smoke-effectiveness/findings.md#renewed-combined-controls-and-fallback)
records exact commands, hashes, timing, assertion ordering and scope limits.
Discovery at `593b01eae` confirms all 92 cases/22 specs, twelve local support
files and four PNGs; current anchors and the full hook map are reconciled.
Both final aggregate gates are now repeated at unchanged production/test source
plus these evidence records; no source work remains pending those checks.

## Phase 5 Acceptance and Stage 3 Handoff — 2026-09-08

**All reader phases and in-scope completion criteria are accepted.** Final source
`eb9673942` is clean, with production through `a703b9d4b` and browser tests through
`60ac61bde`. Both required aggregates run at that identical source, with rollout,
fallback-variant and worker environment overrides unset.

| Final gate                   | Result and actual scope                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:agent`            | PASS, 2m 21.3s: all seven lanes; 712 frontend files/9,083 passing tests plus three existing skips, 224 server files/4,228 passing tests plus two existing skips; Svelte zero errors/warnings, protocol/shared-core/Fastify/browser types, topology, 49 current docs and normal smoke build. This command does not run Playwright.                                                                |
| Phase-ending `pnpm test:all` | PASS, 7m 16.0s: all thirteen lanes, including **92/92 browser cases**, 8,842 ordinary frontend tests, 241 UI coverage tests, 4,228 server tests, 18 current compatibility cases, one selected Realm scale case, six performance cases, types, topology, docs and formatting. Three ordinary frontend and two server skips remain; the scale selection intentionally excludes its other 29 cases. |

The browser lane takes 4m 34.3s including its build. S22 passes in 45.2s;
S47's original locale race passes in 2.1s and new S92 in 1.9s. Required integration
artifact merging passes with the complete current-run cohort. The two earlier
failed final gates and first S92 test-contract failure remain recorded; their
passing replacements do not erase those observations. Logs are
`/tmp/reader-phase5-final-test-agent-round3.log` and
`/tmp/reader-phase5-final-test-all-round3.log`; source/environment metadata is
`/tmp/reader-phase5-final-gates-round3-source.json`.

All 34 E01–E34 surface families have implemented dispositions and proof.
Accepted browser/focused contracts cover independent Readers, explicit transfer,
retained local work, generation observation/effects, operational events, bounded
lifecycle recovery, replacement/authentication and stale-write rejection.
Normal default and actual compiled-FALSE behavior pass at the repaired App source;
clean restoration matches all 503 output files. The shipped/test guides describe
these boundaries, including semantic route supersession, shell-only initial
preview, acknowledged startup retry, writer reroll hydration and atomic IGP
receipts. Current docs (49), explicit plan/index docs (24), formatting and
whitespace validation pass for the acceptance records.

No required feature is deferred. Named-device discovery, remote assignment,
automatic following, cross-device draft transfer, collaborative editing and a
full offline database remain the original product follow-up scope; the future
owner of that requested work must define its authority/storage model before
expanding this release. Browser proof uses built Chromium, explicit mobile and
network/lifecycle emulation, real disposable Fastify/SQLite and controlled local
providers. Physical-device/alternate-engine/provider availability, production
worker timing and additional pinned compatibility lanes retain their exclusions.

This intact reader bundle is archived under
`.archived-docs/ui-and-user-input/connected-read-only-clients`, preserving all
historical faults and source limits. The receiving smoke status resumes Stage 3:
reconcile remaining scenario/support dispositions, the two source-backed title
corrections, affected critical browser evidence and its own required phase gates.
Reader acceptance does not accept those unfinished smoke phases.

## Smoke Phase 3 Maintenance — 2026-09-08

The receiving smoke audit completes all remaining source dispositions and
revalidates affected critical journeys. Its first full gate finds a fixture
configuration write racing native chat selection, before generation/restart;
no product wrong-target send is established. `ee04eacba` adds a read-only
route/local/SQL/selection-intent precondition while preserving all eleven original
lifecycle journeys and configuration retry logic. Both all-eleven controls and
the named server selection-persistence fault qualify. The repeated smoke Phase 3
full gate at `d5b5e5ed7` passes all thirteen lanes and 92/92 browser cases.

This changes test setup only; Reader product acceptance and rollout/fallback
contracts retain their original source and scope. The receiving
[smoke status](../../../docs/plan/browser-smoke-effectiveness/status.md#phase-3-acceptance-2026-09-08)
records the failed run, verified repair and separate Phase 4 closeout requirements.

## Combined Closeout Maintenance Acceptance — 2026-09-08

The smoke closeout's BSE-009 writer-startup repair is fully revalidated at
`39356086c`: final `pnpm test:agent` passes all seven lanes in 2m 27.7s and
`pnpm test:all` passes all thirteen lanes in 6m 11.4s, including 92/92 browser
cases. Its two qualified native-ordering negatives, both eighteen-case normal
cohorts and two actual compiled-FALSE controls pass at the identical application/
test implementation. The normal default, explicit switching, generation,
lineage/recovery and originating draft/pending-intent protections remain intact.
See the [complete smoke acceptance](../../../docs/plan/browser-smoke-effectiveness/status.md#phase-4-acceptance-2026-09-08)
for final source, counts, existing skips, no matching CI run and execution limits.
Earlier Reader phase evidence retains its original source; this maintenance
record supplies the affected final-source supplement. No Reader work remains.
