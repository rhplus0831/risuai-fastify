# Plugins, Modules, and MCP

Plugin and MCP security fences are core; ordinary module composition and
protocol helpers remain in the extended tier. Phase 5 removed mocked plugin
orchestration and module UI suites.

## Plugin permissions and egress

`src/ts/plugins/pluginPermissions.test.ts` binds grants to exact script hashes.
`src/ts/plugins/pluginDatabaseBridge.core.test.ts` protects server-mode database
keys. `server/fastify/__tests__/pluginNetwork.test.ts` guards DNS, redirects, and
private-address egress. These are mutation-proven core cases.

## Modules and shared contracts

Mock-free behavior remains in `src/ts/moduleActivation.test.ts`,
`src/ts/moduleOrganization.test.ts`,
`packages/shared-core/src/moduleActivation.test.ts`, and
`packages/shared-core/src/moduleIntegration.test.ts`. Extended Fastify behavior
is covered by `server/fastify/__tests__/modules.test.ts` and
`server/fastify/__tests__/modulesMemo.test.ts`.

## MCP and RisuAccess

Core live-owner fences remain in
`src/ts/process/mcp/risuaccess/tests/characters.setCharacterInfo.test.ts` and
`src/ts/process/mcp/risuaccess/tests/modules.optimisticProjection.test.ts`.
OAuth credential handling is core in
`server/fastify/__tests__/mcpOAuthRefresh.test.ts`; pure wire validation remains
in `packages/protocol/src/mcpOAuthRefresh.test.ts` and
`packages/shared-core/src/mcpIdentifier.test.ts`.

## Primary inventory

- Core: `src/ts/plugins/pluginPermissions.test.ts`, `src/ts/plugins/pluginDatabaseBridge.core.test.ts`, `server/fastify/__tests__/pluginNetwork.test.ts`, `server/fastify/__tests__/mcpOAuthRefresh.test.ts`.
- Extended: `src/ts/plugins/apiV3/factory.test.ts`, `src/ts/plugins/pluginIconSafety.test.ts`, `server/fastify/__tests__/modules.test.ts`.
