# `@risuai/shared-core`

Browser/Node-neutral value algorithms shared by the RisuAI client and Fastify
server.

Runtime modules may use only ECMAScript value operations and reviewed modules
inside this package. They must not import protocol schemas, browser stores,
Svelte/DOM APIs, Fastify, Node built-ins, filesystem/process globals,
credentials, persistence, or aggregate application state. Serialized contracts
belong in `@risuai/protocol`; runtime-specific policy remains with its runtime.

## Navigate By Change

Filenames below are relative to `packages/shared-core/src/` and are representative
entrypoints. The complete public surface is declared in
[`package.json`](package.json) and the [package index](src/index.ts).

- Record normalization and resolution: `agentPresetRecords.ts`,
  `agentPresetResolver.ts`, `modelProfileRecords.ts`, `modelProfileResolver.ts`,
  `providerCredentialRecords.ts`, and `translatorPresets.ts`.
- Prompt and generation policy: `cbsContracts.ts`, `cbsRegistry.ts`,
  `chatGenerationSettings.ts`, `effectivePromptTemplate.ts`,
  `promptBlockRole.ts`, `promptSettings.ts`, `providerCapability.ts`, and
  `triggerCompatibility.ts`.
- Cross-runtime value helpers: `historySlots.ts`, `moduleActivation.ts`,
  `moduleIntegration.ts`, `resourceManifest.ts`, and `settingsGroups.ts`.
- Public package entrypoints are declared in `package.json`; add or update the
  narrow export when introducing a new shared owner.

Keep runtime adapters in `src/` or `server/fastify/`. A compatibility re-export
there is an import seam, not the implementation owner.

`@risuai/shared-core/trigger-compatibility` owns the unsupported-effect catalog,
exact regex-output classification, and non-mutating, cycle-safe diagnostics.
The browser and Fastify trigger compatibility facades forward every export;
trigger execution and enforcement remain in Fastify. See
[trigger compatibility](../../docs/structure/prompt-assembly-and-scripting.md#v2-triggers-and-unsupported-effects).

## Focused Checks

```sh
pnpm check:shared-core
pnpm check:server
pnpm test -- packages/shared-core/src/modelProfileResolver.test.ts
```

The test command is an example; replace the file with the changed algorithm's
test or source file. A source target discovers related browser and Fastify tests.
Follow the root [verification workflow](../../docs/structure/testing-and-operations.md#focused-execution).

`pnpm check:server` runs the closed-world shared-core import boundary in
`util/architecture-inventory.ts`. It rejects client, server, host, DOM, Svelte,
Fastify, and Node-only dependencies without relying on a hand-maintained test
inventory. Behavioral tests remain beside each shared algorithm; browser or
server adapters own runtime-specific behavior.
