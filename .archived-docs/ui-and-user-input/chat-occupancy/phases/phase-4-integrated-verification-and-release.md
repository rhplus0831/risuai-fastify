# Phase 4: Integrated Verification and Release

Dependency: Phase 3 accepted and committed. Boundaries: B01-B10 and T01-T11.
Read [PLAN.md](../PLAN.md) and [status](../status.md).

## Outcome

The complete feature is proven across devices, the existing owner experience
remains usable, and current documentation accurately describes shipped behavior.
No unresolved implementation work is hidden by closeout or archival.

## Work

### 4a. Combined behavioral proof

- Run the complete T01-T11 matrix on real separate sessions and disposable data.
  Include owner plus chat-only, two chat-only senders with a third owner,
  additional observers, same-chat contention, and simultaneous provider work.
- Exercise required Reroll, retained occupancy through navigation/observation,
  and explicit cross-chat mutation switching. Verify continue/regenerate remain
  visibly deferred in chat-only mode without regressing their owner paths.
- Combine delayed/lost responses, mobile suspension, owner switching,
  general-owner preference settings, pending effects, and destructive-operation
  boundaries rather than relying only on isolated happy-path tests.
- Assert actual persisted message identity and forbidden shared-write absence.
  Audit new/changed tests using the project test-quality guidance; every claimed
  UI behavior needs rendered/interaction evidence at the appropriate boundary.
- Verify deletion, reset, and restore reject the complete operation when any
  affected chat is occupied and identify conflicts plus the safe release path.
- Verify the current global revision retry limit under the intended small-device
  concurrency. Exhaustion must retain/report intent correctly; change retry
  policy only with evidence, without generic blind rebasing.

### 4b. Rollout and compatibility

- Verify the negotiated feature-disabled and feature-enabled paths, stale/older
  clients, startup/migration, restart, and the agreed rollback/drain procedure.
- Enable the coherent feature only after its server guards, client admission,
  recovery, and effect policy are all present. Keep no partial combination that
  admits writes without finalization or recovery protection.
- Confirm occupancy discovery/revalidation has bounded work and no unnecessary
  whole-application reload on ordinary unrelated chat events. Investigate actual
  regressions with focused measurements; do not introduce a broad benchmark task.

### 4c. Documentation and archival

- Update the current data/events, mutation recovery, bootstrap/resource,
  generation-client, UI, route-policy, and test guides affected by shipped work.
  Update the single-writer invariant wording to distinguish one general owner
  from per-chat occupancy. Preserve current docs as source-backed guidance.
- Record exact unsupported chat-only interactions and recovery semantics for
  users and maintainers. Report provider/physical-device validation limits.
- Prepare the complete package and active/archive index changes for its final
  archive location. Validate links and literal paths after the move; record the
  full phase ledger and evidence in the archived status document.

## Exit Criteria

- All required proof IDs have executed final-source evidence; allowed feature
  dispositions are explicit and consistent with the multi-device send objective.
- No known owner/occupancy bypass, duplicate/lost-result path, or unfinished
  effect/recovery work remains.
- Final docs and archive indexes pass validation. Existing owner behavior and
  supported desktop/mobile chat-only behavior are verified.

Run the [mandatory completion gate](../PLAN.md#mandatory-phase-completion-gate)
after implementation and planned closeout edits: `pnpm test:all`, independent
GPT 6 Astra High review, confirmed fixes and full revalidation/review as needed,
final status evidence, and a conventional completion commit with the required
co-author trailer. Passing a build is not browser-runtime proof. Archival is not
permission to deploy to production.
