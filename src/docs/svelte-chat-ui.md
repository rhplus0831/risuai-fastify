# Svelte Chat UI Guide

Last audited: 2026-08-29.
Targeted source check: 2026-09-10 (chat-menu modal opener and guided BardWiki workspace).

This guide owns the visible chat frame, transcript, message rows, composer
variants, generation/loading feedback, and in-chat confirmations. Return to the
[architecture index](../../docs/structure/README.md) for cross-layer ownership
or the [Svelte UI guide](svelte-ui.md) for the application shell.

## Fast Triage

Direct sections: [hydration/scroll](#transcript-hydration-and-paging),
[parse dependencies](#row-ownership-and-parse-dependencies),
[translation layers](#translation-layers-and-greeting-ownership),
[partial editing](#partial-editing), [composer](#draft-and-placement-ownership),
[keyboard viewport](#keyboard-viewport-coordination),
[send phases](#message-generation-phases), [regenerate](#targeted-regenerate-presentation).

| Symptom                                                              | Inspect first                                                                                                                   | Then inspect                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Chat frame, background, or display mode is wrong                     | `src/lib/ChatScreens/ChatScreen.svelte`                                                                                         | `src/lib/ChatScreens/BackgroundDom.svelte`, `src/styles.css`                                            |
| Transcript window, hydration, scroll, composer, or menu is wrong     | `src/lib/ChatScreens/DefaultChatScreen.svelte`                                                                                  | `src/lib/ChatScreens/DefaultChatScreen.loadPages.ts`, `src/ts/server/chatMessageHydration.svelte.ts`    |
| Reader transcript, partial output, or viewer refresh is wrong        | `src/lib/ReaderTranscript.svelte`                                                                                               | `src/ts/server/readerGenerationObservation.ts`, `src/lib/ChatScreens/readerGenerationRows.ts`           |
| One message, translation, parser result, or partial edit is wrong    | `src/lib/ChatScreens/Chat.svelte`, `src/lib/ChatScreens/ChatBody.svelte`                                                        | `src/lib/ChatScreens/ChatBodyParseMemo.ts`, `src/lib/ChatScreens/PartialEditController.svelte`          |
| Generation text, progress bar, stage color, or cancel state is wrong | `src/lib/ChatScreens/chatGenerationLoading.ts`, `Chat.svelte`, `DefaultChatScreen.svelte`                                       | `src/ts/process/index.svelte.ts`, durable generation state in [Generation Client](generation-client.md) |
| Draft/BTW hook controls or review state are wrong                    | `src/lib/SideBars/ChatDraftHookSelector.svelte`, `src/lib/ChatScreens/InputHookPickerDialog.svelte`, `DefaultChatScreen.svelte` | [Translation And Input Hooks](../../docs/structure/translation-and-input-hooks.md)                      |

## Chat Surface Ownership

`src/lib/ChatScreens/ChatScreen.svelte` frames the surface. It switches among
standard, waifu, and mobile-waifu display modes, applies background and text
screen styles, renders `BackgroundDom`, and opens chat/module modals.

`DefaultChatScreen.svelte` coordinates the writer's active character and chat, message
hydration, transcript window, scroll-to-message work, the composer and attached
files, suggestions and stickers, send/continue/reroll actions, generation and
hook cancellation, and chat quick menus. Active transcript rendering fans out
through `Chats.svelte`, `Chat.svelte`, and `ChatBody.svelte`. `Message.svelte`
is only an unmounted props stub and is not part of the live row-rendering path.

Plugin V3 chat panels render in `DefaultChatScreen.svelte` inside the same chat
content column. Plugin floating actions and chat-menu registrations are owned by
[Plugins And MCP](../../docs/structure/plugins-and-mcp.md#ui-surfaces).

The active-chat overflow menu also owns the BardWiki action. It lazy-loads a
focus-trapped `BardWikiWorkspace.svelte` dialog scoped to the current chat. The
workspace edits nullable chat overrides, lazily loads document bodies and
versions, keeps unsaved drafts across recoverable failures, creates/edits/
soft-deletes manual documents with version/hash fences, and exposes explicit
current-turn confirmation plus receipt/job cancel/retry state. Rebuild preview,
vault export, and dry-run/apply import remain explicit lifecycle actions with
provider-cost and destructive/replace warnings. The dialog reflows to a
single-column, list-then-detail mobile layout with a retained Back path; desktop
keeps both panes. Its zero-document state routes to create/import/build,
inherited controls name their effective values, and Activity summarizes
running/attention/failed work. The chat menu focuses its persistent button
before removing the transient menu so modal teardown restores a connected
opener. The workspace never treats queued intent as accepted. The cross-layer
contract is in [BardWiki Memory](../../docs/structure/bardwiki.md).

## Transcript Hydration And Paging

Character root resources contain message-less chat rows. Before treating an
empty transcript as a render failure, inspect
`src/ts/server/chatMessageHydration.svelte.ts`. The open chat shows a loading
state until its messages arrive and a retryable error state after failed
hydration.

`@risuai/shared-core/chat-load-pages` normalizes two durable Advanced settings:
`chatLoadInitialPages` controls the initial hydrated display tail and
`chatLoadAdditionalPages` controls each ordinary expansion. Their defaults are
30 and 15. `DefaultChatScreen.svelte` reads both helpers, resets to the
configured initial count when the chat identity changes, and adds the
configured additional count for the new-message expansion control. Message
jumps and input-hook history can request a larger bounded window instead.
Server defaults and migration normalization live in
`server/fastify/src/databaseDefaults.ts`; UI definitions live in
`src/ts/setting/advancedSettingsData.ts`.

`ScrollToMessageStore`, transcript-window identity, image-load waits, folded
message state, and route freshness all affect scroll behavior. A queued bookmark
jump expands and hydrates the necessary window only after its target route is
current. `DefaultChatScreen.loadPages.test.ts`, the shared-core load-page tests,
`src/ts/setting/advancedSettingsData.test.ts`, and
`src/ts/server/chatMessageHydration.test.ts` guard this boundary.

`Chats.svelte` separately selects DOM residency from that logical window using
`transcriptResidency.ts`. It starts with 30 working rows and reserves room for
active interactions, the latest row, a jump target, generation presentation,
focus, popup ownership and selection endpoints. Pins consume the shared budget
first, including temporary old/new generation identities: ordinary committed
DOM contains at most 76 message rows. Already-hydrated pinned rows retain their
logical range when send/streaming or a settings change reduces the page count.
Hydration, persisted messages and pending mutations keep their existing owners.
Dense custom layouts expand the working target by 15, up to 60, when at least
`workingTarget - 4` resident rows intersect the viewport. Growth is retained for
the displayed chat and resets on chat replacement, avoiding target oscillation.
The existing measurement pass supplies this count; no CSS containment or second
geometry pass is added. Pins still consume the shared 76-row budget first.

For long windows, viewport movement admits the nearest missing ordinary row
and evicts at most one old ordinary row per animation frame. Already admitted
rows keep their stable component identity while the working window fills;
rapidly passed intermediate windows do not each create 60 components. Protected
interaction/navigation rows mount immediately. Small windows, first render and
explicit full capture retain their existing admission behavior. The transcript
reports `aria-busy` while ordinary residency is filling; body parsing remains
owned by the separate display scheduler. Geometry/admission updates also reuse
unchanged keyed row-entry objects, avoiding invalidation of every mounted row.
`TranscriptResidencyEntryOwner` retains only the current ordinary entries, at
most 76, and compares row reference, key and residency ID. Changed row records
replace entries; nested reactive message fields remain observable. Eviction
forgets entries immediately, and full/legacy rendering, chat changes and
destruction clear this identity owner. It does not cache HTML or message copies. The parser also returns exactly empty
initial bodies before sanitizer setup; nonempty HTML and decoded styles retain
the existing sanitization path.

Measured reverse-flow spacers preserve omitted height; a chat-scoped cache holds
at most 2,048 fractional-pixel measurements and resets on width changes. A visible
stable message and offset anchor corrects free scrolling after row/media changes.
It chooses the first visible row by geometry and captures a changed user scroll
position synchronously before awaited updates can alter that position.
The intended fractional offset survives successive corrections so browser scroll
rounding does not accumulate across parser/image updates.
Returning rows retain their cached wrapper height while their initial bodies
wait for the display scheduler and finish parsing. All mounted bodies register
before queuing; only the newest rows participate in startup readiness. The
residency pass releases a returning row's height after its bodies settle, then
measures and corrects the viewport in the same frame. An empty remount therefore
cannot overwrite a known tall row's height and move the working window during
a pause or direction reversal. Full capture releases these temporary sizes.
First-mounted background rows use the same geometry ownership: a measured
height wins, otherwise a deterministic source-only estimate is clamped between
160 and 960 pixels. The display scheduler prioritizes visible queued rows while
remaining serial. Completed offscreen bodies wait through active wheel/touch
scrolling; after 140 milliseconds of scroll idle they commit in batches of at
most four. Initial HTML commits and held-height releases preserve the viewport
through completion, even when serialized parsing finishes after the
1,500-millisecond interaction grace. Ordinary later body updates retain the
interaction/grace policy. The transcript-owned transaction applies HTML and
placeholder release together, then restores the visible anchor before paint.
It retains the intended fractional offset of an already readable, visible row
while the scroll position is unchanged; another row becoming readable above it
does not discard that rounding residue. User movement or an unrelated layout
change requires a fresh anchor. Newly mounted pending placeholders are only
fallback anchors when no stable visible row is available. Both bounded and diagnostic legacy paging use
this application anchor owner, and the inner transcript disables native scroll
anchoring to avoid two corrections for one height transition. Chat switches,
aborts, and teardown discard held work; all uncancelled rows still render.
Existing start/end anchors still own entry and followed generation. Navigation
waits for the live chat route/component, mounts and pins its target, then releases
it after alignment; if remounted display bodies are still pending, the explicit
navigation anchor keeps that target fixed until they settle. A navigation epoch
fences stale geometry corrections.
Leaving a visible chat cancels its pending jump even when the same selected
chat is reopened. Unfolding pins the previous folded target through the logical
window change and restores its measured offset.
Keyboard and screen-reader users can activate named “Show messages” buttons in
spacers. A focused spacer keeps its range stable until activation or blur.
A row pointer press retains its logical lower bound and defers residency
geometry until pointerup/click completes. Ordinary resident wrapper heights also
stay fixed through that gesture, so a neighboring parser/image completion or
focus change cannot move a Save button between press and release. Cancellation,
blur, full capture and destruction restore those sizes and release the hold.

Native browser text-find sees mounted messages; cross-message drag selection is
limited by residency. Individual mounted-message selection/copy, per-message
copy, existing in-app navigation/search and data export remain available. Full
chat screenshots temporarily use `loadPages = Infinity` outside the ordinary
bound and restore the saved window on success, failure, hidden-route cancellation
or destruction. A quick return to the same chat cannot revive an old capture.
The local diagnostic key `risu-transcript-legacy-paging=1`, set before chat mount,
retains the previous paging path for rollback, bypassing residency height observers
and reconciliation while retaining shared display-body anchor transactions and
disabled native scroll anchoring. It does not enforce the row bound; interaction
admission and stable draft ownership still apply.

On chat entry, `Chats.svelte` waits for the newest persisted row to render and
aligns the beginning of that row with the transcript scrollport's start. A
completed initial display parse removes the loading cover, then reasserts the
owned start anchor after the DOM update in the same microtask turn. The hidden
rows have no measurable height; waiting for the resize observer's next frame
would briefly reveal the reverse scroller's natural end. This correction is
fenced by chat/message identity and leaves user-released or streaming anchors
alone. A measured trailing spacer supplies the reverse-scroll range required by a short
newest row. The viewport records a keyed `start`, `end`, or `free` anchor. While
`start` owns the viewport, `ResizeObserver`s may resize the spacer and correct
the transcript scroll in the same frame so the row's start does not move; a row
taller than the scrollport remains start-aligned with a negative reverse
`scrollTop`. A followed stream temporarily uses `end`, a zero spacer, and
`scrollTop = 0`, then returns to `start` when it settles.

User interaction releases either owned anchor to `free` before asynchronous
alignment can run. Free mode freezes the spacer exactly as rendered: reaching
`scrollTop = 0`, row growth, parser/media settlement, and scrollport resize do
not expand or shrink it. Geometry events likewise cannot change anchor modes;
only chat entry, generation start/settlement, and the explicit new-message
action do so. Empty chats retain their ordinary greeting/composer layout.

### Connected Reader Transcript

`Workspace.svelte` lazy-loads `ReaderTranscript.svelte` for an explicit local
character/chat route only when `canUseClientReaderContent()` admits content.
An automatic writer candidate does not mount this surface before recovery.
Established readers and previous writers retain content admission through
promotion and interrupted recovery.
`ReaderTranscript.svelte` also guards its own reads and rendering, including
manual Refresh, so a direct mount cannot bypass this boundary.

`ChatScreenLayout.svelte` owns the shared theme/background/portrait frame;
writer `ChatScreen` supplies its controllers while `ReaderTranscript` supplies
its independent read owners and static confirmed portraits. The pure
`ReadOnlyComposer.svelte` creates no draft, imports no writer controller, and
renders disabled message, attachment, send, menu, translation, draft, BTW,
sticker, and reroll semantics. The separate top-right device action owns
promotion. Mobilechat bubbles expose the same
reader-safe plain-text copy action as the other built-in layouts.
`readerPanelAppearance.ts` derives a local text palette from confirmed app colors
and the translucent chat panel, and passes its tone through the explicit read
owners. This keeps links, disclosures, headings and composer guidance readable
across light bubbles and portrait themes; readable custom text colors remain
applicable without changing the writer palette.

The reader supplies `Chats.svelte` with certified messages
from `readerTranscriptProjection.svelte.ts` through its own chat-read owners.
Its character, greeting, persona, and transcript do not borrow pending writer
edits or persisted writer selection. A failed/sparse refresh can retain the
last usable same-route snapshot; authentication, lineage, deletion/recreation,
and chat incarnation fence both retained content and late reads.

`readerDisplayResources.ts` loads display dependencies without starting writer
plugins or generation recovery. The reader keeps shared sanitized Markdown,
asset display, stored translation, native selection, and plain-text copy.
Unsupported display processing reports limited-display status with readable
source. Its composer is disabled, and mutation, translation-start, generation
control, and effect actions remain unavailable. Read-owner settings also carry
confirmed passive formatting/asset metadata and module activation links. Only
module assets, backgrounds and icon visibility are certified; scripts and prompts
are excluded. Compact receipts trigger fresh display reads. Chat/Chats/ChatBody never borrow a
writer settings, module or selected-owner fallback for that context.
`ReaderChatBackground.svelte` parses explicit reader character/chat backgrounds
with `readOnly` and session/source fences. `readerPassiveHtml.ts` disables
script controls with a localized reason and denies capture/delegated activation;
static links and native details/summary remain usable. Neither local-only
interactive scripts nor plugin/custom-GUI panels are available to readers.

`readerGeneration` is an explicit optional presentation input to `Chats.svelte`:
`undefined` retains the writer path, while `null` means an idle reader. The
reader path ignores writer regenerate, half-streaming, and finalization stores,
even when no reader projection exists. Live text never enters canonical
messages, retained read snapshots, or pending-mutation intent.

Send and append-mode Continue use a synthetic assistant row with a stable
operation/attempt key. Extend-mode Continue displays the immutable base plus
observed text on the exact target; regenerate replaces that target's visible
text while retaining its presentation key. Exact canonical result identity can
adopt the row before the stream terminal arrives without showing a duplicate.
An existing Continue target id alone cannot complete the handoff. The reader
observation controller owns terminal hydration and projection release, including target/result suffix
reads outside the ordinary tail window.

Reader projections parse promptly through the same read-only `ChatBody` path,
retain copy for nonempty partial text, and pin generation rows in the existing
bounded residency layer. The existing user-controlled scroll anchors remain
in charge. Half-streaming shows reader token counts while withholding text;
interruption keeps partial content readable, removes the busy indicator, and
shows localized viewer status even when no transient row exists. Refresh
retries the read-only viewer and transcript. Selection, incarnation, session,
and teardown stop the old viewer; visibility/offline handling belongs to the
reader generation observation service. Transport and authority contracts are in
[Generation Client](generation-client.md#connected-reader-observation).

## Message Rendering

### Row Ownership And Parse Dependencies

`Chat.svelte` owns each persisted row's controls and display state.
Its optional `transcriptInteraction.ts` context reserves a row before creating
an editor, confirmation or asynchronous action that must survive display
eviction. `transcriptReservations.ts` admits at most eight distinct message
rows; overlapping work on one row shares its slot. When full, a new manual
operation leaves existing drafts untouched and reports localized feedback;
automatic translation retries on availability without consuming its eligibility.
Partial editors use the same reservation lifetime, including save/confirmation
work. Non-transcript `Chat` uses retain their existing unrestricted behavior.
`transcriptMessageView.ts` retains only two translation-display flags across
eviction, with 2,048 entries and 2,048-character keys; chat reset fences late
writes. It never stores message bodies or editor drafts. Preferences outside
that finite cache return to their ordinary defaults when remounted.
Its module shares the character/chat and active-message identity indexes from
`chatReadOwners.svelte.ts` across mounted rows. Svelte tracks array structure and
stable IDs so hydration, optimistic structural edits, rollback, and selection
invalidate the relevant reads; unrelated message bodies and settings do not
rebuild those indexes. Mutation handlers retain their separate live ownership
and asynchronous freshness checks.
Inline and popup message drafts have their own state, independent of display
props. Stable row keys keep their editors mounted when an unrelated earlier row
is removed; full/partial saves still require the captured IDs and unchanged
source (and translation where applicable). Missing-ID callers retain strict
index checks.
`ChatBody.svelte` renders parsed content, while `ChatBodyParseMemo.ts` owns
parser/LLM-detection memoization and dependency signatures for character, chat,
modules, settings, CBS state, and reload epochs. Stale HTML or unexpectedly
expensive rerenders often start at that memo boundary.
Reload epochs and nearby transcript length are explicit `ChatBody` parse inputs;
only chat/message identity changes replace the body component. Its HTML stays
mounted while a replacement parse runs, and superseded results cannot replace
the current display.
`Chats.svelte` keeps its compact display-character projection separate from
the row list, so unrelated row-list updates retain the parser input identity.
Each `ChatBody` also retains its last two finalized HTML results, bounded to
1 MiB of input/output strings per mounted body. Content, model metadata, image
hiding policy and watermark applicability are part of that cache key; a miss
still sanitizes markup, including a second pass after decoded styles, before
pruning bilingual pairs and adding metadata. Unmounting releases this cache.

The newest three messages own initial display readiness. With the server display
protocol, `chatDisplayScheduler.ts` starts a bounded group of mounted rows'
input preparation together, before initial/background startup readiness. The
bridge holds compatible post-asset inputs together for at most one frame (16 ms),
then sends priority and background targets in the same request. Slow optional
browser work can join a later batch instead of delaying the priority rows.
The server streams the newest three first; the loading cover waits for their
browser body commits and Svelte render tick. Empty and shorter chats wait only
for available rows. Viewport admission ranks new work by proximity and promotes
the nearest three queued rows. Arrivals during an active stream collect into the
next bounded request. DOM residency, configured paging, and anchored commit
transactions remain separate from network admission; existing content stays
visible during history loading. Browser-only/plugin fallback still uses serial
idle parsing. Input changes, chat switches, and unmount cancel obsolete work.
Module-dependent signatures use a compact client render revision plus active
module ids; they never embed module assets, regex definitions, or triggers in a
per-message key. Parse and LLM-detection memo keys are bounded by both entry
count and approximate retained bytes. Transcript rows and parser readers share
`sharedChatReadOwners.svelte.ts`, so cache-key construction uses the same indexed
character/chat ownership as rendering. Module display reads share a narrow
reactive activation projection instead of rebuilding generation readiness for
each row. Translation-detection keys are constructed only for automatic
cached-only LLM translation; matching display parses reuse the prebuilt key.

### Asset Indexing

The additional-asset parser builds indexes only when an asset marker needs one.
`assetCollectionIndex.ts` shares in-flight and completed module indexes across
character contexts and yields between bounded chunks of construction. A module
revision change during a yield discards the partial index and joins a current
build; structurally versioned character tuples are captured before yielding.
Per-collection indexes retain all extensions so merging preserves character-first
and module-order precedence, including deterministic same-extension variants.

### Intermediate Display And Cold Hydration

Before mounting an open chat's transcript or greeting, `DefaultChatScreen`
waits for `runtime:chat-display` resources and plugin initialization. This
surface owns persona, effective-module, and parser/display settings; it does
not wait for generation recovery, provider/model readiness, or background work.
Plugin readiness includes the guest's awaited top-level initialization, with
guest errors, teardown, and a 30-second initialization timeout surfaced through
the existing plugin failure/retry state.
`chatDisplayReadiness.ts` reads the same manifest that the route loader uses.
Failures expose a transcript-local Retry action. The gate releases once per
chat entry (or authoritative transcript re-stub), so subsequent resource or
plugin reloads keep the existing transcript visible. Composer and sidebar stay
mounted throughout this initial gate.

Supported `ChatBody` parses negotiate server-owned intermediate display
processing without moving HTML rendering. `Chat.svelte` supplies the stable
message id and original/translation/bilingual layer; `ChatBody.svelte` carries
those through the existing parse memo; and `ParseMarkdown()` sends the
post-first-asset source through the same-chat batch bridge. Pending parses keep
the last successful body. On a cold transcript mount, `Chats.svelte` keeps the
message-shaped chat-window skeleton visible until the newest three rows' first
display parses settle; later reparses continue showing their last successful
bodies.
An empty hydration shell starts that cold-display cycle only if persisted rows
arrive. Once hydration confirms that the chat is empty, its display is ready and
the first subsequently sent message does not reopen the skeleton. An authoritative
re-stub or resync can start a new cycle.
The skeleton stays within the transcript, leaving the composer and app-owned
responsive sidebar available while the chat finishes rendering.
With writer access, plugin hooks and unsupported surfaces retain the former
all-client path. Readers instead keep readable source and limited-display
feedback without general script/plugin fallback or new provider work. Raw
message and stored translation sources remain unchanged.

### Finalization Indicators And Render Isolation

`Chats.svelte` matches writer-scoped generation-finalization state by stable chat,
message, and generation ids. `Chat.svelte` renders queued, transiently stalled,
terminal, and quarantined legacy indicators on that exact row; committed rows
whose journal cleanup remains pending are not described as provisional.
`DefaultChatScreen.svelte` likewise matches Stop controls to the exact active
operation or job. A settled control retained from an older send cannot hide Stop
for a newer live continue or regenerate job.

The visible `Chats.svelte` row model subscribes only to the current chat's
finalization projection and the nested resource fields it renders. The flat
bootstrap/recovery finalization list is not a UI dependency. Background-chat
completion must leave the foreground row-model build counter, parser calls, and
geometry effects unchanged; `renderCostHarness.test.ts` guards both
terminal-before-event and event-before-terminal orderings.

### Parser DOM Integration

Message HTML crosses parser output, translation, custom HTML templates, inlays,
additional/module assets, and optional partial edit. Parser code lives under
`src/ts/parser/`, while file and inlay processing lives under
`src/ts/process/files/`. `src/ts/parser/parser.svelte.ts` emits `x-hl-lang` and
`risu-ctrl="bgm___..."` markers. `src/ts/observer.svelte.ts` turns highlighted
code into copy/download context targets, starts BGM, retries blocked autoplay on
the next user activation, and stops playback on chat change.
`src/ts/observer.svelte.test.ts` guards that DOM contract. Runtime parser
ownership remains in the
[client TypeScript map](client-runtime.md#client-typescript-areas).

### Translation Layers And Greeting Ownership

Persisted generated-message translations are server-raw. The terminal
generation frame can carry the final automatic translation result, and
`src/ts/process/serverGeneratedMessageTranslation.ts` mirrors success or joins
the existing job UI for running/failure states. `Chats.svelte` grants one-shot
client eligibility only to other appended rows under the chat's automatic
translation policy. `Chat.svelte` renders bilingual display through
`x-risu-bilingual-translation` blocks. When automatic translation is enabled,
an existing persisted translation is displayed for either role; the bot-only
setting prevents new user-message translation requests without hiding stored
user-message translation data.

`src/lib/SideBars/ChatTranslationSettings.svelte` also owns the active chat's
LLM translator preset selector. “Use Global Settings” leaves
`chat.translatorPresetId` absent; a named option persists the preset's stable
string id through the guarded chat-metadata command and reports
accepted/queued/failed state like the adjacent translation toggles. Missing
references are displayed as unavailable and execute with the global fallback;
normal preset deletion and import normalization clear them durably.

`src/lib/ChatScreens/ChatBody.svelte` retains the legacy client-only HTML
translation path for synthetic greetings and non-persisted preview rows that
have no server-raw target. Eligibility follows the active chat's
automatic-translation and bot-only policy; persisted transcript rows do not use
this fallback.

The synthetic greeting row (`idx === -1`) uses the separate manual projection
in `src/ts/server/greetingTranslations.svelte.ts`.
`src/lib/ChatScreens/Chat.svelte` renders that projection and
`src/lib/ChatScreens/DefaultChatScreen.svelte` supplies its target and state.
The projection, detached job identity, and server read/command request all carry
the owning chat id so different preset bindings on chats for the same character
cannot leak into one another. Persisted greeting projections do not become
automatic merely because chat auto-translation is enabled.

### Partial Editing

Partial block/text editing belongs to `PartialEditController.svelte`. Its
match-selection, delete-confirmation, and failure dialogs share the modal focus
and backdrop actions; stale target guards prevent a result from applying after
the active message changes.

Partial edits route to the text layer the touched block renders from
("edit what you see"): the original message, the persisted raw translation in
translated view, or either side of a bilingual pair
(`src/lib/ChatScreens/partialEditLayer.ts` resolves the layer; bilingual pair
wrappers and cross-side drag selections are rejected). Translation-layer saves
persist through the same message-translation patch as the manual translation
editor, and a result that trims to nothing removes the translation.
Original-layer partial saves deliberately keep the persisted translation
(unlike whole-message edit mode, which still nulls raw translations), so a
line fix under translated or bilingual display never drops the translation.
Freshness guards compare against the corresponding live layer text.

On touch devices, a long-press on a block
(`src/lib/ChatScreens/partialEditTouchTrigger.ts`, gated by the same
block-partial-edit setting) reveals the hover edit/delete buttons, swallows
the synthetic click that follows release, and suppresses native long-press
text selection inside the message body while the gesture is active. Outside
taps dismiss the buttons via a macrotask-attached listener.

## Composer Layout Modes And Mobile Viewport

### Draft And Placement Ownership

The composer owns five reload-recoverable fields: message, translated message,
attached files, reviewed Draft output, and BTW output.
`DefaultChatScreen.composerDrafts.ts` retains them per transcript in bounded,
lineage/writer-scoped `sessionStorage`. Only an accepted save for the exact
draft generation clears recovery. Writer demotion also captures mounted fields
through `writerDraftRecovery.ts`; the reader's disabled composer does not submit
or replace those saved copies. The complete storage contract is in
[Client Runtime](client-runtime.md#draft-recovery-stores).

One Svelte snippet owns the composer row, draft-persistence and generation
recovery banners, Draft/BTW output, translation, attachments, stickers,
suggestions, and generation controls. `fixedChatTextarea` chooses where that
surface renders. A true value renders the snippet in the persistent dock outside
the reverse transcript scroller. A false or missing value renders it as the
first child of that scroller, which places it at the content bottom in normal
flow. With `floatingChatInput` enabled (the default), scrolling far enough toward
older messages reveals a pencil button in the bottom-right. Activating the
button temporarily restyles that same mounted surface as a fixed floating card;
returning to the bottom restores flow, and explicitly hiding the card returns
to the pencil button. The fixed dock always gates floating presentation off.
Switching fixed/in-flow modes may remount the
snippet, but its transcript-scoped state remains owned by
`DefaultChatScreen.svelte` and its recovery store.

The dock is a nonshrinking sibling of the transcript and caps unusually tall
composer content with its own scroll area. It has no independent background
fill: the chat column's text-screen overlay tints the transcript and composer
uniformly. Accessibility exposes both the baseline `fixedChatTextarea` placement
and the default-on `floatingChatInput` companion for in-flow mode.

### Width And Containing Blocks

`DefaultChatScreen.svelte` measures the rendered content column with
`ResizeObserver`. The transcript, active composer surface, and overflow menu
share that width across `chatScreenWidth`, viewport changes, and safe-area
insets. In-flow menus are positioned inside the transcript containing block;
dock-mode menus retain the column-root containing block. Floating cards and
menus use `--chat-content-fixed-inline-end`; its measurement accounts for custom
`backdrop-filter`, which makes the chat root the containing block for fixed
descendants. Normal and translated textareas clamp to a 44-pixel minimum, while
the floating textarea is capped at `min(40dvh, 18rem)`.

### Keyboard Viewport Coordination

While a text editor is focused, `visualViewportCoordinator.ts` publishes only
the visual viewport height to the app shell. The shell stays at page origin and
is never translated from `pageTop` or `offsetTop`. The dock therefore lands at
the bottom of the keyboard-reduced shell. In-flow mode relies on the reverse
transcript scroller staying at `scrollTop = 0` while its height contracts, so a
focused composer at the content bottom also remains above the keyboard. If the
user then scrolls toward history while the keyboard is open and floating input
is enabled, the bottom-right pencil appears; activating it turns the same
composer into a floating card. Window-fixed cards add the difference between
the layout viewport and
`--risu-visual-viewport-height` to their bottom inset; the custom
`backdrop-filter` containing-block case is already shell-relative and does not
add that offset. The card and pencil button therefore stay inside the
keyboard-reduced shell. After a focused viewport settles more than 100 pixels
below the full window height, the coordinator caches that height in device-local
storage under an orientation-specific portrait or landscape key. On a later
focus with no current adjustment, a sane cached height is applied synchronously
before the keyboard reveal and the document scroll guard is notified through
the normal apply path. This pre-lift usually places the composer inside the
future keyboard viewport before WebKit needs to pan it.

Initial focus and every viewport geometry event also restart a 275-millisecond
stability latch. A cache-miss session stays unclamped while geometry is moving;
a pre-lifted session keeps its cached clamp active and uses motion only to
restart the timer. The settled measurement then reconciles any cache drift and
updates the cache when it still represents a real keyboard-sized reduction. A
stale pre-lift used with a hardware keyboard is restored to the measured full
height at this checkpoint. The coordinator then invokes the document scroll
guard to pin root scroll to zero. A 700-millisecond trailing validation catches
late iOS drift. Focusout continues to hold the last applied height for 700
milliseconds before release, while keyboard-close events use the same stability
debounce.

`index.html` requests `interactive-widget=resizes-content`, allowing supporting
Android browsers to reduce the layout viewport directly; iOS ignores the key
and uses the same height-only coordinator. To observe real-device pan channels,
enable the passive viewport overlay with `?risuViewportDebug=1` or the
`risu-viewport-debug=1` local-storage flag. It never changes viewport state.

## Generation And Loading States

### Message Generation Phases

`src/ts/process/generationActivity.svelte.ts` advances each chat through typed,
monotonic display phases: starting, preparing context, checking memory, waiting
for the first model token, generating, and finalizing. The numeric process stage
remains as a compatibility projection. `chatGenerationLoading.ts` maps the typed
phase to localized labels; the UI uses an indeterminate phase-colored track
instead of presenting fabricated percentage completion.

Before an ordinary send is admitted, the composer's stable primary-control node
changes from Send to a compact, `aria-disabled` spinner while retaining its
width and focus. Once its chat-keyed generation activity exists,
`Chats.svelte` projects a non-persisted assistant row immediately. The row keeps
one operation-and-attempt presentation key while the stream-owned assistant
`Message` is appended, then adopts that message without remounting. A matching
durable-job projection bridges foreground observer replacement, retaining the
row, loader, latest phase, and start time while the local activity is handed
off. The first observable provider text
advances the activity to generating; `Chat.svelte` renders the growing response
and a compact status footer together until finalization settles. Empty failed or
cancelled attempts therefore lose only the transient row, while retained partial
and durable persistence behavior continues to belong to the existing generation
reconciliation paths.

The composer cancel button mirrors the phase colors. Message-generation phase
and cancellation state come from the open chat's entry in
`generationActivity.svelte.ts`, so another chat can generate concurrently
without replacing the visible state of this one.

Both the placeholder loading row and the half-streaming row use `w-full`, so
they fill the message content width instead of stopping at the former fixed
34-rem cap. The surrounding transcript/content column still enforces the user's
configured chat width.

### Input-Hook Activity

Draft and BTW hook execution registers a chat-keyed activity in
`src/ts/process/inputHookActivity.svelte.ts`. Each entry owns stage `5`, its
abort controller, hook kind, and composer-operation token/version; different
chats may run concurrently while one chat remains single-flight. The composer
spinner is amber (`#f59e0b`), and ID-scoped cleanup prevents
one hook from clearing another chat's state. Stage mapping is covered by
`chatGenerationLoading.test.ts`, the registry by `inputHookActivity.test.ts`,
and the DOM behavior by `DefaultChatScreen.loadPages.test.ts`.

### Progress And Recovery Controls

`AgentPresetProgress.svelte` and `PostGenerationScriptProgress.svelte` mount
above the transcript in the shared content column. Their visible snapshots are
chat-scoped. Agent execution and completeness belong to
[Agents And Presets](../../docs/structure/agents-and-presets.md), while durable
send, cancellation, and reattach belong to [Generation Client](generation-client.md).
Visible generation starts in `DefaultChatScreen.svelte`, while durable send and
reattach live under `src/ts/process/`.
When the outer reattach budget is exhausted, the composer replaces its healthy
pulse with a warning and renders a separate accessible alert. Its Retry,
Refresh, and Stop controls pass the failed job ID rather than selecting work by
chat, and the accepted-send recovery alert remains an independent state
machine. An accepted-send operation abandoned by a server restart also exposes
a Dismiss action. Dismissal durably cancels that exact operation, so a later
bootstrap cannot recreate an impossible retry notice.

### Targeted Regenerate Presentation

`src/ts/process/rerollNavigation.svelte.ts` owns reroll operation fencing and
keeps the selected assistant authoritative while its targeted regenerate is
admitted. Server assembly removes that row only from the working prompt, and
generation finalization atomically replaces it while retaining reroll
alternates. A failed regenerate therefore needs no browser transcript rollback.

Negotiated fresh regenerate streams join
`generationDisplayProjection.svelte.ts` to that authoritative target in
`Chats.svelte`. `Chat.svelte` receives projected display text separately from
the persisted row. From generation activity start until replacement text is
available, the target renders the standard message-generation status instead
of the retained response; streamed text then appears in place beside the same
status. Message controls and metadata actions such as retranslate remain
unavailable throughout the operation, while raw edit/copy/TTS/translation
authority stays untouched. A mount-local
presentation alias maps the terminal generation id back to the target's keyed
wrapper, so the same row survives the authoritative ID replacement.

Regenerate follow-bottom is operation-aware rather than message-count based.
If the transcript was following latest (or the always-follow preference is
enabled), projection admission enters the reverse scroller's natural end,
and reasserts `scrollTop = 0` through streamed resize and ID handoff. Wheel,
touch, pointer/scrollbar, or scrolling-key intent followed by a move away
cancels follow; geometry-only scroll events are corrected without being mistaken
for history navigation. Settlement aligns the completed row's beginning with
the scrollport start, while a cancelled follow preserves the user's history
position and frozen spacer.

### Suggestion Completion

Settling a chat-keyed message generation records a bounded, consume-once marker
in `src/ts/process/chatSuggestionCompletion.svelte.ts`. `Suggestion.svelte`
consumes only the open chat's marker: persisted suggestions satisfy it without
a request, resident empty chats request once, and empty shells retain it until
their transcript hydrates. Request ownership is also chat-keyed, so duplicate
mounted consumers cannot start the same automatic suggestion request.

## Input-Hook Chat Controls

`src/lib/SideBars/ChatDraftHookSelector.svelte` selects a chat-scoped Draft
hook. `src/lib/ChatScreens/InputHookPickerDialog.svelte` selects an ad hoc BTW
hook whose result can be retained or dismissed independently of the message.
Draft review, Translation mode presentation, floating conversion, and the
amber running state are chat UI responsibilities. Execution starts in
`src/ts/process/inputHooks.ts`. Supported prompt slots are `{{slot::content}}`,
`{{slot::draft}}`, `{{slot::history::N}}`, and
`{{slot::historytrans::N}}`, where `N` is bounded to 1–50.

A Draft hook's optional Translation mode preserves the review step. Sending
uses the reviewed result as the user message and stores the original composer
text in its source-bound translation field. History requests expand the
resident transcript tail only as far as required and share the translator
history boundary: disabled/comment rows, the greeting fallback, persisted
translations, chronological ordering, and the common token budget. Hook model
resolution and the complete slot, history, translation, and execution contract
belong to
[Translation And Input Hooks](../../docs/structure/translation-and-input-hooks.md).

## In-Chat Confirmations

Message removal in `Chat.svelte` captures a stable character/chat/message
target before awaiting. Depending on `askRemoval`, `instantRemove`, and modifier
state, the UI can confirm removal and then choose between deleting only the row
or truncating the transcript at that row. Strict hydration supplies a missing
preceding message ID before a server-backed truncation. Partial edits have their
own preview and delete confirmation in `PartialEditController.svelte`.

The server-backed send path also handles the non-Hypa context-truncation
warning. Despite the historical field name, Fastify asks only when prompt
assembly truncated history, combined Hypa V3/Supa memory is not active, and the
chat has not acknowledged the warning. A generation request can return the 409
protocol code
`hypa_context_truncation_confirmation_required`. The UI asks with
`language.hypaContextTruncationConfirm`; acceptance durably patches that chat's
`hypaContextTruncationAcknowledged` field, waits for actual acceptance, verifies
that the same chat still owns the operation, and retries generation once.
Decline, acknowledgement failure, abort, or chat change does not retry. The
field is allowed by both `src/ts/chatCommands.ts` and
`server/fastify/src/commands/chats.ts`; behavior is covered in
`src/ts/process/__tests__/sendChat.serverPreview.test.ts`.

## Advanced Tools Token Estimates

The Tokens accordion mounts `src/lib/SideBars/DevToolChatTokens.svelte` only
while open. Current Chat waits for complete, strict transcript hydration and
counts stored message bodies, including history outside the display window.
Current Chat (Visible) parses every stored row in bounded batches through the
normal CBS/editdisplay/Markdown pipeline, then extracts static readable text
with `src/ts/parser/staticVisibleText.ts`. Closed details contribute only their
summary. Hidden elements, styles, scripts, and embedded documents contribute no
text. Unconditional embedded CSS and inline visibility declarations are applied;
media/container queries, viewport geometry, and interactive UI state are not
simulated. Saved raw translations follow the chat's automatic/bilingual display
settings without requesting translations. Both chat totals exclude the separate
character greeting and app-owned controls.

Character Dynamic (All) retains the character lore total. Character Dynamic
(Active), Module Dynamic (Active), and Chat Lore (Active) share one server
activation evaluation, with original source categories retained independently of
entry names. `/api/v1/chats/:chatId/lore-token-counts` reads selected effective
generation configuration and complete history, evaluates an isolated working
chat, and never persists sticky activation flags. Final lore-to-lore injected
text is recounted in the receiving entry's category. Applicable probability
entries trigger a warning even if the random draw excluded them. These values
remain estimates, rather than the exact final provider request budget.

Edits, relevant state changes, explicit Recalculate, and reopening the accordion
refresh its counts; closing or changing targets cancels/discards obsolete work.
Failed hydration cannot present a partial transcript count as a complete total.

## Focused Tests

Start with `src/lib/ChatScreens/DefaultChatScreen.loadPages.test.ts`,
`src/lib/ChatScreens/ChatBody.svelte.test.ts`,
`src/lib/ChatScreens/ChatBody.parseMemo.test.ts`,
`src/lib/ChatScreens/Chat.parserDependencies.test.ts`,
`src/lib/ChatScreens/BackgroundDom.parserDependencies.test.ts`,
`src/lib/ChatScreens/Chat.customHtml.test.ts`,
`src/lib/ChatScreens/PartialEditController.sharedHover.test.ts`,
`src/lib/ChatScreens/partialEditFreshness.test.ts`,
`src/lib/ChatScreens/partialEditLayer.test.ts`,
`src/lib/ChatScreens/partialEditTouchTrigger.test.ts`,
`src/lib/ChatScreens/chatButtonTriggerFreshness.test.ts`,
`src/lib/ChatScreens/Suggestion.svelte.test.ts`, and
`src/lib/ChatScreens/newMessageTranslationEligibility.test.ts`.

Translation, input-hook, and observer guards include
`src/ts/translator/bilingualInterleave.test.ts`,
`src/ts/translator/bilingualInterleave.dom.test.ts`,
`src/ts/process/inputHooks.test.ts`,
`src/ts/process/serverGeneratedMessageTranslation.test.ts`, and
`src/ts/observer.svelte.test.ts`. The visible-state policy is canonical in
[Testing And Operations](../../docs/structure/testing-and-operations.md#visible-state-test-contract).
