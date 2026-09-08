# Remote Diagnostics Status

Date: 2026-09-08

Stable scope: [plan](PLAN.md). Source owners: [inventory](inventory.md).

## Current Cursor

Phase 0 source cross-check and implementation contract are complete. Phase 1
is implementing isolated credential lifecycle, versioned remote reads, and the
fixed-origin helper. See the Phase 0 document for defaults and authority matrix.

## Phase Router

| Phase                                     | Status      | Acceptance evidence                                                                  |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| 0. Contract and inventory                 | Accepted    | Four successful Luna source reviews reconciled; bounded contract recorded in Phase 0 |
| 1. Remote access                          | In progress | Credential and remote read slices underway                                           |
| 2. Diagnostic depth and durability        | Pending     | None                                                                                 |
| 3. Browser evidence                       | Pending     | None                                                                                 |
| 4. Verification and operational readiness | Pending     | None                                                                                 |

## Decisions and Scope

- 2026-09-08: The user wants richer debugging evidence while keeping chat and
  prompt preset text inaccessible to the agent. Extend the existing sanitized
  Diagnostics channel; raw request/history/generation/Lua artifacts remain
  outside agent access.
- 2026-09-08: Add on-demand production retrieval from the development
  environment with a separately provisioned diagnostics-only credential. Use
  a random bearer token over HTTPS with server-side digest storage. Preserve
  manual export as fallback; no per-read manual export workflow is required.
- 2026-09-08: Use a stable plan, mutable status, and five bounded phases. Phase 1
  must be useful with existing server events before later evidence expansion.
- 2026-09-08: The requested deliverable for this task is the planning package.
  No feature code, deployment, real token generation, or production connection
  is part of this change.
- Default field policy excludes original text, content hashes, raw domain IDs,
  arbitrary labels, and previews. Retain approved counts/categories and
  generated diagnostic correlation references only.

## Verification Ledger

| Scope                       | Result                                                                                                                                                    | Limit                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Planning source review      | Existing collector, schemas, auth, traces, metric adapter, and browser-local storage inspected at the opening source                                      | Static local evidence; remote version/configuration unverified          |
| Parallel source cross-check | Two Luna reviews succeeded; auth/route and browser/instrumentation findings reconciled against source                                                     | Read-only planning input; no implementation acceptance                  |
| Current documentation       | `pnpm check:docs` passed for 49 current documents                                                                                                         | The default set excludes active plan directories                        |
| Plan package                | [Explicit plan/index check](phases/README.md#plan-document-validation) passed for all 10 documents; explicit Prettier check and `git diff --check` passed | Documentation integrity only; no feature tests or production checks run |

Record completed slices here with source/commit when available, affected
boundaries, exact commands/results, acceptance criteria satisfied, residual
limits, and the next action. Update stable contracts in the plan and phase
documents when a decision changes them; do not duplicate execution logs there.

## Implementation Decisions and Evidence

- The implementation request authorizes feature work; the planning-only scope
  above is historical. No production connection, deployment, or real access
  provisioning is needed for local acceptance.
- Four read-only Luna reviews completed successfully (auth/trace,
  journal/correlation, browser contracts, coverage producers). Source confirmed
  separate app auth, trace capture before validation, explicit route limits,
  UID eviction/background gaps, and sentinel-zero timing in bootstrap and prompt
  assembly. Browser worker suggestions for manual-only upload and content-digest
  identity were rejected: the approved plan requires opted-in automatic uploads
  and independent generated event identities.
- Phase 0 freezes authority, schema negotiation, retention/query/queue limits,
  credential placement/lifecycle, and first source/test owners. Journal snapshot
  pages use sequence ordering and bounded immutable snapshots; no clock-causality
  claim. No phase implementation is accepted solely from the source review.

Next: finish and validate Phase 1 credential/read/helper, then durable safe
families/correlation/journal, browser ingestion/publisher, and combined proof.

### Phase 1 credential and read slices

- Credential lifecycle committed as `8baed4751`; 31 focused synthetic tests and
  targeted strict TypeScript passed. No real credentials provisioned.
- Independent support GET, v1 envelope, finite shared query parser, immutable
  cursor pages, 300-event volatile source, fixed errors/access outcomes, and
  diagnostic namespace trace/log exclusions implemented. Auth denial derives
  from every registered protected route; deliberate public behavior is retained.
- `pnpm test -- server/fastify/__tests__/remoteDiagnostics.test.ts`: 6 passed.
  Protocol grammar/privacy: 3 passed. Reviewed route catalog: 5 passed.
  Existing route protection, collector, tracing, and config suites: 55 passed.
  `pnpm exec tsc -p server/fastify/tsconfig.json --noEmit` passed.
- Architecture inventory update contains only the reviewed 108→109 route/policy
  counts; inventory validation passed. Current docs (49), explicit plan docs
  (10), and relevant Prettier checks passed.
- Validation exposed and fixed delayed HTTP collection behind asynchronous raw
  trace writes and a rate-limit error mapping that initially returned 500.
  The denial test now enumerates live routes rather than abstract route families.
- HTTPS helper tests are complete in a separate pending slice. The cross-layer
  aggregate remains required after implementation/self-review and will be run
  on the completed final feature, together with final-source combined proof.
