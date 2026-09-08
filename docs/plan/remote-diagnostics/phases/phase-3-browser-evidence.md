# Phase 3: Browser Evidence

Dependency: Phase 2 journal/event/version contracts accepted. Owners: inventory
D01–D04, D08–D09, D11. Progress belongs in [status](../status.md).

## Outcome

The support read API includes opted-in browser evidence linked to relevant
server work, while ordinary authenticated readers and writers retain their
existing behavior and manual report export.

## Bounded Slices

### 3a. Opt-in and ingestion contract

- Advertise a separate supported upload capability through normal authenticated
  bootstrap. Missing/incompatible opt-in sends nothing. Keep the existing
  Diagnostics v1 configuration compatible.
- Add an ordinary-app-authenticated bounded upload route; do not require active
  writer ownership. A support credential cannot upload or spoof an app session.
- Validate the complete batch before storing, stamp server receive time/source
  provenance, and enforce per-event, per-batch, per-source, and rate limits.
  A client cannot claim server origin or assign trusted operation identity.
- Reject unknown/content-bearing fields without echoing them. Suppress raw
  request-body tracing for this route even on invalid/unauthenticated input.

### 3b. Publisher lifecycle and correlation

- Publish only entries already projected at browser capture. Use bounded
  queues/batches, finite retry/age rules, event identities and bounded server
  deduplication. Clear pending context on auth loss, opt-out, and data/session
  changes; cancel stale in-flight work.
- Exclude diagnostic read/upload and upload-related failures from recursive
  publishing. Upload failure cannot block fetch, bootstrap, generation,
  recovery, mutation, or reader/writer transitions.
- Preserve per-source ordering across reload where appropriate and distinguish
  tab/instance identities without raw session/user/domain IDs. Treat timestamps
  and request associations as client assertions; expose skew/gaps honestly.
- Reuse current startup telemetry where useful without publishing duplicate
  startup events through both transports.

### 3c. Joined reads and manual reports

- Merge persisted browser/server events in support results with clear source,
  availability, and ordering semantics. Do not claim browser coverage if no
  browser uploaded within the selected window.
- Deduplicate local versus uploaded browser events in the existing panel/report.
  Preserve refresh failure handling, download/copy, and mobile selectable-text
  fallback. Put any new user-facing strings in language files.

## Acceptance and Evidence

- DOM tests prove opt-in/opt-out, old/new server compatibility, auth loss,
  reader uploads, queue bounds, retry/reload deduplication, and no upload loops.
- Early pre-bootstrap events upload once after valid opt-in; missing or
  incompatible opt-in sends nothing. Retry handling preserves distinct events,
  bounds network/5xx backoff, and does not retry permanent validation/auth
  failures indefinitely.
- Server tests reject forged provenance, invalid batches, support-token uploads,
  and limits; rejected canaries never enter the journal or raw transport traces.
- A focused real-browser synthetic journey records a browser failure, uploads
  it through actual app authentication, and retrieves it with the support
  helper credential. Prove request correlation and keep content canaries absent.
- Offline, delayed, duplicated, and unavailable-server cases preserve app
  behavior and produce honest partial evidence. Existing manual report UI
  remains usable and does not duplicate browser events.

Use the owning DOM/route/schema suites and the focused browser-smoke journey
through `pnpm test -- <one-test-or-source-file>`. Run the required cross-layer
aggregate after the completed implementation batch. Do not use real browser
profiles, production credentials, or cloned human data as fixtures.
