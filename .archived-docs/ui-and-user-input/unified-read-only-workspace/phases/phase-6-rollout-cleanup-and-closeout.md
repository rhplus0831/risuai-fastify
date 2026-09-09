# Phase 6: Rollout Cleanup and Closeout

## Outcome

Make the role-first unified workspace the only connected-client path, remove
ObserverShell presentation/rollout scaffolding, update current documentation and
inventories, rerun focused final evidence, and archive the completed plan.

## Preconditions

- Phase 5 is accepted with final-source browser and performance evidence.
- The unified cohort satisfies rollout thresholds and has no known containment,
  accessibility, writer-regression, or lifecycle failure.
- Every observer-named non-presentation responsibility has a tested successor
  owner.

## Work

1. Promote the unified role-first path to the default and remove the temporary
   whole-path rollout branch.
2. Remove `ObserverShell.svelte` and obsolete ObserverShell fixtures/selectors/
   tests after migrating their behavioral assertions to the new workspace,
   navigation, transcript, composer, and promotion owners.
3. Remove or rename `ReaderTakeoverAction.svelte` after its accessible status,
   single-flight action, failure announcement, and focus behavior are owned by
   the top-right device component.
4. Retire `VITE_FAST_BOOTSTRAP_OBSERVER`, its smoke session-storage override,
   tests, build declarations, browser harness helpers, temporary-seam inventory,
   and flag-on/off artifact terminology when no current behavior depends on it.
5. Rename observer-specific route/projection/lifecycle/telemetry symbols only
   after separating presentation terminology from retained reader projection
   cleanup. Do not delete auth, cache, hydration, revision, lineage, reconnect,
   or writer-loss behavior as presentation cleanup.
6. Update telemetry schemas/consumers/tests and rollout documentation to the
   final role-first/workspace terminology. Remove temporary cohort fields when
   their decision window closes unless a stable operational use is explicitly
   documented.
7. Regenerate checked-in architecture/resource inventory baselines and review
   every count/change. Remove only true retired seams; do not mask unrelated
   drift.
8. Update current startup/resource, writer/recovery, UI, navigation, chat,
   generation, observability, testing, environment-variable, and generated/
   legacy documentation to match final source.
9. Run the final focused owner tests, relevant type/build checks, selected
   browser journeys, performance/bundle measurement, current-doc validation,
   explicit plan validation, formatting, and whitespace checks on final source.
10. Record final revisions, evidence, failures/resolutions, and residual limits
    in `status.md`. Move the complete package to the matching
    `.archived-docs/ui-and-user-input/` location, update archive indexes, and
    remove its active entry from `docs/plan/README.md`.

## Acceptance

- One production connected-client startup/presentation path remains; there is no
  ObserverShell compatibility branch or permanent rollout cross-product.
- ObserverShell presentation, bottom takeover duplication, obsolete DOM markers,
  flag/smoke overrides, and temporary inventory seams are removed.
- Reader projection, synchronization, passive display, generation observation,
  promotion, draft, auth, revision, lineage, cache, and writer-loss guarantees
  have explicit final owners and passing evidence.
- Tests assert product behavior and stable semantic selectors rather than
  obsolete component names.
- Current architecture/test/environment documentation matches final source and
  all documentation/index/literal-path validation passes.
- Final focused component/client/server checks, selected browser journeys, and
  Phase 0 performance/bundle thresholds pass under Crunch Mode.
- `status.md` contains the complete phase ledger and final evidence with no known
  required work omitted.
- The archived package and repository indexes validate, and the active-plan index
  accurately reports no remaining workstream entry.

## Focused Verification

Choose checks from the final changed-owner set; do not blindly repeat every
historical command. The minimum closeout evidence includes affected startup,
session/readiness, App/navigation/chat/composer, command/outbox denial,
writer-loss/auth/lineage, reader-generation, telemetry/inventory tests, relevant
type/build checks, selected reader/writer/startup browser journeys, the final
fast-bootstrap measurement, `pnpm check:docs`, explicit package/archive index
validation, Prettier, and `git diff --check`. Do not run `pnpm test:agent` or
`pnpm test:all`.

## Closeout

Archive only after current documents describe the shipped implementation and all
required evidence is recorded. The archived predecessor plans remain unchanged;
the new archive links to them as historical prerequisites and records only this
workstream's decisions and results.
