# Phase 5 — Guided BardWiki Workspace

Depends on accepted [Phase 1](phase-1-effective-state-and-validation.md) and [Phase 4](phase-4-outcome-language-and-authoring.md). Read the [plan](../PLAN.md) and [status](../status.md).

## Outcome

BardWiki opens on a clear next step, shows effective configuration, uses outcome-first lifecycle language, and remains usable as list-then-detail on mobile.

## Bounded Slices

1. Replace the zero-document list/detail split with one guided empty state. Provide **Create first document** as primary and **Import vault** plus **Build from chat** as secondary actions that open the existing safe flows.
2. Present every inherited override as **Inherit — currently value** using `chatResource.effectiveSettings`. Group controls in a two- or three-column responsive grid with short labels and supporting copy; use one column at compact width.
3. On mobile, show either document list or document detail, never a squeezed simultaneous split. Add a named Back to documents action, preserve selection/drafts through the switch, and keep desktop split-view behavior.
4. Rename lifecycle controls around outcomes: **Rebuild from chat**, **Fill missing topics**, **Start fresh from chat**, and **Import vault**. Keep hashes, derived/user-authored distinctions, and conflict strategy in Technical details. Preserve preview, target fences, explicit confirmation/apply, progress, and result states.
5. Add running, pending-attention, and failed counts to the Activity summary. Auto-open on actionable failure/attention, keep the user's disclosure choice otherwise, and ensure Retry/Cancel/result updates have one polite or urgent announcement owner.
6. Strengthen the BardWiki scrim and modal visual isolation while retaining the existing `data-modal-root`, focus trap, inert background, scroll lock, backdrop safety, Escape handling, nested dialog behavior, and focus restoration.
7. Raise only proven weak muted/border/focus tokens. Avoid surface-local arbitrary colors and verify built-in and custom-theme behavior before changing a shared token.

## Acceptance

- Zero documents yields one coherent workflow and every CTA reaches its existing safe create/import/rebuild stage.
- Inherited labels always match the server-provided effective settings and do not become persisted overrides.
- Mobile list/detail navigation retains unsaved document/settings/import drafts and restores logical focus.
- Import and rebuild still require preview and fenced confirmation; renamed controls do not bypass safety stages.
- Activity counts, auto-expansion, Retry/Cancel, and terminal results are keyboard accessible and announced once.
- Only the workspace close action remains visually prominent; the background is both visually subdued and programmatically inert.

Use focused tests for `src/lib/ChatScreens/BardWikiWorkspace.svelte`, `src/ts/server/bardWikiResource.ts`, `src/ts/server/bardWikiCommands.ts`, protocol BardWiki schemas, and server BardWiki settings/routes only where their existing contracts are touched. Exercise empty, inherited, lifecycle, job, conflict, focus, and responsive cases in the browser journey.
