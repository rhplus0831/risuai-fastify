# Shared UI, Feedback, and Accessibility

Phase 5 removed the shared Svelte component suites and source-surface guards:
they were dominated by own-module mocks, test hosts, and implementation-shape
assertions. This topic no longer has a component-unit inventory.

## Visible browser contracts

Accessibility, focus, modal, navigation, responsive layout, and settings
interaction remain covered in the extended built-browser journey
`server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`. Read-only and
mobile behavior also remains in `server/fastify/browser-smoke/readOnlyAppUx.spec.ts`,
`server/fastify/browser-smoke/chatEntryLayout.spec.ts`, and
`server/fastify/browser-smoke/mobileWriterConnectionRecovery.spec.ts`.

## Startup and localization

Extended locale behavior is covered by
`server/fastify/browser-smoke/selectedLocaleStartup.spec.ts` and
`server/fastify/browser-smoke/selectedLocaleRuntime.spec.ts`. Login-origin
validation remains in `src/ts/gui/loginMessageOrigin.test.ts`; shell geometry is
kept as a pure contract in `src/ts/gui/shellGeometry.test.ts`.

## Core user-visible recovery

The core browser tier protects user-visible state where it crosses durable or
authority boundaries: `server/fastify/browser-smoke/durableMutationRecovery.spec.ts`,
`server/fastify/browser-smoke/coreLineage.spec.ts`, and
`server/fastify/browser-smoke/coreOwnership.spec.ts`.

## Primary inventory

- Core browser: `server/fastify/browser-smoke/durableMutationRecovery.spec.ts`, `server/fastify/browser-smoke/coreLineage.spec.ts`.
- Extended browser: `server/fastify/browser-smoke/uiUxImprovementBaseline.spec.ts`, `server/fastify/browser-smoke/readOnlyAppUx.spec.ts`.
- Pure frontend: `src/ts/gui/loginMessageOrigin.test.ts`, `src/ts/gui/shellGeometry.test.ts`.
