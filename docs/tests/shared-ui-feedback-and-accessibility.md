# Shared UI, Feedback, and Accessibility

Last audited: 2026-08-29.
Targeted source check: 2026-09-10 (interaction contrast, modal isolation, reduced motion, and reflow).

This area covers alert and dialog queues, modal focus/inert behavior, shared form controls, popup editors, localization contracts, color/motion/layout runtime helpers, DOM enhancement observers, onboarding, and global browser chrome. The primary inventory is supplemented by cross-cutting sanitizer and stack-map coverage plus the blocking-alert Playwright journey. Login origin and browser-surface policy also relate to [API Security, Runtime, and Network Boundaries](api-security-and-runtime.md).

## Alert service queueing and rendered dialogs

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/ts/alert.test.ts`: FIFO concurrent confirmations; normal/plugin sharing; programmatic close cancellation; unrelated modal/notice ordering; stale response rejection; preserve unrelated result; deferred error/notice/wait/toast; latest status and clear timing around input; valid/malformed/concurrent selectors; non-string/Error stack handling; card export results; clamped/indeterminate progress; owned wait replacement; agent-browser RisuRealm terms bypass. | Keeps each response dialog bound to its caller while passive statuses wait without overwriting user input. | Critical: resolving the wrong confirmation/input can trigger an unrelated destructive action. |
| `src/ts/alert.importSafety.test.ts`: importing does not touch UI stores before a helper is used. | Allows alert utilities in non-UI initialization paths. | Medium-high architecture value. |
| `src/lib/Others/AlertComp.dom.test.ts`: stale stack translation; input focus/Enter; Escape/button cancel; localized select cancel; backdrop-only dismissal; serial concurrent confirmations; named branch controls; hover/click/Enter/Space detail; focus trap/restore; owner disappearance; and request-data message identity. | Proves the rendered modal preserves service ownership and remains keyboard-operable across dialog types and branch graphs. | Critical accessibility and action-safety coverage. |
| `alertPromptInfo.test.ts`: missing prompt info, absent toggles, and malformed rows. | Keeps diagnostics dialogs render-safe on partial data. | Medium. |
| `src/ts/sourcemap.test.ts`: successful stack-frame translation, fetch failure fallback, and immediate fallback when no frame is sourcemap-backed. | Keeps error details useful without losing the original stack when mapping data is absent or broken. | Medium-high diagnostics value. |

## Modal, popup, editor, and disclosure behavior

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/ts/gui/modalFocusTrap.test.ts`: inert/restore background; preserve pre-existing inert/ARIA; iframe-only login; stacked modal top ownership; nested Settings ancestors; top nested modal keeps app inert; dynamically inserted ancestor sibling. | Defines the shared blocking-modal contract across portals and nested UI. | Critical accessibility and interaction safety. |
| `src/ts/gui/modalBackdropDismiss.test.ts`: primary backdrop press/release dismisses; drags in either direction across dialog/backdrop do not; synthetic activation updates the current callback; non-primary gestures are ignored. | Prevents text-selection or control drags from being retargeted as destructive backdrop clicks while preserving keyboard/programmatic activation. | Critical modal action-safety coverage. |
| `src/lib/UI/PopupList.svelte.test.ts`: no deferred listener after immediate unmount; one-click reopen after outside close; trigger toggle; keyboard focus into menu; arrows/Escape restore. | Protects reusable popup lifecycle and keyboard navigation. | High: this control appears in message/settings actions. |
| `PopupEditor.svelte.test.ts`, `TextAreaInput.svelte.test.ts`, and `TextAreaResizable.svelte.test.ts`. | Rejects stale token counts/edits; contains/restores focus; hotkey/context commits call `onchange`; compact/default/explicit popup gating; unmount/owner-change rejection; click/Enter autocomplete; autocomplete Escape ownership; stable height and caller labels. | High: prevents delayed popup edits from overwriting a new field. |
| `Accordion.svelte.test.ts` and `QuickSettingsGUI.svelte.test.ts`. | Correct disclosure-region association without nested Help action; named quick-setting tabs with active state. | Medium. |

## Shared controls and accessible names

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `CheckInput.svelte.test.ts`, `ColorInput.svelte.test.ts`, `OptionalInput.svelte.test.ts`, and `SliderInput.svelte.test.ts`. | Native checkbox Tab/focus/Space/value; hidden-text label without broken ARIA; native color label/value; explicit boolean assignment; distinct enable/value names; parameter-purpose and caller-provided names. | High accessibility and form-correctness value. |
| `SegmentedControl.svelte.test.ts` and `SideBarArrow.svelte.test.ts`. | Selected option announcement, long-label containment, recalculation after labels/size/observed geometry, and localized sidebar-state names/actions. | Medium-high. |
| `MultiLangInput.svelte.test.ts`: fallback after language removal; first available when English absent; hidden legacy migration while preserving English; no duplicate English offer/add. | Prevents multilingual character metadata loss during language-list changes and legacy migration. | High authored-content value. |
| `src/lib/UI/GUI/Button.svelte.test.ts`: shared button defaults to `type="button"`. | Prevents a generic UI action from implicitly submitting an ancestor form. | High form-correctness value. |
| `src/lib/Others/AccessibleIconActions.test.ts`: parameter/color import-export, PromptDiff close, and Home/Patreon/email/fullscreen icon actions. | Structurally requires a native interactive ancestor and an accessible-name source for nine shared icon controls. | Medium policy backstop. |

## Theme, motion, layout, pointer, syntax, and DOM enhancement

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/ts/gui/animation.test.ts`: OS reduced-motion ignored when app setting is disabled; app setting enables it regardless of OS. | Honors the explicit in-app accessibility preference. | High accessibility value. |
| `src/ts/gui/colorscheme.test.ts`: stale valid/invalid imports; latest import wins; primary/muted, focus, identifying border, selected/control, disabled, destructive, and 70%-scrim edge contrast for every built-in; exact legacy built-in migration; custom/modified untouched. | Protects import ownership, the reviewed WCAG 4.5:1 text and 3:1 interaction relationships, and safe palette migration. | High visual/accessibility and data-integrity value. |
| `src/ts/gui/heightMode.test.ts`, `highlight.test.ts`, and `longtouch.test.ts`. | Eight height-mode projections and replacement; syntax category/range cleanup across every intersecting text node; release/destroy cancellation and one uninterrupted long press. | Medium-high runtime cleanup and input value. |
| `src/ts/observer.svelte.test.ts`: one code-block contextmenu listener; nested/new matching nodes without polling and once; copy/download; BGM control once; rejected playback retry on interaction, no retry after removal; chat switch pauses old and attaches next. | Prevents duplicate DOM listeners, leaked audio, and stale BGM across chat changes. | High reliability/performance value. |
| `src/lib/Others/monacoWorkerErrors.test.ts`: filters raw Worker error events before Monaco rethrows them. | Prevents a known editor worker event from becoming an uncaught UI failure. | Medium. |

## Localization and trusted login origins

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lang/index.test.ts`: same-code identity reuse; selected-pack memoization; delayed/replaced/canceled selections; stale failures; retryable current failures; live property subscriptions; English fallback and unknown-to-English cache key; non-English inherits model-profile strings and provider error formatters; Vietnamese inlay count has no stray `$`. | Keeps the selected language complete through English fallback and fences asynchronous application. | High broad UI contract. |
| `src/lang/triggerDescriptions.test.ts`: English, Chinese, German, Spanish, Korean, Vietnamese, Traditional Chinese use the exact stored-effect placeholders for array insertion summaries. | Prevents translated trigger descriptions from asking for nonexistent fields. | High for script authoring. |
| `src/ts/gui/loginMessageOrigin.test.ts`: four trusted production/nightly/localhost origins, own origin, opaque-origin guard, and seven lookalike/port/IP/malformed/null rejections. | Prevents a spoofed `postMessage` origin from being trusted during login. | Critical security coverage. |

## Onboarding, global chrome, and browser surface

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/Others/WelcomeRisu.svelte.test.ts`: send name; masked/named provider credential; browser locales `zh-CN`, `zh-Hans-SG`, `zh-TW`, `zh-Hant-HK`, `es-MX`; completion only after captured choices persist; in-flight final save survives unmount without painting; failure restore/retry; already-complete guard. | Protects first-run provider/language/memory setup and prevents false completion or exposed credentials. | Critical onboarding coverage. |
| `src/lib/Others/SavePopupIcon.svelte.test.ts`: saving, saved, and idle states. | Keeps persistence feedback truthful, including clearing a stale success indicator once no save state applies. | Medium feedback value. |
| `src/ts/hubAdditionalHtml.test.ts`: executable/document-controlling content removal, safe announcement markup retention without global parser hooks, non-string fail-closed behavior, and removal of full-screen-overlay utility classes. | Prevents remote Hub announcements from executing code or visually controlling the entire application while preserving safe content. | Critical content-safety coverage. |
| `src/lib/UI/Title.svelte.test.ts`: anniversary native link, Christmas native button, and fake-timer teardown. | Keeps seasonal global actions keyboard-operable without leaving the title interval alive after unmount. | Low-medium. |
| `src/ts/browserLocalSurface.test.ts`: no obsolete share target/file handlers/old service worker/preload; current service worker exists; standalone display. | Defines the Fastify-only installable browser manifest surface. | High packaging/platform value. |
| Playwright `fastifyBrowserSmoke.spec.ts > core chat controls and blocking alerts remain accessible across responsive viewports`. | Real Chromium control naming, composer/transcript geometry, and modal focus containment/restoration at desktop and mobile viewport sizes. | High browser accessibility smoke. |
| Playwright `lazyFirstOpen.spec.ts`: delayed modal entry, offline JavaScript, and stale stylesheet cases. | Real emitted-asset pending/error states, localized recovery, CSS application, focus containment, and opener restoration. | High production-boundary smoke. |
| Playwright `uiUxImprovementBaseline.spec.ts`: seven-surface screenshot journey plus keyboard/reduced-motion/reflow/mutation journey. | Real Chromium verifies compact drawer geometry, 44-pixel targets, long-label overflow, popup and disclosure keys, nested modal inertness, footer reachability, Input Hook deletion focus, BardWiki list/detail persistence, live announcements, and connected-opener restoration. | High cross-surface accessibility evidence. |

## Especially critical tests

- Alert FIFO/stale-response cases prevent one dialog from resolving another caller’s destructive action.
- Modal stack/inert and drag-safe backdrop tests prevent focus escaping or an in-dialog gesture from closing the active workflow.
- Welcome persistence and secret masking protect first-run credentials and setup completion.
- Login origin allowlisting is the security-critical edge of an otherwise presentation-focused area.
- Color contrast/import and DOM observer cleanup protect accessibility and long-session reliability.

## Primary inventory

| Group | Complete in-scope file inventory |
| --- | --- |
| Alerts/modals | `src/lib/Others/AlertComp.dom.test.ts`; `PopupEditor.svelte.test.ts`; `QuickSettingsGUI.svelte.test.ts`; `alertPromptInfo.test.ts`; `src/lib/UI/Accordion.svelte.test.ts`; `PopupList.svelte.test.ts`; `src/ts/alert.importSafety.test.ts`; `alert.test.ts`; `src/ts/gui/modalBackdropDismiss.test.ts`; `modalFocusTrap.test.ts` |
| Controls/accessibility | `src/lib/Others/AccessibleIconActions.test.ts`; `src/lib/UI/GUI/Button.svelte.test.ts`; `CheckInput.svelte.test.ts`; `ColorInput.svelte.test.ts`; `MultiLangInput.svelte.test.ts`; `OptionalInput.svelte.test.ts`; `SegmentedControl.svelte.test.ts`; `SideBarArrow.svelte.test.ts`; `SliderInput.svelte.test.ts`; `TextAreaInput.svelte.test.ts`; `TextAreaResizable.svelte.test.ts` |
| Language/theme/DOM | `src/lang/index.test.ts`; `triggerDescriptions.test.ts`; `src/ts/gui/animation.test.ts`; `colorscheme.test.ts`; `heightMode.test.ts`; `highlight.test.ts`; `loginMessageOrigin.test.ts`; `longtouch.test.ts`; `viewportScrollGuard.test.ts`; `src/ts/observer.svelte.test.ts` |
| Onboarding/chrome | `src/lib/Others/SavePopupIcon.svelte.test.ts`; `WelcomeRisu.svelte.test.ts`; `monacoWorkerErrors.test.ts`; `src/lib/UI/Title.svelte.test.ts`; `src/ts/browserLocalSurface.test.ts` |
| Cross-cutting diagnostics/content safety | `src/ts/sourcemap.test.ts`; `src/ts/hubAdditionalHtml.test.ts` |
