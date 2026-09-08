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

## Implementation Contract (2026-09-08)

The user's implementation request supersedes the planning-only baseline. No
production deployment or production credential provisioning is included.

### Authority and storage

| Caller                                    | Support GET                  | Browser upload               | Protected application routes | Public routes            |
| ----------------------------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ------------------------ |
| Valid support bearer                      | Yes, when explicitly enabled | No                           | No authority                 | Existing public behavior |
| Missing, invalid, expired, revoked bearer | No                           | Ordinary app auth required   | Ordinary app auth required   | Existing public behavior |
| Ordinary app reader or writer             | No                           | Yes, when upload enabled     | Existing app policy          | Existing public behavior |
| No password or development auth bypass    | No                           | Existing ordinary app policy | Existing ordinary app policy | Existing public behavior |

The verifier lives in an operator-selected private directory outside the data,
static, and repository roots. It contains at most 16 environment records and
only SHA-256 digests, random credential IDs, created/expiry/revocation times.
Minting writes a new exclusive mode-0600 local configuration file; stdout never
contains a token. Default lifetime is 30 days (maximum 90 days); rotation caps
old-key overlap at 24 hours. Reads revalidate the bounded verifier file so
revocation applies on the next request. Configuration failures fail closed.

The journal is a dedicated diagnostics store, excluded from domain backups and
exports. It is fenced by authoritative database lineage and cleared on reset or
replacement, including restart detection. Its telemetry writes never alter
revision, writer, receipt, or event state. Plaintext helper configuration is
outside the repository and frontend, with an immutable configured HTTPS origin.

### Wire and limits

`GET /api/v1/support/diagnostics` negotiates `version=1` (default, existing
projected events) or `version=2` (new exact event families). Existing
`GET /api/v1/diagnostics` and `clientDiagnostics: { version: 1 }` stay compatible.
The remote envelope contains version, server time/build/instance, validated
sequenced entries, source availability, capture bounds, loss counters, and
pagination. Unknown keys and invalid versions fail closed. Error bodies use
only fixed categories: disabled, unauthorized, invalid-query, rate-limited,
collection-disabled, cursor-expired, storage-unavailable, internal-error.
Successful empty results use 200 with an empty list; all outcomes use no-store.

Accepted query keys are version, from, to, limit, requestUid, operationRef,
category, and cursor. Times are epoch milliseconds, with a maximum 24-hour
window and a default last hour; no free-text filters. Request UIDs are generated
64-hex references; operation references are independent 32-hex random values.
Default page size is 50, maximum 200. Cursors are opaque random references to
immutable bounded snapshots, expire after 5 minutes, and are invalidated on
history replacement. Snapshot admission caps at 32 concurrent snapshots,
2,000 entries and 2 MiB each. Truncation is explicit; concurrent appends do not
change pages. Cursor continuation accepts only cursor and version.

Reads allow 30 requests/minute per IP with a 10-second request deadline and a
512-KiB response ceiling; query strings cap at 2 KiB. The helper uses a
10-second timeout, rejects redirects, requires JSON, validates the complete
response before printing, and bounds compressed and expanded responses to
512 KiB. TLS certificate verification remains enabled.

Journal defaults: 24-hour age, 10,000 events, 8 MiB retained bytes, 4-KiB maximum
record, 256 queued records, at most one storage write in flight. Startup and
normal pruning revalidate exact records. A stalled or failed store reports loss
and availability without blocking application work; shutdown has a finite
flush deadline. Synthetic 4-KiB records make the byte cap tighter than the event
cap; small 300-byte events make the count cap tighter. No config can disable
these hard bounds.

Browser upload is separately enabled and versioned. Use generated per-tab
source identity and stable per-event identity, bounded batches of 32 events and
64 KiB, at most 256 pending events, a 5-second cadence, a 5-minute pending age,
and three attempts with bounded backoff. Server provenance and receive time
are authoritative; browser time and request associations remain assertions.
Deduplication is bounded by journal retention. Missing/incompatible capability,
auth loss, opt-out, or history change clears pending context and cancels work.

### Field policy and ownership

Every event family has a fixed discriminator and exact keys. Fields are fixed
enums, nonnegative bounded durations/counts, operational booleans, or generated
references. Sizes/counts use buckets where exact values add little value;
prompt roles, media/memory/lore counts and token budgets retain bounded counts
for structural diagnosis. Unknown provider/hook/outcome labels map to explicit
unknown categories or are omitted. Arbitrary code coordinates are omitted from
remote output unless tied to a validated build coordinate catalog. No bodies,
text hashes, domain IDs, custom names, dynamic keys, snippets, or error messages
enter remote records. Projection happens before buffering and is repeated on
read/restoration/export; uploaded objects require complete exact validation.

Source owners remain D01–D11 in the inventory. First implementation slices add
`remoteDiagnostics` protocol/auth/read/helper modules and focused schema,
support-auth, support-route, and helper tests in their normal protocol, server,
and utility suites. Journal and browser publisher have separate focused owners;
combined synthetic and browser tests exercise actual fetched failure evidence.
