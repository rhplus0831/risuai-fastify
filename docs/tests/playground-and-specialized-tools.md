# Playground and Specialized Tools

The former component-level Playground, DevTool, subtitle, image-translation, and
MCP tool suites were removed in Phase 5 because they mocked repository modules
or asserted implementation details. There is no remaining dedicated Playground
unit-test inventory.

## Route and built-browser coverage

Shared route parsing remains covered by `src/ts/routerRoute.test.ts`. The built
application and direct-route matrix are exercised in the extended
`server/fastify/browser-smoke/startupDirectLinks.spec.ts` journey. Integrated
settings/navigation interaction, including the live application shell, remains
in `server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`.

## Specialized process boundaries

Media and provider operations are covered at their real server boundaries by
`server/fastify/__tests__/imageGeneration.test.ts`,
`server/fastify/__tests__/openAITranscription.test.ts`, and
`server/fastify/__tests__/embeddingOperations.test.ts`. MCP and plugin boundaries
are mapped in [Plugins, Modules, and MCP](plugins-modules-and-mcp.md).

## Pure helpers that remain

`src/ts/media/tests/imageType.test.ts` keeps the mock-free image-type contract,
and `packages/shared-core/src/inlayTokens.test.ts` keeps pure inlay token behavior.
New Playground coverage should be added only at a real browser/process boundary
with an explicit visible or returned-value oracle.

## Primary inventory

- Extended browser: `server/fastify/browser-smoke/startupDirectLinks.spec.ts`, `server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`.
- Extended server: `server/fastify/__tests__/imageGeneration.test.ts`, `server/fastify/__tests__/openAITranscription.test.ts`, `server/fastify/__tests__/embeddingOperations.test.ts`.
