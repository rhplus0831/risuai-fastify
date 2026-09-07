# Phase 4: Verification and Closeout

Dependency: Phases 0–3 accepted. Progress belongs in [status](../status.md).

## Outcome

Reconcile the reviewed suite, final implementation, and actual execution
evidence without overstating what a build, discovery pass, or historical result
proves.

## Work

1. Re-run discovery at the final source. Reconcile every spec/title/subjourney,
   support owner, conditional matrix, and removed/replaced contract against the
   inventory. No target test count is required; changes need explanations.
2. Check all findings for the named contract, source, failure experiment, restored
   pass, and remaining limit. Ensure critical journeys have the required browser
   fault-detection evidence and none has an open high-risk gap.
3. Run focused specs for changed contracts and affected shared-helper consumers.
   Recheck independence or repeat a scheduling-sensitive scenario only when
   changes, failures, or unresolved ordering concerns justify it. Use declared
   observation conditions; do not retry until one green run appears.
4. When implementation is complete, run `pnpm test:agent`. At the end of Phase 4,
   the implementing agent must also run `pnpm test:all` without additional user
   consent, following the [per-phase policy](../PLAN.md#validation-and-completion).
   Record the tested source, command, result, exclusions, and full-browser lane
   outcome from that run. Collect matching Quality `smoke` evidence from
   `.github/workflows/quality.yml` when available, including its run URL and
   source identity. CI evidence supplements the required phase execution; its
   absence does not transfer execution back to the user. Do not treat evidence
   from a different implementation as equivalent.
5. Validate changed current documentation with `pnpm check:docs`, explicitly
   validate all active-plan links/paths as described in the plan, format changed
   Markdown with the ignore override, and check whitespace.
6. Publish a compact final finding table: repaired, retained with accurate scope,
   disproved, or deferred with owner/impact/revisit condition. Keep the supported
   browser/provider/device/timing envelope explicit.

## Acceptance Evidence

| Claim                       | Required evidence                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Suite reviewed              | Final discovery and complete scenario/control dispositions                                                                |
| A regression is effective   | Same test passes fixed behavior, fails its named production fault at the relevant assertion, and passes after restoration |
| Shared repair is safe       | Reviewed consumers and their focused browser results                                                                      |
| Critical journeys protected | Four Phase 2 contracts have browser-specific fault detection and no open high-risk gap                                    |
| Agent checks passed         | Final `pnpm test:agent` result with its actual lane limits                                                                |
| Full phase checks passed    | Agent-run `pnpm test:all`, including full browser execution, at the final implementation source                           |
| Evidence remains usable     | Checked-in fault/reproduction details and accurate current guides                                                         |

If full browser verification is unavailable, record
implementation-complete/verification-pending and the exact missing evidence.
Keep the implementing agent as the follow-up owner and name the concrete
prerequisite or repair needed in status; do not leave a generic unowned
verification blocker or request routine consent to run the authorized command.
Do not mark the workstream complete or archive it on the strength of a smoke
build or an earlier source's passing browser run.

## Archive

Only after acceptance, move the intact workstream under
`.archived-docs/performance-and-stability`, repair relative links, update that
archive's index, and remove its active-plan entry. Preserve the original scope,
final execution cursor, inventory, findings, and reproducible evidence. Revalidate
the moved documentation and current indexes. Routine archival documentation
does not replace or extend the final behavioral evidence.
