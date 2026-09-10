# UI/UX Improvement Phases

Start with [status](../status.md) and the stable [plan](../PLAN.md), then read only the active phase.

| Phase | Document |
| --- | --- |
| 0 | [Shared contracts and acceptance baseline](phase-0-shared-contracts-and-baseline.md) |
| 1 | [Effective state and validation](phase-1-effective-state-and-validation.md) |
| 2 | [Destructive safety and persistence feedback](phase-2-destructive-safety-and-persistence.md) |
| 3 | [Compact navigation and action density](phase-3-compact-navigation-and-actions.md) |
| 4 | [Outcome language and authoring tools](phase-4-outcome-language-and-authoring.md) |
| 5 | [Guided BardWiki workspace](phase-5-guided-bardwiki-workspace.md) |
| 6 | [Accessibility, visual evidence, and closeout](phase-6-accessibility-and-closeout.md) |

Phases are sequential unless a phase explicitly names a weaker dependency. Keep implementation slices cohesive and update only [status.md](../status.md) with progress and evidence; phase documents define work and acceptance, not current completion.

Every user-visible string is localized. Every mutation-facing state distinguishes accepted, queued, and failed. Every change preserves stable IDs, current command ownership, retained drafts, and server-authoritative reconciliation.

Planning-only changes require current-document validation, formatting, and whitespace checks. Implementation slices use their focused tests. Phase 6 owns the final aggregate and browser matrix; do not run the broad aggregate after every phase.
