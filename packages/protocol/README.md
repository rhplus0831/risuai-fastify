# Shared Protocol Contracts

`@risuai/protocol` is the browser-safe source of truth for wire contracts used
by both the Svelte client and Fastify. Runtime schemas are TypeBox values and
TypeScript types are derived from those schemas.

Keep this package limited to serialized DTOs, protocol versions, capability
taxonomies, and pure validation/parsing helpers. Runtime source must not import
Svelte, Fastify, Node APIs, repositories, application stores, provider code, or
database models. `importBoundary.test.ts` enforces that rule.

Resolve public entrypoints in [`package.json`](package.json) and
the [package index](src/index.ts), then edit the owning module under
`packages/protocol/src/`. Consumer re-exports under `src/ts/server/` are
compatibility seams. Neutral value algorithms belong in
[`@risuai/shared-core`](../shared-core/README.md).

Generation SSE objects include their discriminator as `type`; the Fastify
formatter moves it to the named SSE `event:` field. Shipped generation events
are additive, so their object schemas intentionally accept unknown properties.
Security-sensitive or explicitly closed protocols, such as startup telemetry,
use `additionalProperties: false`.

The public `@risuai/protocol/ownership` subpath is owned by
`packages/protocol/src/ownership.ts`. It defines `OWNERSHIP_ENDPOINT`, the
protocol version, the exact lineage/writer tuple, and `isOwnershipResponse()`.
Fastify registers the
authenticated no-store read in `server/fastify/src/routes/ownership.ts`; it
reports durable ownership without acquiring it. Focused schema coverage is in
`packages/protocol/src/ownership.test.ts`; verify both browser recovery and
Fastify route consumers when changing the contract.

Run the focused checks with:

```sh
pnpm check:protocol
pnpm test -- packages/protocol/src/importBoundary.test.ts
```

For a contract change, select its schema test or source file with the same
focused runner, then inspect browser and Fastify consumers. Final verification
follows the root [test workflow](../../docs/structure/testing-and-operations.md#focused-execution).
