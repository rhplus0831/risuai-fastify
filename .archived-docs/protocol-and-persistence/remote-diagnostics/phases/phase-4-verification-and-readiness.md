# Phase 4: Verification and Operational Readiness

Dependency: Phases 1–3 accepted. Owners: all inventory boundaries.
Progress belongs in [status](../status.md).

## Outcome

The complete local feature has demonstrated privacy, restricted access, useful
failure evidence, bounded overhead, and an operator-controlled rollout path.
This phase does not itself deploy to or inspect the production server.

## Combined Proof

1. Build a fresh synthetic application with unique canaries in chats, presets,
   prompt rows, tool arguments/results, response/reasoning text, custom names,
   headers/query/path values, errors/stacks, Lua logs, and credentials. Include
   nested unknown keys, malformed payloads, and oversized/compressed values.
2. Inject a provider timeout/stream failure, persistence failure with eventual
   recovery, and browser hydration/network failure. Retrieve evidence using
   the same helper and support credential path intended for development use.
3. Require zero original or known encoded canaries in decoded/decompressed
   agent-readable output, journal/export artifacts, and helper error paths.
   Check forbidden fields and provenance as well as literal strings; a canary
   search alone is not proof that arbitrary content cannot be serialized.
4. Require the retrieved evidence alone to identify the injected failure stage,
   request/operation association, retry/commit disposition, and missing sources.
   Evidence that reveals nothing useful does not pass this gate.
5. Exercise the complete authorization matrix, deliberate public routes,
   incorrect/expired/revoked credentials, rotation, rate limits, TLS/redirect
   rejection, server disablement, and no collection/raw-mode bypass.
6. Exercise restart/retention/cursor gaps, concurrent readers/writes, corrupt or
   full diagnostic storage, browser auth loss/reload/offline delivery, version
   skew, data reset/replacement, and collector shutdown. Confirm application
   state/revisions and ordinary auth/manual Diagnostics behavior are preserved.

Reuse earlier phase evidence where the final source still covers it. Rerun
owning tests when changes or unresolved integration concerns justify it; do
not create a redundant parallel suite that merely mirrors implementation.

## Operator Handoff and Rollback

- Document operator enablement, HTTPS/fixed-origin configuration, protected
  credential locations, mint/install/rotate/revoke/expiry handling, retention,
  source availability, and safe helper invocation without real secrets.
- Explain browser opt-in, v1 compatibility, server-only/partial reports,
  cursor loss, expected diagnostic overhead, and the semantic limits of
  content-free evidence.
- Describe raw request/history/generation/Lua artifacts as separate operator
  data that this API cannot retrieve. Confirm journal and verifier placement
  does not expose them through existing files/static/backup surfaces.
- Keep support access disabled without explicit operator configuration. A
  rollback can disable remote reads and uploads, revoke credentials, and
  restore the prior manual workflow without touching chats, presets, writer
  state, or domain revisions. Specify safe handling of newer journal versions.
- Update current architecture/observability/test guides and record final-source
  verification, residual production unknowns, and deployment readiness in
  status. Do not describe local acceptance as an installed production feature.

## Acceptance

All [plan completion criteria](../PLAN.md#validation-and-completion) have
recorded evidence. Required focused browser proof and cross-layer aggregate
pass on the final implementation source. Documentation/link/format checks pass.
The user/CI retain `pnpm test:all` ownership unless explicitly requested for
this workstream. After closeout, archive the intact plan under the project's
planning lifecycle and leave shipped behavior in current guides.
