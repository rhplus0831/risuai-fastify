# Remote Diagnostics Plan

Date: 2026-09-08

Read [status](status.md) for the current phase, next action, decisions, and
verification evidence. The implementation request supersedes the planning-only baseline.

## Objective and Document Ownership

Let an agent in the development environment retrieve useful debugging evidence
from the external production server on demand, without obtaining chat text,
prompt preset text, or credentials for ordinary application access. Preserve
the Advanced settings Diagnostics download/copy workflow as a fallback.

This plan owns stable behavior, scope, privacy invariants, dependencies, and
completion criteria. [Phase documents](phases/README.md) own bounded work and
acceptance checks. [Inventory](inventory.md) maps source and test owners.
Only `status.md` owns execution progress and validation results. Planning a
phase does not complete it. Current source, [STRUCTURE](../../../STRUCTURE.md),
and [architecture guides](../../structure/README.md) remain authoritative for
shipped behavior.

The current request authorizes completing all implementation phases. Production
deployment and real credential provisioning remain separate operations. Routine implementation choices listed in Phase 0 are work
to resolve from source and synthetic evidence, not new approval gates.

## Planning Baseline

Source anchor: `5dc64f6f239b6dc1c95cd3f86d3c05b8802831d5`.

- Diagnostics v1 uses an exact-key shared schema and repeats projection at
  collection, restoration, and export. Server events are a 300-entry in-memory
  buffer exposed through ordinary application authentication. Browser events
  remain in memory and tab-scoped session storage.
- Request tracing masks credential-like fields, but retains ordinary text,
  raw URL/caller/header values, inline bodies, and compressed sidecars.
  Oversized omitted bodies may retain previews. Generation and post-generation
  Lua sidecars are separate content-bearing artifacts.
- Several useful metric fields never reach Diagnostics. The collector requires
  a recognized request UID, selects few fields, and maps phase from a startup
  milestone. Background persistence/mutation paths can lack that UID. Some
  measurement initialization depends on protocol metrics being enabled even
  though Diagnostics can subscribe independently.
- There is no diagnostics-only production credential, remote fetch helper,
  durable safe journal, or general browser-diagnostics upload in this baseline.

These are source observations, not an audit of remote deployment settings or a
production incident reproduction. See the inventory for the owning files.

## Product Contract

### Agent access and credential boundary

Expose a dedicated read route, proposed as
`GET /api/v1/support/diagnostics`, backed exclusively by the sanitized collector
and, later, its bounded journal. Give each development environment a separate
credential with only `diagnostics:read` authority. Provisioning establishes
ongoing access to retained sanitized evidence; individual reads do not require
manual exports or one-off incident approval.

- Generate 32 cryptographically random bytes, encoded as Base64URL or hex.
  Store only the SHA-256 token digest and bounded lifecycle metadata on the
  server. Verify well-formed tokens with a constant-time digest comparison.
  Send the original token in the HTTPS `Authorization: Bearer` header.
- Keep the verifier outside normal application sessions, settings projections,
  bootstrap payloads, and domain backups/exports. Do not add support tokens to
  the ordinary auth token registry or make `requireAuth` accept them.
- Require explicit server configuration and a valid, non-expired, non-revoked
  credential. Ordinary browser auth, missing application passwords, development
  auth bypass, and writer ownership never authorize this route.
- Support operator provisioning, expiration, rotation with bounded overlap,
  revocation, and disabling the feature. No credential-management UI or remote
  administration permission is required for the first implementation.
- Set route-specific request limits, timeouts, and rate limits. Record bounded
  access outcomes without the token, digest, original headers, or raw URL.

The support credential grants no authority to read chats, presets, settings, request history,
raw traces, logs, sidecars, assets, exports, backups, or arbitrary files. It
cannot submit browser telemetry, mutate domain state, take writer ownership,
run code, enable raw logging, or change diagnostic policy. Existing deliberately
public routes retain their public behavior; they must not treat this credential
as application authentication.

### Remote read contract and local helper

Use an exact, versioned response envelope containing validated entries,
pagination, capture range, server build/instance identity, source availability,
and explicit truncation/loss information. Permit only bounded time windows,
request/operation references, approved event categories, limits, and cursors.
Reject unknown filters and invalid values. No free-text query, SQL, file path,
regular expression, `raw` option, or caller-selected output fields are allowed.

Start Phase 1 with today's v1 events and an explicit volatile/server-only
coverage description. Phase 2 introduces richer event contracts through
version negotiation or a separate versioned representation. Never label a v2
payload as v1 or silently relax an older exact-key schema.

Return `Cache-Control: no-store`. Authentication, validation, throttling,
disabled collection, expired cursors, unavailable storage, and successful empty
windows must have distinguishable documented outcomes without echoing input.
Use sequence/cursor ordering within a source; clocks do not prove causal order.
Concurrent appends and retention must not silently skip or duplicate pages.

Provide a local package-script helper, proposed as `pnpm diagnostics:remote`,
that reads an operator-configured credential file and a fixed HTTPS origin.
It must validate query arguments and the response schema, enforce timeout and
response-byte limits, reject redirects and unexpected content types, and print
only validated results or fixed error categories. Do not print remote HTML,
arbitrary error bodies, headers, or the credential on failure. Never disable
TLS certificate verification or accept an arbitrary destination per request.

Keep the plaintext credential out of Git, command arguments, browser bundles,
ordinary stdout/stderr, and generated artifacts. A helper reduces accidental
exposure; it does not conceal a file from an agent with unrestricted shell
access. Server-side least privilege remains the access boundary. Separate
credential brokers or mutual TLS are optional later work.

### Content policy

Create metadata from known application facts before buffering, persistence,
or transport; validate again on restoration, read, and export. Each event family
has its own exact-key schema, fixed enums, provenance, and numeric/array bounds.
Never forward an arbitrary object because its current contents appear safe.

| Input                                                                                   | Shared representation                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Chat, preset, prompt, response, reasoning, tool argument/result, script or Lua log text | Omitted; selected counts, outcomes, and changed/unchanged results only                                                               |
| Request/response bodies and unknown/malformed payloads                                  | Explicit approved structural facts, type/size buckets, fixed validation categories; no textual fallback                              |
| URL/path parameters, query values, referrer, caller, arbitrary headers                  | Fixed route/method/transport identifiers; no original values                                                                         |
| Domain IDs, titles, filenames, profile names, custom model/endpoint labels              | Omitted or replaced with approved operation-local references and closed catalog categories                                           |
| Prompt/content/media hashes, token IDs, embeddings, snippets, previews, sidecar paths   | Excluded; content equality may be computed locally as a boolean                                                                      |
| Errors, stacks, plugin-generated locations                                              | Fixed failure codes and validated application code coordinates associated with a build; no original messages or dynamic code strings |
| Settings                                                                                | Only explicitly enumerated operational flags and bounded non-text parameters needed for a documented diagnostic purpose              |

Reuse generated request UIDs and independent diagnostic operation references.
Do not export the private mapping to chat/preset records. Use buckets where
exact sizes/counts add little diagnostic value. Metadata intentionally reveals
limited execution/shape information; it is not a guarantee of zero inference
against malicious producers or a compromised production process.

Raw tracing and Request History remain operator-only surfaces. This work builds
safe request summaries from approved facts; it does not import raw JSONL, open
sidecars, or parse request-history rows on the support read path. Any future
legacy-trace conversion is separate work performed within a trusted boundary.
New diagnostics read/upload routes must also avoid capturing their payloads or
credential-bearing input through existing tracing/logging hooks, including
rejected requests.

### Journal, correlation, and failure isolation

Persist only validated diagnostics in a dedicated store separated from domain
records and auth secrets. Do not grant the agent database or filesystem access.
Set finite age, event-count, byte, queue, and record-size limits, prune during
normal operation and startup, and account for gaps and rejected/dropped events.
Phase 0 selects concrete defaults and the storage layout from synthetic costs.

Journal writes are operational telemetry: they do not advance domain revisions,
emit mutation events, acquire writer ownership, or affect command acceptance.
Slow/full/unavailable storage must not block generation, mutate domain state,
or cause fallback to raw logs. Recovery, close, and read behavior remain bounded.
Clear retained diagnostics and provenance when authoritative data is reset or
replaced so evidence from unrelated database histories cannot be mixed.

Propagate correlation through generation, provider attempts, persistence, jobs,
and recovery; do not simply remove the current app-scoping guard. Support
background events without a live HTTP request and make correlation loss
explicit. Use monotonic durations and source sequence numbers, with server
receive time for browser events and honest clock-skew/availability metadata.

### Diagnostic coverage

| Family                          | Required first-release evidence                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment and collection       | Frontend/server build identities, schema versions, fixed feature flags, restart markers, source availability, capture ranges, losses                                        |
| HTTP and provider transport     | Route/status/error category, bounded sizes and duration, provider adapter category, retry/cancellation origin, time to headers/first token, stream gaps and terminal reason |
| Generation and prompt structure | Stage/outcome/duration, role/count structure, token budget and truncation, media counts, memory/lorebook selection counts                                                   |
| Persistence and recovery        | Journal/commit/cleanup status, retry disposition, fixed failure phase, queue age/depth, contention and revision-gap facts                                                   |
| Browser state                   | Startup/hydration/cache outcome, reader/writer state, reconnect/stale-response rejection, queued intent count/age                                                           |
| Script/plugin execution         | Hook category, run/duration/failure counts, allowed/blocked call counts, output/transcript changed flags                                                                    |

### Browser evidence and manual export

Add a separate versioned bootstrap opt-in and ordinary-app-authenticated upload
route for already-sanitized browser events. Authenticated readers may submit
diagnostics without acquiring writer ownership. Support read credentials cannot
write events and must never be delivered to a browser.

Use bounded batches, bounded pending work, deduplication, and best-effort
delivery. Opt-out, auth loss, and incompatible servers stop uploads and clear
pending sensitive-session context. Upload/read traffic must not recursively
generate upload traffic. A reload or retry must not multiply the same events.
The server stamps source provenance; uploaded records cannot impersonate server
events or choose trusted operation identity. Browser timestamps and associations
remain client assertions rather than proof of server activity.

Preserve current download/copy/mobile fallback, including server-unavailable
reports. Combine local and uploaded browser evidence without duplicates.
Maintain old/new client-server compatibility and keep diagnostic failures out
of readiness, mutation, generation, and recovery critical paths. User-visible
strings belong in `src/lang`.

## Phase Order

| Phase                                                                                     | Outcome                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [0. Contract and inventory](phases/phase-0-contract-and-inventory.md)                     | Bounded API, field/auth matrices, defaults, source/test ownership, and first implementation slice |
| [1. Remote access](phases/phase-1-remote-access.md)                                       | Working dedicated credential, bounded server-only read endpoint, and local helper                 |
| [2. Diagnostic depth and durability](phases/phase-2-depth-and-durability.md)              | Rich safe events, corrected measurement/correlation, and a persistent bounded journal             |
| [3. Browser evidence](phases/phase-3-browser-evidence.md)                                 | Opted-in upload and useful combined browser/server evidence                                       |
| [4. Verification and operational readiness](phases/phase-4-verification-and-readiness.md) | Combined failure/privacy/access proof, operator docs, and rollout/rollback readiness              |

## Validation and Completion

Every implementation phase includes privacy, authorization, and diagnostic
usefulness tests appropriate to its boundary. Phase 4 combines the evidence; it
is not the first privacy check. Use fresh disposable synthetic fixtures and
mock providers. Do not clone human data for these checks; a development server,
if needed, uses `RISU_AGENT_DATA_MODE=fresh` with no production secrets.

Follow root [AGENTS.md](../../../AGENTS.md) test ownership: focused tests during
implementation, `pnpm test:agent` after a completed cross-layer implementation
batch warrants it, and no `pnpm test:all` unless the user explicitly requests it.
This workstream does not inherit another archived plan's full-suite exceptions.
Documentation-only changes run documentation/link/format checks, including
explicit validation of plan files omitted from the default current-doc set.

Completion requires all five phase outcomes, zero synthetic content/credential
canaries in agent-readable outputs, denied support access to protected
non-diagnostic routes, and successful diagnosis of injected provider,
persistence/recovery, and browser failures using only the fetched evidence.
Cover invalid credentials, limits, restarts, retention, mixed versions,
disabled collection, and original application behavior. Record actual results
and remaining production limits in status; planned tests are not passing proof.

Update current observability/backend/security/test guides as implementation
lands. Provide operator setup, credential lifecycle, collection/retention,
availability, and safe-fetch instructions. Deployment is a separate operation;
the plan can reach locally verified readiness without claiming production
installation. Disabling support reads and browser uploads must restore the
previous manual workflow without altering user data or its revisions.

## Scope Limits

No arbitrary remote execution or content queries, general observability stack
migration, full raw-trace retrofit, automated LLM redaction of private data,
semantic prompt inspection, request-history ingestion, automatic production
deployment, or production-data cloning. A content-dependent bug may require a
trusted fixed local check or a user-authored synthetic reproduction. New event
families need a specific debugging purpose and a reviewed exact contract.
