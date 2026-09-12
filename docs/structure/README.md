# Structure Documentation Index

Last audited: 2026-09-05.
Targeted source check: 2026-09-12 (diagnostics/display owners and current indexes).

Entry point: [`STRUCTURE.md`](../../STRUCTURE.md#agent-read-protocol).
This index selects canonical guides and cross-layer checks; domain contracts
and source inventories belong in the linked focused sections.

- Known task: open its owner below, then the relevant section/source/test.
- Unknown layer: use [cross-layer ownership](domain-glossary.md#cross-layer-ownership).
- Cross-layer edit: apply only matching rows in [Cross-Cutting Changes](#cross-cutting-changes).
- Browser-only detail: use [`src/docs/README.md`](../../src/docs/README.md).
- Test discovery: use [`docs/tests/README.md`](../tests/README.md).

## Ownership

This index file routes; it owns no domain guidance of its own. Every other file
in `docs/structure/` appears below. `frontend.md` is retained only as a target
for historical links and must not receive current guidance.

| Document | Owns |
| --- | --- |
| [`backend.md`](backend.md) | Fastify composition, security hooks, route families, workers, Web Push, generation operation/effect/job/timer wiring, half-streaming telemetry, and persistence fencing. |
| [`data-and-events.md`](data-and-events.md) | SQLite stores, revisions, lineage, active writer, command events, atomic chat reset transactions, and command-event SSE. |
| [`server-resources-and-bridges.md`](server-resources-and-bridges.md) | Browser bootstrap/root resources, REST endpoint and hydration workflows, cache protocol, route surfaces, and settings/feature projections. |
| [`durable-mutations-and-recovery.md`](durable-mutations-and-recovery.md) | Encrypted mutation intent, command queue/local effects, event invalidation/recovery, explicit owner lifecycles, active writer, and protocol diagnostics. |
| [`assets-and-saves.md`](assets-and-saves.md) | Content-addressed assets, inlay catalog, `.risu`/CharX/chat exchange, export fences and blob lifetime, Realm conversion, and backup/restore table policy. |
| [`plugins-and-mcp.md`](plugins-and-mcp.md) | Plugin V3 host, permissions, storage/network boundaries, modules, MCP transports and OAuth, UI surfaces, and lifecycle. |
| [`providers-and-models.md`](providers-and-models.md) | Model registry metadata, profiles, credentials, provider/media operations, runtime options, capability routing, adapters, chat/tool transport, and LLM request history. |
| [`prompt-assembly-and-scripting.md`](prompt-assembly-and-scripting.md) | Generation surfaces, prompt assembly, CBS/history, lorebook and Hypa memory injection, templates/roles, budgeting, post-generation effects, Lua, and V2 triggers. |
| [`intermediate-display.md`](intermediate-display.md) | Cross-runtime display-source wire contract, isolated server transform, cache/queue, browser batching/fallback/fences, and measurements. |
| [`bardwiki.md`](bardwiki.md) | Server-owned per-chat Markdown memory, settings, documents and versions, confirmation, jobs, prompt selection, lifecycle, vault interchange, and recovery. |
| [`translation-and-input-hooks.md`](translation-and-input-hooks.md) | Translator pipelines and history slots, browser caches, server translation identity/jobs, generated-message translation, and Draft/BTW input hooks. |
| [`agents-and-presets.md`](agents-and-presets.md) | Agent selection/readiness, Agent Preset models and prepared/lorebook inputs, dependencies, destinations, output composition, provider dispatch, and compatibility. |
| [`testing-and-operations.md`](testing-and-operations.md) | pnpm scripts, test lanes, CI, deployment, TypeScript, and visible-state testing policy. |
| [`development-and-observability.md`](development-and-observability.md) | Local/full-stack dev, tracing, startup telemetry, startup/bundle verification, built SPA serving, browser support, and runtime environment variables. |
| [`diagnostics.md`](diagnostics.md) | Manual client diagnostics, remote support authority and protocol, journal retention/recovery, browser upload, bounded queries, and rollback. |
| [`domain-glossary.md`](domain-glossary.md) | Shared record names, mutation terms, runtime boundaries, cross-layer ownership, focused-guide routing, and retired/no-port vocabulary. |
| [`generated-and-legacy.md`](generated-and-legacy.md) | Generated, vendored, ignored, compatibility-only, retired, and deliberately absent surfaces. |
| [`frontend.md`](frontend.md) | Compatibility pointer only; routes old links to the seven current `src/docs/` index/guide files and owns no current guidance. |

## Adjacent Current Guides

| Guide | Use |
| --- | --- |
| [`packages/protocol/README.md`](../../packages/protocol/README.md) | Change serialized DTOs, wire schemas, protocol versions, capability taxonomies, or their import boundary. |
| [`packages/shared-core/README.md`](../../packages/shared-core/README.md) | Change browser/Node-neutral value algorithms, package exports, ownership/parity coverage, or their import boundary. |
| [`src/docs/README.md`](../../src/docs/README.md) | Choose among the six focused Svelte/browser-runtime guides. |
| [`docs/tests/README.md`](../tests/README.md) | Find product-flow, domain, server, browser, and visible-state tests without searching the full test tree. |
| [`server/fastify/__tests__/README.md`](../../server/fastify/__tests__/README.md) | Navigate the flat Fastify test directory by feature area. |

## Cross-Cutting Changes

Each row names a contract to verify and its canonical owner. Follow that
section's file/test pointers instead of maintaining a second source inventory
here. Runtime schema/route/setting changes also require their consumers and
normalization/import paths, not only the visible editor.

| Change trigger | Required cross-layer check | Read next |
| --- | --- | --- |
| Wire contract or neutral value algorithm | Schema/export and import boundary; browser + Fastify consumers; shared ownership assertions. | [Protocol](../../packages/protocol/README.md), [Shared core](../../packages/shared-core/README.md), [domain owners](domain-glossary.md#cross-layer-ownership) |
| API route, auth, writer, or stream policy | Registration, manifest classification, rate limit, early auth/writer checks, and route-protection tests. | [Route-side contracts](backend.md#route-side-contracts) |
| Revisioned command | Atomic write/event/receipt ordering; outbox allowlist and ordering; local-effect fence or authoritative invalidation; accepted/queued/failed UI. | [Persistence/event ordering](data-and-events.md#resource-persistence-and-event-ordering), [durable command recovery](durable-mutations-and-recovery.md#durable-mutation-recovery-command-queue-and-local-acknowledgements) |
| Persisted setting | Shared/server group parity, defaults and import normalization, owner projection, command path, and localized control. | [Settings groups](server-resources-and-bridges.md#settings-groups-and-feature-projections), [settings persistence](../../src/docs/svelte-settings-ui.md#settings-persistence) |
| Character folders or opening behavior | Serialized schema, command normalization, sidebar projection, and captured selection identity. | [Character folder opening](../../src/docs/svelte-navigation-ui.md#character-folder-opening) |
| Chat generation settings or Saved Toggles | Definition-owner readiness before reconciliation; preservation of required values on full/sparse writes; prompt/module/persona activation. | [Chat-scoped controls](../../src/docs/svelte-navigation-ui.md#chat-scoped-generation-controls), [effective configuration](prompt-assembly-and-scripting.md#effective-configuration-and-assembly-order) |
| Agents or Agent Presets | Shared normalization/resolution, references and delete cleanup, prepared inputs, phase execution, authoring/progress UI. | [Agents And Presets](agents-and-presets.md), [authoring](../../src/docs/svelte-settings-ui.md#agent-and-prompt-authoring) |
| Provider, credential, model profile, or runtime option | Role/profile precedence, capability routing, secret handling, server operation/adapter, history, and provider-panel persistence. | [Adding provider behavior](providers-and-models.md#adding-provider-behavior), [model UI](../../src/docs/svelte-settings-ui.md#model-profiles-and-provider-panels) |
| LLM request history or diagnostics | Attempt recording and retention, safe diagnostic projection, authority and provenance, API reads, and UI; traces are separate. | [Request history](providers-and-models.md#llm-request-history), [diagnostics](diagnostics.md), [tracing](development-and-observability.md#request-and-generation-tracing) |
| Prompt assembly, CBS, lorebook/memory injection, or scripting | Effective config, execution order, server/browser parity, budget/confirmation gates, and durable effects. | [Prompt Assembly And Scripting](prompt-assembly-and-scripting.md) |
| Intermediate display processing | Wire/version limits, scoped transform isolation, server cache/queue, browser batching/fallback, render fences, and measurement boundaries. | [Intermediate Display](intermediate-display.md), [chat presentation](../../src/docs/svelte-chat-ui.md#intermediate-display-and-cold-hydration) |
| BardWiki | Protocol, chat-scoped documents/jobs/receipts, source fences, prompt retrieval, lifecycle/import recovery, and settings/workspace UI. | [BardWiki Memory](bardwiki.md) |
| Prompt preset/template ownership or block roles | Modern owner versus compatibility projection, lazy hydration, commands, shared role normalization, render/budget parity, and save codecs. | [Prompt template ownership and roles](prompt-assembly-and-scripting.md#prompt-template-ownership-and-roles), [preset hydration](server-resources-and-bridges.md#prompt-preset-and-legacy-bodies), [authoring](../../src/docs/svelte-settings-ui.md#agent-and-prompt-authoring) |
| Asset or inlay-catalog field | Asset references/GC, metadata persistence, command invalidation, bounded catalog projection, and Playground rendering. | [Inlay catalog](assets-and-saves.md#inlay-catalog), [cache bounds](server-resources-and-bridges.md#collection-and-cache-bounds), [Playground](../../src/docs/svelte-ui.md#playground) |
| Translation or Draft/BTW input hooks | Shared slots/pipeline, settings/chat binding, source identity, job/recovery ownership, authoring, and chat controls. | [Translation change checklist](translation-and-input-hooks.md#change-checklist), [input-hook UI](../../src/docs/svelte-chat-ui.md#input-hook-chat-controls) |
| Generation operation or completion effect | Durable operation/attempt identity, stream observation, cancellation/reattach, terminal authority, effect claims/receipts, and transient UI. | [Backend lifecycle](backend.md#generation-and-background-work), [Generation Client](../../src/docs/generation-client.md), [loading UI](../../src/docs/svelte-chat-ui.md#generation-and-loading-states) |
| Half-streaming | Runtime-option precedence, provider buffering, SSE progress, terminal/cancelled partial reconciliation, and progress UI. | [Runtime options](providers-and-models.md#runtime-options-and-precedence), [SSE](data-and-events.md#sse-and-streaming), [client half-streaming](../../src/docs/generation-client.md#half-streaming) |
| Modules, plugins, or MCP | Module content versus organization, activation, revisioned commands, device-local grants, browser execution, and server credential/transport boundaries. | [Plugins And MCP](plugins-and-mcp.md) |
| Import/export, backups, or restore | Codec normalization, reference rewriting, asset/blob lifetime, table policy, revision/lineage changes, and stale-operation fences. | [Assets And Saves](assets-and-saves.md) |
| Chat export or all-chat reset | Hydrate/fence the export; preserve atomic reset, dependent-table cleanup, outbox outcome, and authoritative reconciliation. | [Chats and datasets](assets-and-saves.md#chats-and-datasets), [client export fence](../../src/docs/client-runtime.md#all-chats-export-fence), [chat lists](../../src/docs/svelte-navigation-ui.md#chat-lists-and-folders) |
| Web Push | Server subscription/delivery lifecycle, browser retry scope, service worker navigation, and notification setting outcome. | [Backend](backend.md), [push coordinator](../../src/docs/client-runtime.md#push-notification-coordinator), [settings control](../../src/docs/svelte-settings-ui.md#shared-controls-and-focus) |
| User-visible behavior | Narrow UI owner, localized strings, matching DOM/browser evidence, and async visible states. | [Source guides](../../src/docs/README.md), [visible-state test contract](testing-and-operations.md#visible-state-test-contract) |

## Maintenance Rules

- Keep stable orientation in `STRUCTURE.md`; keep implementation detail in the
  nearest focused document.
- Give each section a specific behavior heading so agents can retrieve it by
  anchor or heading search. State owner, invariant, lifecycle/failure behavior,
  and verification pointers together; use ordered steps for execution order.
- Prefer repository-relative literal source paths and searchable symbols over
  line numbers. For a shortened filename, name its containing directory; expand
  it when the same basename exists in multiple layers. Name the test, route-policy
  entry, or protocol constant that makes a claim durable. Do not copy endpoint inventories that can
  be derived from `app.printRoutes()` and `routeManifest.ts`.
- Link to the canonical owner instead of repeating a contract across documents.
- Keep Markdown tables compact: single spaces around cells and three-dash
  separators. Column-alignment padding adds agent input without adding meaning.
- Keep active investigations or temporary planning records under `docs/` only
  while they remain current. Move completed audits, plans, reviews, and closeout
  reports into the matching `.archived-docs/` topic and update its index.
- Update an audit date only after checking the document against current code.
  For a partial check, retain the full-audit date and name the checked section
  and date separately. Formatting or link validation is not a behavior audit.
- Run `pnpm check:docs` after changing current documentation. It validates the
  current document set, focused-index completeness, local links and GitHub-style
  anchors, and unambiguous literal repository paths. Intentional absent/legacy
  paths require a narrow documented exemption in the validator.
