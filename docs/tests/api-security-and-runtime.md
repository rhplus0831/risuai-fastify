# API Security, Runtime, and Network Boundaries

Phase 5 keeps security coverage at real process and HTTP boundaries. Source-text
checks, own-module mocks, and implementation call-count tests were removed.

## Authentication, active writer, and route policy

Core Fastify coverage lives in `server/fastify/__tests__/auth.test.ts`,
`server/fastify/__tests__/activeWriter.test.ts`,
`server/fastify/__tests__/routeProtection.test.ts`, and
`server/fastify/__tests__/chatOccupancyEnforcement.test.ts`. These suites exercise
real Fastify injection and SQLite state, including credential, writer, and scoped
chat authority.

## External egress and credentials

`server/fastify/__tests__/hub.test.ts`, `server/fastify/__tests__/proxy.test.ts`,
`server/fastify/__tests__/pluginNetwork.test.ts`, and
`server/fastify/__tests__/mcpOAuthRefresh.test.ts` form the core egress fence.
Credential masking and provider binding are covered by
`server/fastify/__tests__/staleInlineModelProfileSecrets.test.ts` and
`server/fastify/__tests__/providerOperations.test.ts`.

## Runtime, diagnostics, and limits

The core owns request redaction and bounded inputs through
`server/fastify/__tests__/requestTrace.test.ts`,
`server/fastify/__tests__/requestHistory.test.ts`,
`server/fastify/__tests__/clientDiagnostics.test.ts`, and
`server/fastify/__tests__/risuSaveBoundedInflate.test.ts`. Remote diagnostics is
also core in `server/fastify/__tests__/remoteDiagnostics.test.ts`. Extended real-boundary
coverage remains in
`server/fastify/__tests__/supportDiagnosticsAuth.test.ts`,
`server/fastify/__tests__/pushNotifications.test.ts`, and
`server/fastify/browser-smoke/remoteDiagnostics.spec.ts`.

## Primary inventory

- Core: `server/fastify/__tests__/auth.test.ts`, `server/fastify/__tests__/routeProtection.test.ts`, `server/fastify/__tests__/pluginNetwork.test.ts`, `server/fastify/__tests__/requestTrace.test.ts`, `server/fastify/__tests__/remoteDiagnostics.test.ts`.
- Extended: `server/fastify/__tests__/remoteDiagnosticsJourney.test.ts`, `server/fastify/__tests__/http.test.ts`, `server/fastify/__tests__/static.test.ts`, `src/ts/network/localNetwork.test.ts`.
