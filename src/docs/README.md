# Source Docs

Last audited: 2026-09-05.

Select the smallest browser/UI owner. Use its linked section first, then inspect
source and the matching tests; these guides are not a required reading sequence.

| Guide | Owns | Entry sections |
| --- | --- | --- |
| [`svelte-ui.md`](svelte-ui.md) | App shell, routes/stores, localization, styling, responsive/Lite behavior, Playground | [Triage](svelte-ui.md#fast-triage), [render priority](svelte-ui.md#app-render-priority) |
| [`svelte-chat-ui.md`](svelte-chat-ui.md) | Transcript/message rendering, composer, visible loading, in-chat confirmations | [Triage](svelte-chat-ui.md#fast-triage), [generation UI](svelte-chat-ui.md#generation-and-loading-states) |
| [`svelte-navigation-ui.md`](svelte-navigation-ui.md) | Sidebar, character/chat selection, folders, ordering, chat-scoped controls | [Triage](svelte-navigation-ui.md#fast-triage), [toggle readiness](svelte-navigation-ui.md#owner-readiness-and-toggle-preservation) |
| [`svelte-settings-ui.md`](svelte-settings-ui.md) | Settings routes, shared controls, authoring, model-profile UI, save outcomes | [Triage](svelte-settings-ui.md#fast-triage), [persistence](svelte-settings-ui.md#settings-persistence) |
| [`client-runtime.md`](client-runtime.md) | Startup, resource integration, drafts, freshness, server-operation adapters | [Startup](client-runtime.md#startup-sequence), [runtime boundaries](client-runtime.md#adjacent-runtime-owners) |
| [`generation-client.md`](generation-client.md) | Durable generation, streams, cancellation, reattach, terminal effects, audio | [Preflight gates](generation-client.md#preflight-persistence-gates), [stream recovery](generation-client.md#operations-streams-and-reattach) |

Before adding or restyling a surface, control, dialog, or state, read the
[UI/UX Guideline](ui-ux-guideline.md); it states the visual and interaction
rules every surface keeps and the checklist to run before reporting a UI change
complete.

Cross-layer contracts have separate canonical owners:

- Read/cache/hydration protocol: [Server Resources And Hydration](../../docs/structure/server-resources-and-bridges.md).
- Command durability, event ordering, and writer loss: [Durable Mutations And Recovery](../../docs/structure/durable-mutations-and-recovery.md).
- Domain execution (providers, prompts, Agents, translation, BardWiki, modules,
  assets): choose the [architecture owner](../../docs/structure/README.md#ownership).
- Related layers to verify: [cross-cutting checklist](../../docs/structure/README.md#cross-cutting-changes).
- Test discovery: [Test Suite Guide](../../docs/tests/README.md).
