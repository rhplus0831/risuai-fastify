# Unified Read-Only Workspace Status

## Current Cursor

- State: **Active plan created; implementation has not started.**
- Current phase: none accepted.
- Next action: execute Phase 0 and ratify the source/action inventory,
  reproducible performance baseline, numeric comparison thresholds, and one
  whole-path rollout mechanism before runtime changes.
- Source baseline reviewed: `6f6adea37b39f5b9d52b86d49558f3455fda8916`.
- No runtime behavior has changed through this planning package.
- Current architecture and test guides remain authoritative for shipped
  behavior.

## Document Map

- [PLAN.md](PLAN.md): stable product contract, invariants, scope, rollout, phase
  order, and completion criteria.
- [Inventory](inventory.md): current source, behavior, test, documentation, and
  performance owners.
- [Phase index](phases/README.md): execution rules, phase routing, and explicit
  plan-document validation.
- [Active plans](../README.md): repository active-plan index.
- [Prior read-only app UX](../../../.archived-docs/ui-and-user-input/read-only-app-ux/status.md):
  accepted familiar-reader presentation and containment evidence.
- [Prior shell parity](../../../.archived-docs/ui-and-user-input/read-only-shell-parity/status.md):
  accepted geometry and automatic-transition stability evidence.
- [Prior connected readers](../../../.archived-docs/ui-and-user-input/connected-read-only-clients/status.md):
  accepted authority, synchronization, promotion, and live-observation evidence.

## Phase Ledger

| Phase                                                                                           | State   | Acceptance evidence |
| ----------------------------------------------------------------------------------------------- | ------- | ------------------- |
| [0. Contract, inventory, and baseline](phases/phase-0-contract-inventory-and-baseline.md)       | Pending | Not run             |
| [1. Access and readiness model](phases/phase-1-access-and-readiness-model.md)                   | Pending | Not run             |
| [2. Role-first bootstrap](phases/phase-2-role-first-bootstrap.md)                               | Pending | Not run             |
| [3. Unified shell and navigation](phases/phase-3-unified-shell-and-navigation.md)               | Pending | Not run             |
| [4. Transcript and composer containment](phases/phase-4-transcript-and-composer-containment.md) | Pending | Not run             |
| [5. Role transitions and performance](phases/phase-5-role-transitions-and-performance.md)       | Pending | Not run             |
| [6. Rollout cleanup and closeout](phases/phase-6-rollout-cleanup-and-closeout.md)               | Pending | Not run             |

## Decisions

- 2026-09-10: create a new active workstream rather than reopening the three
  completed read-only archives. They are predecessor contracts and evidence, not
  mutable execution records.
- 2026-09-10: use the repository's full `PLAN.md`, `status.md`, inventory, phase
  index, and separate phase-document structure because the work changes
  bootstrap, route intent, reader/writer presentation ownership, promotion, and
  more than three independently acceptable boundaries.
- 2026-09-10: keep the Svelte root/loading surface available while resolving the
  initial role, but do not render a reader workspace during an automatic writer
  attempt.
- 2026-09-10: derive presentation and interaction capabilities from existing
  session/readiness authorities. Do not add a mutable role flag that can drift
  from authentication, projection, recovery, or writer ownership.
- 2026-09-10: remove the dedicated ObserverShell environment while retaining
  reader projections, synchronization, passive rendering, live generation
  observation, and revision/auth/lineage fences.
- 2026-09-10: keep reader and writer controllers separate beneath shared normal
  presentation. Do not mount the unmodified writer controller for a reader.
- 2026-09-10: place one accessible device-promotion action in the top-right of
  the visual viewport shell. It remains until writer recovery is actually ready.
- 2026-09-10: reader character/chat navigation remains local and does not
  retroactively update persisted selection or `lastInteraction` during
  promotion. A later explicit writer-mode selection may persist normally.
- 2026-09-10: Settings, Playground, plugin/custom-GUI applications, interactive
  scripts, imports, and authoring remain unavailable to readers.
- 2026-09-10: follow Crunch Mode throughout this workstream. Do not run
  `pnpm test:agent` or `pnpm test:all`; use focused tests and only the relevant
  type/build/browser checks.
- 2026-09-10: progress and verification are recorded only here. Phase documents
  remain stable work/acceptance contracts.

## Planning Evidence

The plan was grounded in the current App/bootstrap/readiness/session flow,
observer and reader components, writer sidebar/chat/composer owners, command and
generation guards, current architecture/test guides, completed predecessor
plans, and the available ignored fast-bootstrap artifact. Broad read-only source
cross-checks were performed before the planning package was written.

Planning-document validation on 2026-09-10:

| Command                                                                                                                  | Result                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm check:docs`                                                                                                        | Passed for 49 current documents                                                             |
| Explicit package/index validation from `phases/README.md`                                                                | Passed for all 12 active-plan documents with no link, anchor, index, or literal-path errors |
| `pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md 'docs/plan/unified-read-only-workspace/**/*.md'` | Passed                                                                                      |
| `git diff --check`                                                                                                       | Passed                                                                                      |

The first explicit package validation identified one stale proposed test path in
the inventory. It was replaced with the current composer-draft test owner, and
the complete 12-document validation then passed. No runtime suite was required
or run for this planning-only change.

## Progress Record

- 2026-09-10: created the stable product/architecture contract, active status
  ledger, source/test inventory, and seven-phase execution package. All runtime
  implementation and phase acceptance remain pending.

For every completed slice, record the exact changed boundary, source revision,
focused commands and outcomes, browser or performance artifacts where required,
failures and resolutions, and remaining limitations. Advance the phase cursor
only after every acceptance item has final-source evidence.
