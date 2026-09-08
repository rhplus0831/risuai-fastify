# Phase 3 — Shared Transcript and Passive Display

Depends on accepted [Phase 2](phase-2-shared-shell-and-navigation.md). Read the
[plan](../PLAN.md) and [status](../status.md). Owners: UI-3, DATA-1, LIFE-1.

## Outcome

The familiar chat appearance works around the reader transcript controller,
without writer composer/plugin startup or interactive script execution.

## Bounded Slices

1. Extract chat layout/chrome needed for shared appearance. Keep `ReaderTranscript`
   as the initial reader controller, with its explicit owners and shared `Chats`
   and `Chat` rendering. Add the read-only composer surface and takeover action.
   Gate reader display on read resources rather than writer plugin readiness.
2. Connect audited theme, font, avatar, background, and passive-display inputs.
   Preserve greetings, lazy history, copy, safe links/disclosures, and scroll
   behavior. Retain isolated server display transforms and readable fallback;
   unsupported executable display content must not invoke general browser scripts.
3. Audit script-button delegation, Lua/button callbacks, plugin/custom-GUI actions,
   custom HTML, and background handlers. Disable interactive controls and deny
   invocation even when their only effect is local. Guard message edit, generation,
   and other mutation entries introduced by the shared chrome. Preserve the reader
   live-generation projection and final-message reconciliation.

## Acceptance

- The transcript renders without writer plugins or composer recovery and uses
  confirmed data for both messages and visual metadata.
- Readers can copy, scroll, load history, view passive formatting/assets, and
  observe live replies with no duplicate final message or cancellation of writer work.
- Custom markup and script controls cannot execute through click, keyboard,
  delegated/programmatic callback, stale parse completion, or restored UI.
- The read-only composer creates no draft or send path. Writer composition,
  rendering, and authorized script behavior retain their existing contracts.
- Desktop/mobile themes, focus, and transcript layout are usable; any passive
  display limitation has an explicit readable fallback recorded in status.

Use reader transcript, chat ownership/custom-HTML, button freshness, display
resource, and generation suites, plus a focused browser rendering/stream journey.
Verify callback denial directly instead of treating a disabled button as proof.
