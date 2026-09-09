# Phase 4: Transcript and Composer Containment

## Outcome

Use the normal chat/transcript/composer visual language for readers while
retaining reader-owned data and making every authoring, execution, draft, and
generation entry point unavailable.

## Preconditions

- Phase 3's unified workspace/navigation path is accepted.
- Reader route/display ownership is stable by character/chat ID.
- Existing passive reader transcript, display-resource, generation-observation,
  and read-only message tests are green.

## Work

1. Identify and extract the smallest shared chat layout, transcript chrome, and
   composer presentation boundaries from the normal chat surface. Keep writer
   `DefaultChatScreen` control/state ownership separate from reader control.
2. Adapt the reader transcript controller to the shared presentation through its
   explicit `ChatReadOwners` context, committed character/chat/message owners,
   passive display resources, and live generation observation.
3. Continue passing explicit read-only state through `Chats`, `Chat`, and
   `ChatBody`. Audit message actions, custom HTML, links/disclosures, translations,
   TTS/media, script/Lua buttons, rerolls, partial editing, popup editors, and
   late callbacks.
4. Create a shared composer view contract. The writer adapter supplies its
   existing draft, attachment, input-hook, translation, menu, send, cancellation,
   and generation state. The reader adapter supplies disabled values and no
   writer callbacks.
5. In read-only mode disable or omit the main/translated/Draft/BTW fields,
   send/continue, hamburger menu, attachments, stickers, suggestions, Draft/BTW
   actions, reroll, generation start/stop/retry, and authoring dialogs. Preserve
   an accessible read-only explanation without adding a second takeover button.
6. Ensure a never-writer reader does not read/write composer-draft storage,
   register writer draft capture, start input-hook/plugin/script runtimes, claim
   generation effects, or mount plugin chat panels.
7. Preserve synchronous writer draft capture during demotion. After capture,
   disable the visible writer controller before any subscriber or delayed
   continuation can mutate. Do not project retained draft text to the reader.
8. Preserve safe reader interactions: scroll, text selection, copy, history
   paging, ordinary safe links/disclosures, read refresh, display fallbacks, and
   live generation observation.
9. Keep writer behavior, composer draft restoration, queued/accepted/failed
   outcomes, generation cancellation, responsive/floating composer layout, and
   viewport coordination unchanged when writer capabilities are present.

## Acceptance

- Reader and writer chat routes use the same normal visual frame and transcript
  presentation while consuming separate explicit data/control owners.
- Every listed reader composer field/control is programmatically unavailable and
  has appropriate disabled/read-only semantics; no keyboard or delegated event
  bypass exists.
- Reader message rendering cannot edit, delete, reroll, translate-write,
  execute scripts/plugins, start/stop generation, or invoke writer-only media
  operations.
- A never-writer reader creates no composer draft, writer capture registration,
  command, outbox row, plugin panel, input-hook activity, or generation effect.
- Demotion captures a writer draft before disablement and stale continuations
  remain denied across a later promotion.
- Reader passive display, copy, paging, refresh, scroll, and live generation
  observation remain usable and do not cancel or mutate the writer's operation.
- Normal writer composer, message, draft, generation, responsive, and viewport
  behavior remains green.

## Focused Verification

Run affected ReaderTranscript, DefaultChatScreen, composer-draft, writer-draft,
Chats, Chat, ChatBody, passive-HTML/parser, partial-edit, translation/TTS/script,
input-hook, generation observation, and App mounted tests. Run the reader chat
and writer-switch browser journeys needed to prove real disabled DOM, readable
streaming, draft containment, and normal writer restoration. Record exact
commands and outcomes in `status.md`.

## Handoff

Phase 5 begins only when the unified reader workspace has complete presentation
and action containment. Do not treat hidden buttons or a passing command guard as
sufficient if a mounted reader control still appears actionable or accepts
focus/input contrary to the product contract.
