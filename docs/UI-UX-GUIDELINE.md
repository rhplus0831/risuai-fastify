# UI/UX Guidelines

## 1. Follow the Existing Design System

* Inspect existing screens, components, design tokens, and terminology before making changes.
* Reuse established patterns.
* Do not introduce a new design system or redesign unrelated areas unless explicitly requested.

## 2. Establish a Clear Visual Hierarchy

* Make the primary action clear within each screen or task area.
* Give secondary actions less visual emphasis.
* Use typography, spacing, and placement to communicate importance. Avoid making everything equally prominent.

## 3. Group Related Content

* Keep related labels, inputs, descriptions, and actions close together.
* Use larger spacing between unrelated groups.
* Keep alignment and reading order consistent.

## 4. Use Consistent Design Tokens

* Use shared tokens for colors, spacing, typography, borders, and corner radii.
* Avoid arbitrary values when an existing token fits.
* If no spacing system exists, start with a small scale such as 4, 8, 12, 16, 24, and 32 CSS pixels.
* Add decoration only when it supports hierarchy, meaning, or the established visual style.

## 5. Make Controls Understandable

* Use action labels that describe the result, such as “Save changes” instead of “OK.”
* Use consistent terminology for the same concepts.
* Give unfamiliar icons visible text labels.
* Give all interactive controls accessible names.
* Keep implementation identifiers, syntax, and hashes under Technical details when an outcome-oriented label can lead the task.
* When text is truncated, retain the complete accessible name and reveal the full value on hover or keyboard focus.

## 6. Handle Relevant UI States

* Account for loading, empty, error, success, and disabled states where applicable.
* Provide visible feedback when an action is processing or complete.
* Explain how to recover from errors.
* Explain disabled actions when the reason is not obvious.
* Prevent accidental duplicate submissions.
* Distinguish saving, queued/pending sync, accepted/saved, and failed outcomes. Starting a request is not success.
* Show inherited values beside their effective result without silently materializing an override.
* Turn an empty state into a workflow with one primary next action and only relevant secondary routes.

## 7. Protect User Input and Prevent Mistakes

* Give inputs persistent, visible labels; do not rely on placeholders alone.
* Place validation messages near the relevant fields.
* Preserve user input when validation or network requests fail.
* Provide confirmation or recovery for destructive, difficult-to-reverse actions.
* Make cancellation and navigation out of a flow straightforward.
* Name the destructive target, separate the action visually from routine controls, and preview affected dependencies and fallbacks when they can be computed.
* Fail closed when a complete destructive-impact check depends on unavailable or ambiguous data; provide a retry path.

## 8. Meet Basic Accessibility Requirements

* Use semantic HTML and native controls where possible.
* Support keyboard operation with a visible focus indicator and logical focus order.
* Do not communicate meaning through color alone.
* Prefer targets of at least 44 × 44 CSS pixels for touch-oriented interfaces. The clickable area may be larger than the visible icon.
* Keep blocking dialogs focus-trapped, make background branches inert and hidden from assistive technology, own Escape at the top dialog, and restore a connected opener.
* Preserve a meaningful dismissal target when a responsive drawer overlays content; do not let configured width or columns push Close or the scrim off-screen.
* Measure normal and muted text at 4.5:1, and identifying borders, focus indicators, disabled/destructive states, and modal edges at 3:1. Warn about custom-theme gaps without silently rewriting user colors.
* Test reduced motion, long labels, compact widths, and 200% reflow without horizontal page scrolling, clipped final controls, hidden sticky actions, or lost return paths.

## References

* [Nielsen’s 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
* [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)

These guidelines are a practical baseline, not a complete WCAG conformance checklist.

## Project Application

Use [`src/docs/README.md`](../src/docs/README.md) to find the component or
browser-runtime owner for a RisuAI surface. The focused source guides and their
linked tests are canonical for project-specific behavior and evidence; this
file remains the general design baseline.
