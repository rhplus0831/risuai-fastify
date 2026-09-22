# App Navigation and Chat

The remaining navigation and chat protection is concentrated in mutation-proven
client contracts and real Chromium journeys. Phase 5 removed the component suites
that mocked repository modules or asserted implementation wiring.

## Routing, selection, and chat mutation

`src/ts/characterCommands.test.ts`, `src/ts/chatCommands.messages.dom.test.ts`,
`src/ts/chatFork.test.ts`, and `src/ts/chatImportPlanning.test.ts` cover durable
character/chat changes and planning. Pure route interpretation remains covered by
`src/ts/routerRoute.test.ts` and `src/ts/readerRouteScope.test.ts`.

## Transcript, send, and recovery

Core transcript behavior lives in
`src/ts/server/chatMessageHydration.completion.dom.test.ts`,
`src/ts/process/__tests__/streamReplayGap.boundary.dom.test.ts`, and
`src/ts/process/__tests__/streamResponse.test.ts`. The browser core adds exact-id
editing, deletion, import re-keying, concurrent-chat isolation, reconnect, and
reroll persistence through `server/fastify/browser-smoke/coreLifecycle.spec.ts`,
`server/fastify/browser-smoke/acceptedSendProtocol.spec.ts`, and
`server/fastify/browser-smoke/rerollSwipePersistence.spec.ts`.

## Connected readers and visible navigation

`server/fastify/browser-smoke/fastifyBrowserSmoke.spec.ts` and
`server/fastify/browser-smoke/coreLineage.spec.ts` are core ownership/recovery
journeys. Extended layout and navigation coverage remains in
`server/fastify/browser-smoke/connectedReaderBrowsing.spec.ts`,
`server/fastify/browser-smoke/chatHistoryScroll.spec.ts`,
`server/fastify/browser-smoke/chatDisplayScrollStability.spec.ts`, and
`server/fastify/browser-smoke/chatEntryLayout.spec.ts`.

## Primary inventory

- Client core: `src/ts/chatCommands.messages.dom.test.ts`, `src/ts/server/chatMessageHydration.completion.dom.test.ts`.
- Browser core: `server/fastify/browser-smoke/coreLifecycle.spec.ts`, `server/fastify/browser-smoke/acceptedSendProtocol.spec.ts`.
- Extended browser: `server/fastify/browser-smoke/readOnlyAppUx.spec.ts`, `server/fastify/browser-smoke/transcriptResidency.spec.ts`.
