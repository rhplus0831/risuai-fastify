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

## 6. Handle Relevant UI States

* Account for loading, empty, error, success, and disabled states where applicable.
* Provide visible feedback when an action is processing or complete.
* Explain how to recover from errors.
* Explain disabled actions when the reason is not obvious.
* Prevent accidental duplicate submissions.

## 7. Protect User Input and Prevent Mistakes

* Give inputs persistent, visible labels; do not rely on placeholders alone.
* Place validation messages near the relevant fields.
* Preserve user input when validation or network requests fail.
* Provide confirmation or recovery for destructive, difficult-to-reverse actions.
* Make cancellation and navigation out of a flow straightforward.

## 8. Meet Basic Accessibility Requirements

* Use semantic HTML and native controls where possible.
* Support keyboard operation with a visible focus indicator and logical focus order.
* Do not communicate meaning through color alone.
* Prefer targets of at least 44 × 44 CSS pixels for touch-oriented interfaces. The clickable area may be larger than the visible icon.

## References

* [Nielsen’s 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
* [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)

These guidelines are a practical baseline, not a complete WCAG conformance checklist.
