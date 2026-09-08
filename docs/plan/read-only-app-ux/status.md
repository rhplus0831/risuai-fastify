# Read-Only App UX Status

## Current Cursor

- State: planning package prepared; implementation has not started.
- Next phase: [Phase 0 — contract and inventory](phases/phase-0-contract-and-inventory.md).
- Next bounded slice: complete the route/action entry matrix and specify the
  shared-view inputs, reader selection owner, and committed navigation fields.
- Source baseline reviewed: `982eef6112a407d138ea6a77ebc638c8058edfe2`.
- Fixed scope: Settings, plugin panels, and interactive scripts are inaccessible
  to readers through controls, routes, shortcuts, restored UI, and callbacks.
- No phase is accepted by creating these planning documents.

## Document Map

- [PLAN.md](PLAN.md): stable product contract, invariants, rollout, and completion criteria.
- [Inventory](inventory.md): source owners, known integration boundaries, and focused test entry points.
- [Phase index](phases/README.md): bounded work and explicit plan validation.
- [Active plans](../README.md): repository planning index.

## Phase Ledger

| Phase                                                                                        | State   | Acceptance evidence |
| -------------------------------------------------------------------------------------------- | ------- | ------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                        | Pending | —                   |
| [1. Reader boundary and navigation data](phases/phase-1-reader-boundary-and-data.md)         | Pending | —                   |
| [2. Shared shell and navigation](phases/phase-2-shared-shell-and-navigation.md)              | Pending | —                   |
| [3. Shared transcript and passive display](phases/phase-3-transcript-and-passive-display.md) | Pending | —                   |
| [4. Lifecycle and action containment](phases/phase-4-lifecycle-and-containment.md)           | Pending | —                   |
| [5. Verification and rollout](phases/phase-5-verification-and-rollout.md)                    | Pending | —                   |

## Decisions

- 2026-09-08: adopt the repository's stable plan, single progress ledger, inventory,
  and bounded phase-document structure.
- 2026-09-08: reuse the existing app's presentation around the connected-reader
  controller and committed projections. Keep `ReaderTranscript` as the first
  reader transcript owner; extract the normal shell's reusable view boundaries.
- 2026-09-08: Settings, plugin panels, and interactive scripts are hard exclusions,
  including interactive scripts that only affect local state. Display-setting
  reads and existing isolated server display transforms remain permitted.
- 2026-09-08: block direct restricted routes before loading/mounting authoring UI;
  show a localized gate in the shared shell with safe reading navigation. Blocked
  in-app actions preserve the reader selection and never trigger takeover.
- 2026-09-08: retain current reader authority and takeover/recovery machinery.
  Any temporary presentation switch is separate from reader-authority rollout.

## Verification Ledger

### Investigation baseline

The earlier source investigation ran these existing focused suites successfully:

| Command                                                   | Result    |
| --------------------------------------------------------- | --------- |
| `pnpm test -- src/lib/ObserverShell.svelte.test.ts`       | 26 passed |
| `pnpm test -- src/lib/ReaderTranscript.svelte.test.ts`    | 27 passed |
| `pnpm test -- src/ts/readerLocalMutations.svelte.test.ts` | 9 passed  |

These 62 tests verify the existing reader foundation, not the proposed shared
interface. The investigation cross-checked cited source after concurrent
repository changes. No new runtime implementation, shared-view browser proof,
or production verification is claimed by this baseline.

### Planning package

- 2026-09-08: `pnpm check:docs` passed for 49 current documents.
- 2026-09-08: the exact [explicit plan/index command](phases/README.md#plan-document-validation)
  passed for all 11 planning/index documents with no link, anchor, source-path,
  or index errors.
- 2026-09-08: `pnpm exec prettier --ignore-path /dev/null --check docs/plan/README.md 'docs/plan/read-only-app-ux/**/*.md'`
  and `git diff --check` passed.
- Consistency review confirmed all six phases are pending, restricted surfaces
  stay excluded in every phase, and access guards precede shared UI exposure.
  Runtime source is unchanged; no runtime suites or browser journeys were run
  for this documentation-only change.

## Progress Record

- 2026-09-08: prepared the stable contract, source inventory, six phase documents,
  and active-plan entry. The next work is Phase 0; all implementation remains pending.

For each completed slice, record the exact changed boundary and source revision,
commands, outcomes, relevant browser evidence, and remaining limitations here.
Record failures and their resolution without describing an unrun check as passed.
Advance the cursor and accept a phase only when its checks are evidenced. Keep
phase documents focused on work and acceptance; do not copy progress into them.
