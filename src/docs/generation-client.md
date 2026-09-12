# Generation Client

Last audited: 2026-08-29.
Targeted source checks: 2026-09-12 (reader viewing, IGP recovery, durable Stop, and abandoned-send recovery).

This guide owns the browser side of durable chat generation: operation
acceptance, streaming, cancellation, reattach, terminal reconciliation,
generation effects, half-streaming, and completion audio. Visible transcript,
composer, progress, and confirmation behavior belongs in
[Svelte Chat UI](svelte-chat-ui.md); Fastify operation/job/timer ownership belongs
in [Backend Map](../../docs/structure/backend.md#generation-and-background-work).

## Coordinator And Key Files

`sendChat` in `src/ts/process/index.svelte.ts` is the writer coordinator for
chat generation UI. In Fastify mode it uses server prompt assembly and server
provider dispatch. Connected readers use a separate observation coordinator
and never call `sendChat` to watch a generation.

Important files:

- `src/ts/process/generationActivity.svelte.ts` owns the chat-keyed client
  activity registry, including independent numeric compatibility stages, typed
  monotonic display phases, activity start times, and abort controllers.
  `src/ts/process/index.svelte.ts` owns the high-level `sendChat` coordinator;
  `doingChat`, `chatProcessStage`, and `activeGenerationTarget` remain aggregate
  compatibility projections rather than the per-chat UI source of truth.
- `src/ts/server/generationOperations.ts` owns protocol-v1 atomic
  send/continue/regenerate acceptance, encrypted outbox replay, optimistic user
  rows, operation projections, attempt-fenced streams, cancellation, retries,
  and bootstrap reconciliation. The lower-level chat endpoint remains the
  compatibility path when the server does not advertise this protocol. For an
  accepted send, it validates the response's append event, buffers matching
  own-session SSE echoes until response reconciliation finishes, and applies a
  typed optimistic-message effect only while its chat-body projection epoch is
  still current. Invalid or stale event/effect data falls back to authoritative
  resource reconciliation instead of replacing the optimistic transcript.
- `packages/shared-core/src/providerCapability.ts` and
  `src/ts/process/request/serverPromptAssembly.ts` decide whether the selected
  request can run on the server.
- `src/ts/process/serverBackedSendChat.ts` builds server requests, maps legacy
  inlay ids to server asset refs, selects the advertised generation-operation
  protocol or lower-level `/api/v1/generate/chat` path, applies server message
  patches, and returns terminal data.
- `src/ts/process/request/serverChat.ts` parses chat SSE frames:
  `job_accepted`, stage, prompt, patch, info, token, side-effect,
  `agent_preset_progress`, `post_generation_progress`, warning, error, and
  done. It updates the scoped progress stores consumed by
  `AgentPresetProgress.svelte` and `PostGenerationScriptProgress.svelte`.
- `src/ts/process/halfStreamingProgress.ts` owns half-streaming token counts and
  throughput for the active character/chat/generation target.
- `src/ts/process/generationDisplayProjection.svelte.ts` owns transient,
  attempt-fenced display text for negotiated targeted regenerate. It never
  writes `Message.data`; presentation aliases let the generated message inherit
  the target row key during terminal authority handoff.
- `src/lib/ChatScreens/Chats.svelte` derives an ordinary-send presentation row
  from the active chat generation before a stream-owned assistant message
  exists. This UI-only row never enters the transcript owner. Once the exact
  generation id appears, its stable operation-and-attempt presentation key is
  adopted by the real assistant row and retained across activity settlement. A
  matching active-job projection bridges foreground viewer replacement so
  the row and its loading animation are not remounted during reattach.
- `src/ts/process/reattach.ts` coordinates writer background recovery by durable
  `(databaseLineage, operationId)` authority. `jobId` and `attemptNo` remain
  expiring stream descriptors, while local viewer/activity state is only an
  observation projection. Foreground bootstrap reads have a bounded deadline
  and recovery epoch: visibility, page-show, online, and focus wakeups coalesce,
  supersede pre-suspension reads, and reject late responses. A successful probe
  re-arms the exact live attempt and retires its old browser viewer without
  issuing Stop before it awaits transcript hydration, so a stalled resource
  read cannot retain the old activity spinner. Strict recovery hydration shares
  the foreground deadline and abort signal; absent-job lifecycles settle only
  after that hydration. Pending finalization/effect recovery comes from the same
  bootstrap snapshot.
  `generationJobLifecycles` records attached, retrying, exhausted-dead,
  completed, and cancelled viewer state plus the last transport error. Retry,
  Refresh, and Stop resolve a stale control through its recorded operation/chat
  lineage to the current exact authority. While a durable generation remains
  unresolved, a failed or incomplete foreground lifecycle probe receives bounded retries after
  500 ms, 2 s, and 5 s. A newer lifecycle signal, settled recovery, settled
  originating recovery obligation, or teardown supersedes that retry sequence.
- `src/ts/process/generationRecoveryObligations.ts` records pending generation
  dispatches before their network requests start. Protocol sends, targeted
  continue/regenerate, retries, cancellation, and outbox replay share this
  contract with direct durable chat submission. An in-flight dispatch and an
  uncertain outcome retain their own identity independently of the local
  activity spinner. Matching operation authority transfers terminal work to
  transcript reconciliation; a missing operation in a bootstrap is not proof
  that the request failed. Recovery can replay only the matching uncertain
  protocol intents through their idempotent outbox path. Direct compatibility
  POSTs are never automatically resubmitted.
  Capture/version checks prevent older authority reads or transcript hydration
  from settling newer work. Obligations survive automatic reconnection by the
  same writer and database; loss of that ownership or authentication revokes
  the old scope, and late callbacks cannot recreate its work.
- `src/ts/server/readerGenerationObservation.ts`, `readerGenerationStream.ts`,
  and `readerGenerationTypes.ts` own selected-reader status discovery,
  authenticated viewing, and disposable presentation independently of writer
  operation/activity/effect stores.
- `src/ts/process/generationEffectLedger.ts` claims and receipts client effects
  for the exact persisted generation. `recoveredGenerationEffects.ts` retries
  missing durable effects after bootstrap; late ephemeral effects are skipped.

## Preflight Persistence Gates

Before prompt assembly or provider fetch, `sendChat` awaits the character-owned
maintenance batch from `sendChatContext.ts`, the pending chat
generation-settings save, the pending selected-persona update, and a flush of
the selected character's debounced script-definition draft. A queued or failed
script save blocks generation just like another rejected/retained persistence
gate. For “send never reached fetch,” inspect `setupSendChatContext`,
`waitForPendingChatGenerationSettingsSave`,
`flushPendingSelectedPersonaUpdate`, and
`waitForPendingCharacterScriptDefinitionSave` before debugging the provider
adapter.

## Operations, Streams, And Reattach

The controls and recovery in this section require current writer authority.
Durable sends such as send, continue, and regenerate use operation-addressed
streams when protocol v1 is advertised; job-ID-only attachment remains a
compatibility fallback. Disconnect is an observation failure and does not imply
generation failure. Explicit Stop uses the exact operation (or the compatibility
job when no operation exists). The live adapter performs one immediate,
replay-aware reopen after an unrequested SSE EOF/read failure, rebuilding
replayed token deltas from zero and deduplicating replayed non-token effects.
Because that replay window may contain only a token suffix, a durable
`done.result` replaces the accumulator as the last cumulative raw snapshot
before stream closure. After an explicit replay gap, the canonical terminal can
also establish readiness when hard caps evicted `prompt` or `info`. Extend-mode
Continue carries its immutable pre-generation base in `info` and the terminal
fallback, so an outer reattach retry cannot capture its already-rendered partial
as a new prefix. An additive cancelled outcome still reconciles the persisted
partial projection, but bypasses output listeners, IGP, notifications, emotion
work, rerolls, resend, terminal TTS/inlay work, and completion sound.
Foreground visibility, page-show, online, and focus probes refresh operation,
job, finalization, transcript, and pending-effect authority so a mounted mobile
tab can recover even when its original connection was discarded before the id
reached JavaScript. A stale-attempt response redirects only to an exact newer
live descriptor; terminal/non-live responses and compatibility 404s force
authority and transcript reconciliation before viewer UI is settled. Viewer
transport failures never use the ordinary provider-error/inlay path until
durable authority proves a terminal generation failure. Terminal `postGeneration` data
can advance the revision cache, apply a server-owned `messagePatch`, render the
inlay screen over `finalText`, request `resendChat`, or surface an Agent Preset
error as a failed terminal result. Generation results are persisted server-side,
so the browser suppresses the old generation-result command in server-backed
paths. The configured message-completion sound is emitted once through its
ledgered successful terminal lifecycle, rather than from the selected chat
component, so background and reattached generations retain the same behavior.

Protocol Stop is durably staged before its cancellation request. If cancellation
wins before operation acceptance, the server records a cancel-before-acceptance
tombstone, creates no attempt, launches no provider job, and appends no user
message. The browser rolls back its optimistic append only after acknowledged
cancellation. A lost or failed acknowledgement keeps the durable Stop
obligation for replay instead of treating the operation as cancelled.

An interrupted accepted-send recovery can be dismissed only while its durable
operation is abandoned. Dismiss sends Stop for that exact operation and removes
the recovery row only after acknowledgement; failure, writer/session scope loss,
or re-promotion races keep the warning and recovery action. Retry is a separate
action and asks for confirmation when the provider may already have run.

## Connected Reader Observation

Reader content admission is separate from an initial writer's coherent shell
preview. Once admitted, `ReaderTranscript.svelte` starts one
`readerGenerationObservation.ts` owner for its selected character/chat
incarnation and client-session generation. Status
discovery, the operation/attempt/job stream, terminal-snapshot reads, and
transcript hydration use authenticated GET requests. The reader does not seed
writer operation/activity stores, consume writer reattach eligibility, claim
completion effects, or run submission, Stop, generation retry, or persistence
retry actions. `canGenerate` remains false while it watches.

`readerGenerationStream.ts` validates lineage, operation, attempt, and job
identity on durable frames and any supplied nested identity. Protected replay
for the same attempt can predate the descriptor's projection epoch; terminal
frames may advance it. Request/watchdog deadlines and currentness checks fence
every awaited boundary. Terminal snapshots are fetched only from the verified
job's exact reference. Each viewer call owns one attachment; EOF and abort
retire the HTTP viewer without cancelling the durable operation.

The coordinator owns bounded discovery/reconnect work and cumulative raw text.
Reopen resets the accumulator, replay gaps suppress incomplete suffix display,
and half-streaming withholds token text while exposing token counts. Continue
extension uses the immutable server-supplied base, never a displayed partial.
Prompt frames, stream message patches, and effect-bearing callbacks do not
modify the reader transcript. Hidden/page-hidden pages detach observation while
retaining their last presentation until the foreground probe succeeds or fails,
so an ordinary return does not flash an interruption state. Offline pages and
actual viewer failures surface interruption immediately. Visibility/reconnect
and the transcript's Refresh action retry reads. Changing chat, incarnation,
session, or lineage retires the old viewer and callbacks.

Before attaching to an unloaded Continue/regenerate target, the coordinator
uses `hydrateReaderGenerationMessages()` to read the authoritative suffix
containing that target. Terminal reconciliation similarly resolves the exact
persisted result and checks its operation/attempt/generation identity against
current authority before releasing the transient view. Command SSE can expose
the canonical row before `done`; the presentation hands off without a duplicate
row while the coordinator finishes reconciliation. A non-persisting terminal
requires an authoritative read before its projection disappears. Interrupted
viewing leaves readable content and explicit status without retaining a busy
indicator.

Promotion and demotion replace read/write lifecycles without cancelling the
server job. Only the recovered current writer may resume generation controls
and completion effects. Row composition, stable presentation keys, and scroll
ownership remain in [Svelte Chat UI](svelte-chat-ui.md#connected-reader-transcript).

## Projection And Terminal Reconciliation

Stream writes, terminal message patches, cancelled-partial restoration, and
delayed inlay finalization resolve the stable live character/chat identity each
time. Chat-body projection and message-mutation-intent epochs detach an older
stream when authoritative hydration or a newer user edit wins; cleanup then
removes or restores only data still owned by that stream. This prevents late
tokens, terminal patches, or effect work from resurrecting or overwriting newer
authority.

### Targeted Regeneration

For `regenerateTargetProjection: 1`, targeted admission registers a preparing
projection before prompt assembly finishes. Cumulative provider text updates
that projection instead of appending a synthetic assistant. Terminal handling
installs the generated-id presentation alias, strictly hydrates the committed
chat resource, and removes the projection only after the generated authority is
observable. No-token failure or non-retaining cancellation simply drops the
projection, leaving the original target untouched; retained partials use the
same authoritative terminal handoff. Operation id plus attempt number rejects
late frames, and reattach reuses the same projection rather than appending a
duplicate row.

### Completion Audio

`messageCompletionSound.ts` lazily shares one decoded bundled-audio buffer and
`AudioContext`. `installCompletionAudioUnlock()` resumes and prepares that
context from an eligible pointer or keyboard activation without starting an
audio source, then suspends it while idle. Each actual generation- or
translation-completion ding uses a disposable `AudioBufferSourceNode`; ended or
superseded nodes are disconnected and the context is suspended again. Browsers
without Web Audio construct an `HTMLAudioElement` only for actual playback and
unload it afterward. Web Push remains the independent background-notification
path and is not enabled by completion-audio settings.

## Half-Streaming

When an `info` frame carries `halfStreaming: true`,
`src/ts/process/request/serverChat.ts` marks the stream as half-streaming and
buffers provider text in `tokenResult` instead of enqueueing it into the visible
stream. Progress remains live through `src/ts/process/halfStreamingProgress.ts`:
token frames use cumulative server-tokenized `generatedTokens` when present.
The row displays that cumulative count alongside a client-timed rolling output
speed. Each accepted count is timestamped when it reaches the browser, and the
rate is the token delta over at most the latest five seconds of arrival history.
The boundary count is interpolated when the five-second cutoff falls between
samples. The first non-empty sample establishes the baseline, so speed stays
zero until a later client-time sample provides a positive interval; samples
arriving in the same millisecond do not invent one. Server `elapsedMs` remains
available as transport metadata but does not drive the writer display. Counts
and arrival history reset for each generation or reattachment, and regressive
counts are ignored. Local and older server streams retain their frame-counting
estimate inside the same rolling window. The buffered text is enqueued once on
`done`.
Stop keeps a server-backed half-stream viewer attached until the raw buffered
partial and cancelled terminal arrive, then reconciles the exact processed
persisted snapshot. As a fallback, reconciliation can recreate a placeholder
already removed by abort cleanup. A local-provider half-stream has no server
terminal, so its buffered partial is applied through client editoutput before
abort cleanup.

## Persistence And Effect Recovery

Generation persistence failures also carry a browser reconciliation contract.
A terminal `persistenceDisposition: rejected` or `unconfirmed` clears the
provisional persistence marker, removes or restores only the still-owned
streamed projection, and force-hydrates the chat. A retryable `queued`
disposition is accepted only for a confirmed replayable server journal row and
keeps the provisional generation marked until an authoritative chat hydration
contains it. `committed_cleanup_pending` arrives on a successful `done` frame:
the authoritative message already exists and only retry-journal cleanup remains.
Bootstrap reconstructs pending and retained terminal journal state after reload.
Snapshot-safe provisional messages are reapplied after authoritative hydration;
repeated transient failures advance to a stalled marker while continuing capped
backoff retries, and `stalled_legacy` is shown as a distinct non-retrying state.
Conflicting post-generation script mutations arrive as warning frames but do
not erase successfully persisted generated message text.

Generation-finalization indicators retain a flat compatibility store for
bootstrap, polling, and smoke snapshots, while the transcript subscribes to an
independent per-chat projection. Clearing or acknowledging another chat cannot
rebuild the visible row model, and each visible projection builds message-id and
generation-id indexes once instead of scanning the flat list for every row.

Successful accepted sends may also schedule BardWiki automatic confirmation on
the server for the preceding exact `user -> char` source pair when the effective
chat policy enables it. Continue, regenerate, failed/cancelled work, alternates,
and the just-created current send do not qualify. This detached memory work does
not extend the generation stream or mutate the browser transcript; its bounded
status arrives through the BardWiki job projection. See
[BardWiki Memory](../../docs/structure/bardwiki.md#confirmation-and-background-jobs).

The `generation.persisted` read applies its bounded suffix in place. Safe
appends, replacements, and truncations preserve the resident prefix and message
object identity; placeholders are allocated only for genuinely unloaded
indexes. Terminal patches and later authoritative suffixes compare structured
values before assignment, so either delivery order converges without a second
meaningful transcript mutation. Plain generation-suffix responses deliberately
omit chat-wide Hypa state; the decoder carries an explicit inclusion bit so
omission preserves resident Hypa data, while full and ordinary ranged reads
retain the historical absent-means-clear behavior. Reroll alternates remain
included because every generation finalization can clear or replace that
authoritative candidate set.

IGP uses an explicit generation-settings database in both delivery paths:
`index.svelte.ts` passes the live send's scoped database, while
`recoveredGenerationEffects.ts` loads the generation resource surface and
resolves the exact recovered character/chat before calling
`postGeneration/igp.ts`. A missing recovery dependency cannot become a permanent
not-configured receipt. The append is fenced by writer/effect currentness,
abort state, stable message identity, expected source text, and generation id.

For a ledgered append, `evaluateIgp()` carries the optional exact
`igpEffect: { generationId, claimId }` through the message PATCH and waits for
durable acceptance, including queued settlement. The server accepts that claim
only with a data-only patch and matching text/chat preconditions, validates its
lineage, lease, and generation/message identity, and completes the effect
receipt in the same transaction as the text write. A failed transaction retains
neither change. The ordinary command receipt handles replay of an accepted
command; a later matching `igp`/`completed` receipt acknowledgement for the same
claim is idempotent, including after the original HTTP response was lost.
Readers perform neither the provider call nor the append/receipt work.

Ledgered completion callbacks emit development performance entries named
`risu:generation-effect:<kind>:<delivery>`. Best-effort emotion/image and plugin
output work yields through the browser scheduler after the transcript settles
when that API is available; effect claims, leases, completion receipts, and
idempotency keys retain their existing ownership.

## Adjacent Owners And Triage

Provider/profile resolution is canonical in
[Providers And Models](../../docs/structure/providers-and-models.md), prompt
construction in
[Prompt Assembly And Scripting](../../docs/structure/prompt-assembly-and-scripting.md),
and Agent execution in
[Agents And Presets](../../docs/structure/agents-and-presets.md).

When generation UI is wrong, inspect both the Svelte surface
`src/lib/ChatScreens/DefaultChatScreen.svelte` and the runtime files above. Its
visible ownership is documented in [Svelte Chat UI](svelte-chat-ui.md).
