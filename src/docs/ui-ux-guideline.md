# UI/UX Guideline

Last audited: 2026-09-24.

Scope: every user-visible surface under `src/lib` and `src/App.svelte`. Read
this before adding a screen, control, dialog, or state, or before restyling an
existing one. Behavior owners stay in the focused guides; this file states the
visual and interaction rules those surfaces keep, the mechanism each rule uses,
and how it is checked.

Rule levels. **MUST** rules have a mechanism in the codebase or a check the
reviewer runs; a change that cannot meet one names the reason in its commit
message. **SHOULD** rules are the default; deviate only for a reason you can
state in one sentence.

## Fast Triage

| Question | Go to |
| --- | --- |
| Which control, dialog, or row primitive do I use? | [Build from what exists](#1-build-from-what-exists) |
| Which classes are allowed for color, spacing, type, radius? | [Tokens](#2-tokens) |
| How is a new screen laid out? | [Layout and hierarchy](#3-layout-and-hierarchy) |
| What does a save, delete, or load surface have to show? | [States](#5-states) |
| Does my dialog or drawer meet the focus contract? | [Focus, keyboard, and pointer](#6-focus-keyboard-and-pointer) |
| What do I check before saying it is done? | [Done checklist](#9-done-checklist) |

## Visual Direction

RisuAI is a dense, text-first tool used for hours at a time, often on a phone.
The look that works here is quiet: one surface color, one accent, hairline
borders, small type, steady vertical rhythm, and no decoration that does not
carry information. A screen is right when the eye lands on the primary action
without hunting, related controls read as one group at a glance, and nothing
competes with the transcript.

The shipped surfaces use `bg-darkbg` panels on `bg-bgcolor`, `border-darkborderc`
hairlines, `text-textcolor` body with `text-textcolor2` metadata, `rounded-md`
corners, 8-pixel gaps inside a group and 16 to 24 pixels between groups,
`text-sm` body and `text-xs` metadata. New work matches that, or it looks like
it came from another app.

## 1. Build From What Exists

- MUST: controls come from `src/lib/UI/GUI/`: `Button`, `IconButton`,
  `TextInput`, `NumberInput`, `TextAreaInput`, `SelectInput`, `OptionInput`,
  `RadioInput`, `CheckInput`, `SliderInput`, `SegmentedControl`, `SecretInput`,
  `ColorInput`, `MultiLangInput`. Wrappers pass a name, state, and handlers;
  they do not re-implement a primitive's focus ring, disabled state, or
  keyboard behavior. Owner: [Shared Controls And Focus](svelte-settings-ui.md#shared-controls-and-focus).
- MUST: a settings row is a data-driven entry (`labelKey`, `helpKey`, option
  `labelKey` per `src/ts/setting/types.ts` and the `*SettingsData` registries),
  not a hand-built component, unless no row type can express the control. Then
  register a custom row the way `ColorSchemeSelect` is registered.
- MUST: blocking dialogs and drawers use `use:modalFocusTrap` and
  `use:modalBackdropDismiss` on a `data-modal-root` element
  (`src/ts/gui/modalFocusTrap.ts`, `src/ts/gui/modalBackdropDismiss.ts`).
  Feedback goes through `src/ts/alert.ts` (`alertConfirm`, `alertError`,
  `alertToast`, `alertInput`, `alertSelect`, `alertProgress`), never a new overlay.
- MUST: icons are `@lucide/svelte`. An icon-only control has an accessible
  name: `ariaLabel` on `Button`, `name` on `IconButton`, or an `sr-only` span
  inside it. An icon that is not universally read (anything beyond close, add,
  delete, search, copy, settings) also has visible text.
- SHOULD: before adding a component, find two shipped surfaces that do the
  same job and copy their structure. If none exists, say so in the commit message.
- MUST NOT: inline `style=` for color, spacing, or type; a `<style>` block that
  restates a Tailwind class; a new z-index layer; global CSS in `src/styles.css`
  for a single surface.

## 2. Tokens

Tailwind v4 owns spacing, radius, and type. Color goes through the `@theme`
block in `src/styles.css`, which maps `--color-*` utilities to `--risu-theme-*`
custom properties that the user's color scheme sets at runtime. Users choose or
edit palettes and inject Custom CSS, so a color that is not routed through a
token breaks their theme and escapes the contrast oracle.

| Need | Use | Not |
| --- | --- | --- |
| Page or panel background | `bg-bgcolor`, `bg-darkbg` | `bg-zinc-900`, `bg-gray-800`, hex |
| Hairline or divider | `border-darkborderc`; `border-borderc` for the focused or identifying edge | `border-zinc-700` |
| Selected or hover surface | `bg-selected` | `bg-blue-*` |
| Button surface | `Button` with `styled="primary"` (`bg-darkbutton`) or `styled="outlined"` | a custom `bg-*` on a raw `<button>` |
| Body text | `text-textcolor` | `text-white`, `text-gray-100` |
| Metadata, help, secondary | `text-textcolor2` | `text-gray-400`, opacity tricks |
| Destructive text or edge | `text-draculared`; `Button` with `styled="danger"` | `text-red-500` |
| Status marks (success, warning) | `success-*`, `amber-*` beside a word or icon | color as the only signal |
| Fixed semantic scales (not themed) | `primary-*`, `danger-*`, `success-*`, `neutral-*` from `:root` | mixing them with themed tokens on one surface |

- MUST: no color literals (`#…`, `rgb(`, `oklch(`) in a `.svelte` file except
  a control whose job is to show a color (`ColorInput`, palette cards). Raw
  Tailwind palette classes (`zinc-*`, `gray-*`, `blue-*`, `red-*`, `green-*`)
  are legacy: new markup does not add them, and a touched line migrates to the
  token column. Count on 2026-09-24: about 850 legacy palette uses against
  about 4,000 token uses under `src/lib`.
- MUST: spacing uses the Tailwind scale at 1, 2, 3, 4, and 6 (4, 8, 12, 16,
  24 CSS px). Inside a group: `gap-2`, `mt-2`. Between groups: `mt-4`, `gap-4`.
  Between sections: `mt-6`. Panel padding: `p-3` or `p-4`; dialogs `p-6`.
  No `mt-5`, `gap-7`, or arbitrary values such as `mt-[13px]`.
- MUST: radius is `rounded-md` for controls, inputs, and rows; `rounded-lg`
  for dialogs, menus, and panel cards; `rounded-full` for avatars and pills.
  Nothing else.
- MUST: type is `text-xs` (metadata, technical details), `text-sm` (body,
  rows, inputs), `text-lg` (section title), `text-2xl` (page title). No `px`
  font sizes in components; the user's size preference scales `rem`.
  `font-semibold` marks titles and the one primary action; body is normal
  weight; nothing else is bold.
- MUST: motion is a CSS transition or animation, `duration-200` by default, so
  `html.risu-reduced-motion` neutralizes it. Reduced Motion is a durable app
  setting, not the OS media query; JavaScript-driven motion reads the same
  setting. Owner: [Styling, Theme, And Layout](svelte-ui.md#styling-theme-and-layout).
- MUST: shell dimensions come from `shellGeometry.ts`; transcript width from
  `--chat-screen-width` and `chat-screen-content-width`. No hard-coded
  viewport offsets.
- SHOULD NOT: shadows beyond `shadow-xs` on controls, gradients, colored
  backgrounds behind text, or accent borders on a group. If a group needs a
  boundary, use spacing first, a hairline second, a panel third.

## 3. Layout And Hierarchy

- MUST: one primary action per screen, drawer, or dialog. It is the
  `styled="primary"` button at the trailing edge (bottom-right of a dialog,
  top-right of a list page). Other actions in the same group are
  `styled="outlined"`. Destructive actions are `styled="danger"`, sit apart from
  the primary action (leading edge, or under a divider), and never share a row
  with it. Hierarchy comes from position and the primary/outlined split; do not
  invent a filled accent button.
- MUST: labels are persistent and above the input. Help text is one sentence
  in `text-xs text-textcolor2` below it. A validation message follows the help
  text in `text-draculared` with a text prefix, not color alone. Placeholders
  are examples, never the label.
- MUST: related label, input, help, and action stay within `gap-2`; unrelated
  groups separate with `mt-4` or more; each column aligns to a single leading
  edge. At most three text levels are visible at once: title, section, body or
  metadata.
- MUST: truncated text keeps its full accessible name (`title` or `aria-label`)
  and reveals the full value on hover and keyboard focus. The primary action
  label is never truncated.
- MUST: implementation identifiers, hashes, raw JSON, and syntax go under a
  collapsed `<details>` whose `<summary>` is `language.technicalDetails`; the
  outcome-oriented label leads. Reference: `src/lib/Setting/Pages/AgentPresetSettings.svelte`.
- SHOULD: lists of like items are rows with a `data-risu-*` identity, `text-sm`
  content, one metadata line, and actions at the trailing edge. Cards are for
  items chosen by appearance (palettes, characters), not for settings.
- SHOULD NOT: a card inside a card; a border around a single control; a section
  heading over a single row; centered text outside empty states; emoji or
  decorative icons in labels.

## 4. Copy And Localization

- MUST: every visible string is a key in `src/lang/en.ts` first. Data-driven
  rows use `labelKey` and `helpKey`; `fallbackLabel` is an escape hatch that
  needs a reason. Other packs are optional deep partials.
  Owner: [Localization](svelte-ui.md#localization).
- MUST: action labels are verb-led and name the result (`Save changes`,
  `Delete preset`, `Use this device`), never `OK`, `Yes`, or `Submit`.
  Sentence case; no trailing period on a label; help text is a full sentence.
- MUST: one concept, one word, everywhere. Domain terms follow the
  [Domain Glossary](../../docs/structure/domain-glossary.md): Agent, Agent
  Preset, Model Profile, Lorebook, BardWiki, Module, Plugin.
- MUST: an error message says what happened and what to do next. A raw
  exception string appears only under Technical details.
- SHOULD: labels survive 1.5x length (German, Korean, Japanese packs) without
  pushing the trailing action off its row. Check the rail and the drawer with
  the longest pack you can load.

## 5. States

Every surface that reads or writes durable data shows the states below. The
mutation vocabulary is the repository invariant: `accepted`, `queued`, `failed`.

| State | What the user sees | Mechanism or reference |
| --- | --- | --- |
| Loading | The surface's frame with an in-place spinner or `animate-pulse` block; the primary action does not move | Route loading and Retry mount beside the route; never a blank screen |
| Empty | One sentence naming what is missing, one primary next action, secondary routes only when they apply | Agent Preset empty state in `AgentPresetSettings.svelte` |
| In flight | Submit disabled, progress visible, input preserved; a second activation does nothing | `alertProgress`, `alertWait`, or local `disabled` |
| Queued | "Queued" or "Pending sync", visually distinct from saved; newer drafts are kept | Outbox state; starting a request is never shown as success |
| Accepted | The saving indicator (`SavePopupIcon`, honoring `showSavingIcon`) or `alertToast`; no dialog for a routine save | |
| Failed | Message beside the field or surface, input preserved, a Retry action | `alertError` only for global failures |
| Disabled | The reason in help text or a tooltip when it is not obvious; reader-role gates show the localized gate with Home and Return to reading | `readerAlertPolicy.ts`, route gate |
| Inherited | "Same as <source>" or the effective value beside the empty control; viewing never writes an override | Model Profile role selects in [Settings UI](svelte-settings-ui.md#model-profiles-and-provider-panels) |

- MUST: a destructive action names its target in the confirmation
  (`alertConfirm`), previews affected dependents and fallbacks when they can be
  computed, and fails closed with a Retry when the impact check cannot
  complete. Reference: `src/ts/agentPresetDeletionImpact.ts` and its use in
  `AgentPresetSettings.svelte`.
- MUST: Cancel and navigate-away are one visible action plus Escape. Leaving a
  flow preserves the draft wherever a draft store exists.
- SHOULD NOT: a confirmation for a reversible action; a toast for every save;
  a success dialog.

## 6. Focus, Keyboard, And Pointer

- MUST: interactive elements are native (`button`, `a`, `input`, `select`) or
  carry a role and an accessible name. Focus is visible through the shared
  ring: `focus:ring-2 focus:ring-borderc focus:outline-hidden` on inputs,
  `focus:ring-selected` on buttons, `peer-focus-visible:ring-2` on custom
  check controls. Tab order follows reading order.
- MUST: a blocking dialog traps focus, makes background branches inert and
  hidden from assistive technology, owns Escape at the top of the stack, locks
  body scroll, and restores a connected opener. A transient menu that opens a
  modal focuses a persistent opener first.
  Owner: [App Render Priority](svelte-ui.md#app-render-priority).
- MUST: on compact layouts the drawer keeps a 56-pixel scrim target and its
  Close reachable regardless of configured sidebar width or rail columns.
- MUST: compact and touch targets are at least 44 x 44 CSS px; the hit area may
  exceed the icon. A horizontal drag (`SliderInput`) does not capture vertical
  page pan.
- MUST: content scrolls in inner containers, never `window` or the document
  root (`src/ts/gui/viewportScrollGuard.ts`). While a text editor is focused,
  the composer stays inside the visual viewport.
- SHOULD: `data-risu-*` attributes on rows, dialogs, and primary actions so
  Playwright journeys select by identity rather than by text.

## 7. Color, Contrast, And Theming

- MUST: built-in palettes pass `colorSchemeAccessibilityIssues()`: 4.5:1 for
  primary and muted text and for text on selected or control surfaces; 3:1 for
  focus indicators, identifying borders, 50%-opacity disabled text,
  destructive text, and the modal edge against the page under the 70% scrim.
  The disabled-text rule is stricter than WCAG 2.2 AA by choice. Custom or
  modified palettes keep their values and receive the visible warning in
  Display settings; they are never rewritten.
- MUST: meaning never rides on color alone. Status shows an icon or a word
  beside the color.
- MUST: native `select` options inherit the published `color-scheme`; a
  fixed-palette select declares its own.
- SHOULD: check a new surface on the default (dark) and light built-in
  palettes and on one custom palette that shows the warning.

## 8. Responsive Contract

- The conversation shell switches at `window.innerWidth <= 1024`. Acceptance
  viewports: desktop at 1600 x 900 or wider (the `drive-app` default), compact
  550 x 775 and 655 x 691, and 640 px wide as the 200% zoom equivalent of a
  1280 px desktop. WCAG 1.4.10 reflow at 320 px is not a project check.
- MUST at each viewport: no horizontal page scroll, final controls not
  clipped, sticky actions visible with the keyboard open, and a return path
  (Back, Close, or Home) visible without scrolling.
- MUST: reader and writer roles share the same geometry model; there is no
  reader-only breakpoint.

## 9. Done Checklist

Run this before reporting a UI change complete. The UI/UX browser journey
(`server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`) is extended
tier; it is not the evidence. Driving the app is.

1. Opened the surface with the `drive-app` skill at desktop, 550 x 775, and
   655 x 691, on the dark and light built-in palettes.
2. The primary action is the first thing the eye lands on; nothing else is
   emphasized.
3. Every class in the diff is in the token tables: no hex, no `zinc-*`,
   `gray-*`, or `blue-*`, no `px` type, no arbitrary spacing.
4. Every new string is in `src/lang/en.ts`; labels are verb-led; the longest
   label still fits its row.
5. Loading, empty, in-flight, queued, accepted, failed, and disabled are each
   visible or provably impossible for this surface.
6. Tabbed through the surface: order matches reading order, the ring is
   visible, Escape closes the top dialog, focus returns to the opener.
7. Reduced Motion on: nothing animates. A custom palette with the warning:
   nothing is rewritten.
8. No mounted component tests under `src/lib` (Test Policy). A user-visible
   behavior that needs protection gets a Playwright journey.

## Related

- [Svelte UI](svelte-ui.md), [Settings UI](svelte-settings-ui.md),
  [Chat UI](svelte-chat-ui.md), [Navigation UI](svelte-navigation-ui.md)
- [Test Policy](../../AGENTS.md#test-policy) and
  [Shared UI feedback and accessibility tests](../../docs/tests/shared-ui-feedback-and-accessibility.md)
- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/) for
  definitions. This guideline targets the project rules above, not conformance.
