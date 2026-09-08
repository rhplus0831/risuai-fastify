# Archived Documentation

Completed or retired workstreams, dated audits, and historical decision records.
These documents explain how the current Fastify-only codebase arrived at its present
shape; they are not the source of current behavior. Start with
[`../STRUCTURE.md`](../STRUCTURE.md) for current navigation, and prefer the
codebase whenever an archived line number or contract has drifted.

## Topics

| Topic                                                                        | Contents                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture and migration](architecture-and-migration/README.md)           | Fastify migration history, client-thinning closeout, upstream-sync sweep, dated comparison, and the exhaustive Original RisuAI behavioral compatibility workstream.                      |
| [Protocol and persistence](protocol-and-persistence/README.md)               | Server/client protocol audits, SQLite migration, projection work, asset coercion, mutation narrowing, and writer takeover.                                                               |
| [Performance and stability](performance-and-stability/README.md)             | Frontend test/runtime and clone narrowing, the exhaustive test-suite effectiveness audit, chat multitasking regressions, and four chronological stability/performance audits.            |
| [Fast Bootstrap](fast-bootstrap/README.md)                                   | Historical startup-performance execution guide, phase runbooks, and Phase 7 rollout ledger.                                                                                              |
| [Generation and models](generation-and-models/README.md)                     | Durable generation, translation decisions, chat-scoped settings, Agent Presets, model profiles, and prompt-template ownership.                                                           |
| [Memory and context](memory-and-context/README.md)                           | BardWiki's completed server-owned Markdown memory plan, locked contract, seven implementation phases, and final verification record.                                                     |
| [UI and user input](ui-and-user-input/README.md)                             | Connected-reader lifecycle and shared UI, visible-state and persistence audits, data-driven UI inventory, input hooks, chat/settings controls, stale-state reviews, and input hardening. |
| [Deferred work](deferred-work/README.md)                                     | The consolidated deferred-feature inventory/progress record and the older Fastify leftover snapshot.                                                                                     |
| [July 23 audit scopes](audit-scopes-2026-07-23/README.md)                    | Closed cross-cutting audit charters, verification records, and the plans implemented on 2026-07-23.                                                                                      |
| [August 5 data-loss delta audit](data-loss-delta-audit-2026-08-05/README.md) | Closed dual-track (Codex+Claude) pre-beta data-loss audit: charter, ten pass reports, consolidated conclusion, D1/D2 decisions.                                                          |
| [Message-generation parity audit](audit/WORK-INDEX.md)                       | Closed August 2026 parity review: 51 resolved findings, two deferred items, and the supporting area evidence.                                                                            |
| [August 2026 Fastify audits](fastify-audits-2026-08-11-to-12/WORK-INDEX.md)  | Closed multi-chat/mobile stability review and original-Risu compatibility audit, including validation reports and the accepted-send protocol plan.                                       |

## Archive Conventions

- Related workstreams are grouped by topic, while their internal phase and
  slice structure remains intact.
- Chronological audit versions, plans, statuses, and phase records remain
  separate because they describe different points in time or different
  document roles.
- Redundant evidence/progress pairs and parallel audit lenses were consolidated
  into canonical files. Each merged file labels its historical sections and
  states which later section supersedes earlier verdicts.
- Historical completeness-gate references describe the closeout process; those
  Markdown gates are no longer part of the live suite. Archived JSON remains a
  live input only where current tooling imports it explicitly.
- Active plans, when present, live under `docs/plan/`; archived TODO language is
  not an active backlog unless a current plan explicitly reopens it.

## Deferred Records

[`deferred-work/deferred-features.md`](deferred-work/deferred-features.md)
combines the June 2026 inventory with its disposition tracker.
[`deferred-work/leftover.md`](deferred-work/leftover.md) is an older historical
snapshot and should not be read as current work.
