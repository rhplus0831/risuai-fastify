# Remote Diagnostics Status

Date: 2026-09-08

## Current Cursor

Planning baseline prepared. Implementation has not started; no phase is
accepted. Source anchor: `5dc64f6f239b6dc1c95cd3f86d3c05b8802831d5`.

Next implementation action: read [PLAN.md](PLAN.md), confirm the
[inventory](inventory.md) against current source, and execute
[Phase 0](phases/phase-0-contract-and-inventory.md). Freeze the credential/API
matrix, event field policy, compatibility approach, and bounded operational
defaults before the first Phase 1 implementation slice.

## Phase Router

| Phase                                     | Status  | Acceptance evidence                                                             |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------- |
| 0. Contract and inventory                 | Pending | Planning source observations only; implementation decisions remain to be closed |
| 1. Remote access                          | Pending | None                                                                            |
| 2. Diagnostic depth and durability        | Pending | None                                                                            |
| 3. Browser evidence                       | Pending | None                                                                            |
| 4. Verification and operational readiness | Pending | None                                                                            |

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

## Outstanding Implementation Decisions

- Finite retention, byte/count/queue/query/rate limits and expiry defaults.
- Credential provisioning/revocation owner and protected storage layout.
- Version negotiation preserving the current exact v1 browser contract.
- Diagnostic journal placement, cursor semantics, data-replacement cleanup,
  and restart-safe operation correlation.
- Browser batch identity, opt-in advertisement, provenance and deduplication.

Phase 0 resolves these through source and synthetic evidence within the plan's
invariants. Production hostname, plaintext credentials, deployment flags, and
an actual incident sample are not needed to write or implement the plan locally.
