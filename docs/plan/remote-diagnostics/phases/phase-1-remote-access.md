# Phase 1: Remote Access

Dependency: Phase 0 contract accepted. Owners: inventory D01–D05, D10–D11.
Progress belongs in [status](../status.md).

## Outcome

A configured development helper can retrieve today's sanitized server events
from a dedicated support endpoint. The feature is useful with the existing
volatile buffer and reports that retention/browser coverage limitation.

## Bounded Slices

### 1a. Dedicated credential and configuration

- Implement the independent verifier and operator provisioning/rotation/revoke
  workflow selected in Phase 0. Persist only a token digest and bounded
  lifecycle metadata on the server; protect local plaintext credentials.
- Validate configuration and require explicit enablement. No ordinary app
  session, auth bypass, blank password, or writer state grants support access.
- Keep secrets out of bootstrap, settings, provider config, exports, backups,
  frontend bundles, command arguments, logs, and fixture artifacts.

### 1b. Bounded server read path

- Register the agreed route and policy/catalog entry with dedicated auth,
  explicit rate limits, finite queries, no-store headers, and safe errors.
- Read only projected collector entries. Bound pagination and response size;
  report buffer loss/reset and server-only availability rather than inventing
  history. Reject all unrecognized query options.
- Exclude support reads from recursive diagnostic capture while retaining a
  separate bounded access audit. Inspect unauthorized/error paths for token,
  URL, and raw-response exposure through existing hooks.
- Do not widen `requireAuth`, active-writer handling, or protected resource
  access. No diagnostic route takes a filesystem path or reads raw artifacts.

### 1c. Development helper and operator instructions

- Add the fixed-origin helper and package script. Read locally provisioned
  configuration without exposing secrets; use HTTPS with verification and no
  redirects, bounded download/decompression, timeouts, and exact response
  validation before printing.
- Return actionable fixed outcomes for unavailable server, invalid credential,
  disabled collection, bad response, and empty/partial data. Never print a raw
  remote error page or response as a diagnostic fallback.
- Document setup, ordinary invocation, credential expiration/rotation/revoke,
  and the Phase 1 server-only/volatile limits using placeholders and synthetic
  credentials. Do not install real production credentials during development.

## Acceptance and Evidence

- A synthetic HTTPS server with seeded events is queried successfully by the
  real helper; wrong-origin redirects and TLS failures disclose no credential.
- Invalid/missing/expired/revoked tokens fail; revocation affects subsequent
  reads without accepting cached normal-auth state. Rotation overlap is bounded.
- The valid support token cannot authenticate to protected chat, preset,
  settings, history, asset/export, mutation, writer, or upload surfaces, even
  when presented through ordinary auth headers. Deliberate public endpoints
  gain no extra access. Verify route-policy coverage rather than only samples.
- Chat/preset/body/header/error/credential canaries are absent from successful
  responses, failure output, helper stdout/stderr, access records, and any
  proposed agent-readable artifact.
- Limits, cursor/reset behavior, disabled configuration, and request auditing
  are proven; normal browser authentication and manual Diagnostics still work.

Use focused support-auth/read/helper tests plus relevant existing auth,
configuration, collector, tracing, and route-catalog tests. Run the required
cross-layer aggregate after the implementation batch and self-review. These
are local acceptance checks; the endpoint remains opt-in for production.
