# Phase 0: Contract and Inventory

Dependency: planning baseline. Progress belongs in [status](../status.md).

## Outcome

Turn the [product contract](../PLAN.md#product-contract) and
[inventory](../inventory.md) into a bounded implementation map. Resolve routine
design choices before Phase 1; do not connect to production or enable access.

## Work

1. Recheck the source anchor and D01–D11. Inventory route admission, static/file
   exposure, backup/reset/replace behavior, raw trace/logger hooks, collector
   subscribers, and test discovery. Record each boundary's disposition and
   owner rather than claiming an exhaustive audit from the seed map.
2. Define an authorization matrix for missing/invalid/expired/revoked support
   tokens, valid support tokens, ordinary app sessions, uninitialized servers,
   development bypass, and reader/writer clients. Cover reads, browser uploads,
   normal protected routes, and intentional public routes.
3. Freeze the support envelope, finite query grammar, failure codes, version
   negotiation, source provenance, and Phase 1 volatile cursor behavior.
   Specify the later journal cursor/restart/retention contract without assuming
   wall clocks provide a global ordering.
4. Classify each first-release event field: enum, bounded number, generated
   correlation reference, approved code coordinate, or prohibited. Choose
   exact-vs-bucketed values by their debugging purpose. Specify what is omitted
   when a provider/extension supplies an unknown string.
5. Choose concrete defaults for key lifetime/overlap, read limits, rate limits,
   maximum event/response/batch bytes, journal age/count/bytes/queue, and upload
   cadence/retries. Use bounded synthetic workloads; invalid configuration must
   not create an unbounded or unauthenticated mode.
6. Select verifier/journal/config placement, operator provisioning and revocation
   mechanics, shutdown/startup handling, and authoritative data reset/replacement
   cleanup. Ensure backups, projections, and frontend config cannot publish
   support credentials or journal contents unintentionally.
7. Name tests for access denial, canary exclusion, useful failure evidence,
   version skew, resource limits, and collector failure isolation. Define the
   first Phase 1 slice and its exact source/test owners.

## Acceptance

- In-scope boundaries have dispositions; privacy/auth policy is testable.
- Defaults and lifecycle decisions are recorded in the plan/inventory with
  rationale; none rely on a production secret or a manual per-read approval.
- New route policy/catalog representation expresses diagnostics authority
  without making the credential valid for ordinary application auth.
- Existing v1 clients have an explicit compatibility path.
- Phase 1 can start as a small credential/read/helper implementation without
  waiting for the full instrumentation or browser work.

Validate documents and run existing baseline tests only to resolve a concrete
uncertainty. Do not mark implementation behaviors verified from source review.
