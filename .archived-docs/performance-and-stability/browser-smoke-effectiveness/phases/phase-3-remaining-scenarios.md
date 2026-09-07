# Phase 3: Remaining Scenarios

Dependency: Phase 2 accepted. Progress belongs in [status](../status.md).

## Outcome

Complete the review of every remaining registered scenario, relevant
conditional matrix, and support owner. Preserve useful narrow tests while
repairing confirmed weaknesses and correcting overstated evidence claims.

## Review Clusters

| Cluster                                      | Starting owners                                                                                                            | Main questions                                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup, routes, and caches                  | `displayPaintCache.spec.ts`, `startupCachePopulationMatrix.spec.ts`, `startupDirectLinks.spec.ts`, `lazyFirstOpen.spec.ts` | Do direct links and cold/warm states come through actual startup? Does fixture setup skip the transition? Are route/asset/DOM assertions meaningful for every matrix row? |
| Locale and settings                          | `selectedLocaleStartup.spec.ts`, `selectedLocaleRuntime.spec.ts`, settings cases in `fastifyBrowserSmoke.spec.ts`          | Does selection exercise loading/failure/retry and visible text? Do authored values survive actual command settlement/reload rather than being preseeded?                  |
| Memory and authored content                  | `bardWikiLifecycle.spec.ts`, remaining authoring/import/backup cases                                                       | Which visible actions, API transitions, and persistence effects are real? Keep background-worker and external-service exclusions explicit.                                |
| Remaining transcript and responsive controls | Unreviewed scenarios in `transcriptResidency.spec.ts` and `fastifyBrowserSmoke.spec.ts`                                    | Do focus, selection/copy, search/jumps, drag/touch, viewport, and alert controls exercise their claimed entry paths? Which browser API simulations need narrower labels?  |
| Remaining support and ownership              | Unreviewed artifact readers, fixtures, snapshots, embedded helpers, and execution conditions                               | Is there unused/stale setup, cross-case state leakage, a missing evidence prerequisite, or an unjustified claim?                                                          |

Names in this table refer to `server/fastify/browser-smoke`. Use the scenario
inventory to avoid duplicate reviews of slices completed in Phase 2.

## Execution Rules

- Review all meaningful subjourneys before completing a large spec. Existing
  passing case totals do not constitute a review.
- Add adverse ordering/value variants only when tied to a specific plausible
  failure and production contract. Avoid arbitrary Cartesian-product matrices.
- For fixtures, distinguish producer provenance from a shared builder that simply
  supplies the same assumed shape everywhere. Preserve relevant omission/null,
  legacy, and serialization differences where they are part of the scenario.
- Retain lower-layer/API tests with accurate claims. Add a browser companion only
  when a real browser transition is necessary for the named missing evidence.
- Consolidate or split cases only when it improves isolation/failure ownership
  while retaining every protected contract. Do not optimize file or mock counts.
- Apply the full fault-detection requirement to each material repair. For an
  unchanged lower-risk scenario, retain the reviewed path, independent assertion,
  and scope limit without inventing a mandatory mutation campaign.

## Exit Criteria

- Inventory has no pending or partial owners; new/moved/deleted cases and
  conditional coverage are reconciled with discovery.
- Every confirmed required gap has a verified repair or a recorded scope
  disposition meeting the plan's rules. No omitted scenario is silently counted
  as reviewed or deferred work as fixed.
- Shared changes have focused consumer evidence; removed or merged tests have
  equivalent replacement and fixture/routing evidence.
- All product defects uncovered during review have separate, traceable
  dispositions and required regressions.
- Current documentation changes are limited to shipped behavior and execution
  claims; the planning ledger retains investigation history.
