# UI And User Input Archive

Historical visible-state testing, user-input persistence, settings controls,
and async stale-state work.

## Connected Readers

| Record                                                             | Scope                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Connected read-only clients](connected-read-only-clients/PLAN.md) | Completed reader/writer lifecycle, local browsing, explicit switching, draft/intent retention and live generation; [accepted rollout and evidence](connected-read-only-clients/status.md#phase-5-acceptance-and-stage-3-handoff-2026-09-08), including normal/FALSE builds and all 92 browser cases. |
| [Read-only mode in the existing app UX](read-only-app-ux/PLAN.md)  | Shared navigation and transcript, confirmed passive appearance, denied authoring/script entry, desktop/mobile and lifecycle proof; [completed evidence](read-only-app-ux/status.md).                                                                                                                 |

## Visible State

| Record                                                                                               | Scope                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`visible-state/state-contract-hardening/`](visible-state/state-contract-hardening/README.md)        | Stable selectors, visible-state testing policy, DOM regression coverage, browser smoke, and closeout.      |
| [`visible-state/state-contract-hardening/pilot.md`](visible-state/state-contract-hardening/pilot.md) | Completed chat/list UI-state contract pilot that preceded hardening.                                       |
| [`visible-state/behavioral-audit/`](visible-state/behavioral-audit/README.md)                        | Rendered-DOM behavioral audit, original plan, findings, acceptance proof, and remediation recommendations. |

## User Input

| Record                                                                               | Scope                                                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`user-input/persistence-audits/`](user-input/persistence-audits/README.md)          | Initial and post-fix June 16 persistence audits, kept separate so changed verdicts retain chronology.                           |
| [`user-input/audit-records/`](user-input/audit-records/README.md)                    | Eight domain files consolidating the baseline inventory, verification audit, and stale-state assessment for each input surface. |
| [`user-input/state-hardening/`](user-input/state-hardening/README.md)                | Closed implementation plan that hardened async callbacks, rollback, projection merge, imports, generation, and navigation.      |
| [`user-input/ui-flow-stale-state-audit.md`](user-input/ui-flow-stale-state-audit.md) | June 24 stale-flow audit with its remediation status merged into the same file.                                                 |
| [`input-hooks-rework-2026-07-20.md`](input-hooks-rework-2026-07-20.md)               | Global draft/BTW hook authoring, per-chat selection, composer draft flow, and settled execution context.                        |

## Chat And Settings UI

| Record                                                                     | Scope                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`chat-screen-width-2026-07-20.md`](chat-screen-width-2026-07-20.md)       | Fixed chat-column width setting, responsive layout contract, and existing-database hydration constraint. |
| [`saved-toggles-rework-2026-07-20.md`](saved-toggles-rework-2026-07-20.md) | Saved-toggle state model, dialog selection, Pick merge semantics, and historical validation baseline.    |
| [`data-driven-ui.md`](data-driven-ui.md)                                   | Dated 2026-08-17 inventory of data-dependent UI variants and their implementation owners.                |

Within each consolidated audit record, later verification and stale-state
sections supersede conflicting baseline verdicts. The initial and post-fix June
16 audits remain separate because they describe different code states.
