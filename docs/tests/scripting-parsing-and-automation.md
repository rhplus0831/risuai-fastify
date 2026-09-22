# Scripting, Parsing, and Automation

Phase 5 removed parser, CBS, trigger, and scripting tests that mocked repository
modules or asserted implementation shape. Surviving coverage is either a pure
input/output helper or a real generation/runtime boundary.

## CBS, templates, and prompt transforms

Core CBS/lore/trigger behavior is exercised through
`server/fastify/__tests__/generation.chat.test.ts`. Pure contracts remain in
`src/ts/cbs.modelContext.test.ts`, `src/ts/parser/partialEdit.test.ts`,
`src/ts/process/promptTemplateNormalization.test.ts`,
`packages/shared-core/src/promptTemplateNormalization.test.ts`, and
`packages/shared-core/src/chatMLRows.test.ts`.

## Regex, triggers, and Lua

`server/fastify/__tests__/luaRuntime.test.ts` is core for the Lua request egress
fence. Extended behavior remains in `server/fastify/__tests__/boundedRegex.test.ts`,
`server/fastify/__tests__/scripts.test.ts`,
`server/fastify/__tests__/triggers.test.ts`, and
`server/fastify/__tests__/scriptDiagnostics.test.ts`. Pure compatibility helpers
remain in `packages/shared-core/src/triggerCompatibility.test.ts` and
`packages/shared-core/src/regexOutputSizeLimit.test.ts`.

## Stream and SSE parsing

`src/ts/process/request/tests/sseParse.test.ts` is the retained pure parser owner.
The real streaming boundary is core in `src/ts/process/__tests__/streamResponse.test.ts`
and extended in `server/fastify/__tests__/streamBackpressure.test.ts`.

## Primary inventory

- Core: `server/fastify/__tests__/generation.chat.test.ts`, `server/fastify/__tests__/luaRuntime.test.ts`, `src/ts/process/__tests__/streamResponse.test.ts`.
- Extended/pure: `server/fastify/__tests__/scripts.test.ts`, `server/fastify/__tests__/triggers.test.ts`, `src/ts/parser/partialEdit.test.ts`.
