# Project Structure

Last audited: 2026-09-05.
Targeted source check: 2026-09-12 (ownership, focused-guide routing, and validation policy).

Fastify-only RisuAI: Svelte 5 browser client, Fastify API, SQLite persistence.
Toolchain: Node.js >=24 and pnpm; root `package.json` owns both runtimes.

## Agent Read Protocol

1. Read applicable `AGENTS.md` guidance, then the invariants below.
2. Choose one primary guide in [Choose By Task](#choose-by-task). Read its
   relevant section and source owners; do not load all linked guides by default.
3. For a cross-layer change, use the [change checklist](docs/structure/README.md#cross-cutting-changes).
   Use the [ownership map](docs/structure/domain-glossary.md#cross-layer-ownership)
   when the implementation layer is unclear, or the glossary for an unfamiliar term.
4. Verify behavior in current source and focused tests. Docs are navigation and
   contract summaries; if they disagree with shipped code, record the mismatch
   before treating either behavior as intended. `.archived-docs/` is historical;
   only explicit imports from current tooling make an archived artifact a live input.
5. Discover paths with `rg --files | rg '<name>'`, honoring `.ignore`. Prefer
   canonical package implementations over browser compatibility re-exports.
6. Find a relevant test in [docs/tests/README.md](docs/tests/README.md) and choose
   validation by impact. Prefer `pnpm test -- <one-test-or-source-file>` while
   working. Run `pnpm test:agent` only for the cross-area risks and other cases
   defined in `AGENTS.md`. Documentation-only changes require `pnpm check:docs`.

## Repository-Wide Invariants

- The live runtime is Fastify-only; responsive mobile web remains supported.
  Native wrappers, browser-local authoritative persistence, peer sync, and Drive
  sync are not live. See [Generated And Legacy](docs/structure/generated-and-legacy.md).
- Fastify SQLite rows, content-addressed assets, and compatibility files are
  authoritative. Browser caches are disposable; the encrypted outbox and scoped
  drafts retain pending intent or edits, not an independent offline database.
  See the [Cache Protocol](docs/structure/server-resources-and-bridges.md#cache-protocol).
- Normal revision-tracked domain writes use command mutations and global
  revision ordering. Server-owned exceptions are listed in
  [Data And Events](docs/structure/data-and-events.md#server-owned-exceptions).
- Mutation-facing UI must distinguish `accepted`, `queued`, and `failed`. A
  queued mutation is retained intent, not server acceptance; preserve newer
  drafts and do not report success merely because dispatch began.
- Put new user-visible frontend strings in `src/lang`; `src/lang/en.ts` is the
  source language pack.
- The single-writer rule is an intentional architecture constraint. Unless a
  change explicitly redesigns that boundary, new features do not need to support
  multi-writer mutation.

## Choose By Task

| Task area | Read next |
| --- | --- |
| Unfamiliar code or cross-layer ownership | [Architecture Index](docs/structure/README.md) and [Domain Glossary](docs/structure/domain-glossary.md#cross-layer-ownership) |
| Shared wire contracts, cross-runtime pure algorithms, or package import boundaries | [`@risuai/protocol`](packages/protocol/README.md), [`@risuai/shared-core`](packages/shared-core/README.md), then the owning focused guide from the [Architecture Index](docs/structure/README.md) |
| Fastify composition, Fastify API routes, generation operations/effects, jobs, timers, tracing, or Web Push | [Backend Map](docs/structure/backend.md) |
| Authentication, writer bootstrap/takeover, first-run initialization, or onboarding | [Auth And Active Writer](docs/structure/data-and-events.md#auth-and-active-writer) for server policy; [Bootstrap And Initial Resources](docs/structure/server-resources-and-bridges.md#bootstrap-and-initial-resources) and [Client Startup](src/docs/client-runtime.md#startup-sequence) for browser startup; [Backend Route-Side Contracts](docs/structure/backend.md#route-side-contracts) for atomic onboarding |
| SQLite, revisions, active writer, command events, or SSE | [Data And Events](docs/structure/data-and-events.md) |
| Browser resources, cache, or hydration | [Server Resources And Hydration](docs/structure/server-resources-and-bridges.md), then [Client Runtime](src/docs/client-runtime.md) |
| Durable mutations, command events, invalidation, bridges, writer loss, or recovery | [Durable Mutations And Recovery](docs/structure/durable-mutations-and-recovery.md) |
| Chat, transcript, message, composer, generation UI, drafts, viewport behavior, or completion audio | [Svelte Chat UI](src/docs/svelte-chat-ui.md), then [Generation Client](src/docs/generation-client.md) for durable generation |
| Sidebars, client URL/navigation routes, chat lists, character selection, or reordering | [Svelte Navigation UI](src/docs/svelte-navigation-ui.md) |
| Settings, shared controls/accessibility, localization, authoring pages, or provider panels | [Svelte Settings UI](src/docs/svelte-settings-ui.md) and [Svelte UI](src/docs/svelte-ui.md#localization) |
| App shell, styling/themes, responsive/Lite behavior, Playground, or data-dependent rendering | [Svelte UI](src/docs/svelte-ui.md) |
| Model profiles, credentials, providers, capabilities, runtime options, or request history | [Providers And Models](docs/structure/providers-and-models.md) |
| TTS, image generation, transcription, or server-owned media operations | [Server-Owned Provider And Media Operations](docs/structure/providers-and-models.md#server-owned-provider-and-media-operations) for contracts, then [Client Runtime](src/docs/client-runtime.md#server-owned-operation-adapters) for browser adapters or the [Backend Boundary](docs/structure/backend.md#server-owned-provider-and-media-boundary) for API wiring |
| Prompt assembly, templates, lorebook/Hypa memory injection, CBS, regex, triggers, or Lua | [Prompt Assembly And Scripting](docs/structure/prompt-assembly-and-scripting.md) |
| Intermediate display transforms, display-source cache/queue, batching, fallback, or measurements | [Intermediate Display](docs/structure/intermediate-display.md) |
| BardWiki settings, documents, confirmation, jobs, prompt retrieval, vaults, rebuilds, or lifecycle | [BardWiki Memory](docs/structure/bardwiki.md) |
| Translation, translator presets/caches/jobs, or Draft/BTW input hooks | [Translation And Input Hooks](docs/structure/translation-and-input-hooks.md) |
| Agents, Agent Presets, prepared inputs, dependencies, or output composition | [Agents And Presets](docs/structure/agents-and-presets.md) |
| Modules, plugins, permissions, or MCP | [Plugins And MCP](docs/structure/plugins-and-mcp.md) |
| Assets, inlay catalog, `.risu`/CharX/chat exchange, backups, reset, or Realm conversion | [Assets And Saves](docs/structure/assets-and-saves.md) |
| Client/manual diagnostics, remote support evidence, support credentials, browser diagnostic upload, or journal recovery | [Diagnostics](docs/structure/diagnostics.md) |
| Startup performance, bundle boundaries, readiness or recovery matrices, or readiness budgets | [Development And Observability](docs/structure/development-and-observability.md#startup-and-bundle-verification), [Server Resources And Hydration](docs/structure/server-resources-and-bridges.md), and [Client Runtime](src/docs/client-runtime.md) |
| Tests, Node/Svelte+Node/DOM/browser capability routing, compatibility harness, CI, TypeScript, or formatting | [Testing And Operations](docs/structure/testing-and-operations.md) and [Test Suite Guide](docs/tests/README.md) |
| Local dev, tracing, startup telemetry, environment, or browser support | [Development And Observability](docs/structure/development-and-observability.md) |
| Generated, ignored, compatibility-only, or removed paths | [Generated And Legacy](docs/structure/generated-and-legacy.md) |

## Repository Map

### Top-Level Paths

| Path | Purpose |
| --- | --- |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Root application metadata, scripts, lockfile, workspace membership, and dependency-build policy. |
| `packages/protocol/` | Browser-safe, schema-first wire contracts shared by the Svelte client and Fastify; it must not import application, Svelte, Fastify, database, or Node-only modules. |
| `packages/shared-core/` | Browser/Node-neutral value algorithms shared by the Svelte client and Fastify; it must not import protocol schemas, runtime frameworks, persistence, credentials, aggregate application state, or environment-specific APIs. |
| `index.html`, `vite.config.ts`, `src/` | Svelte 5 SPA, Vite configuration, browser runtime, UI, language packs, and bundled client data. |
| `server/fastify/` | Fastify API and tests, including SQLite persistence and provider execution; it has no separate package manifest. |
| `STRUCTURE.md`, `docs/structure/`, `src/docs/` | Current architecture and implementation guides. Start at the [Architecture Index](docs/structure/README.md). |
| `docs/plan/` | Temporary implementation plans while changes are actively in progress; current architecture guides remain authoritative for shipped behavior. |
| `docs/tests/` | Test-discovery guides organized by product and domain area. |
| `.archived-docs/` | Historical plans, audits, decisions, and verification records. Some archived JSON registers remain machine inputs where current tooling imports them explicitly. |
| `test/compat-harness/` | Current-stack compatibility goldens run in `pnpm test:all`; the full pinned comparison against the prepared pre-Fastify worktree remains an opt-in/scheduled lane. |
| `public/` | Static application sources copied or served by Vite, including the service worker and vendor/tokenizer payloads. |
| `resources/` | Retained packaging artwork; the current Vite/Fastify build does not consume it. |
| `util/` | Full-stack dev runners, database analyzer, tsserver wrapper, API-flag runner, and userscript bridge. |
| `tsconfig*.json`, `vitest*.ts`, `playwright*.ts` | TypeScript, Vitest, and Playwright configuration. |
| `.github/workflows/quality.yml`, `.github/workflows/compatibility-differential.yml` | Current quality and compatibility CI definitions. |
| `.claude/`, `.vscode/`, `.npmrc`, `.gitattributes`, `.gitignore`, `.ignore` | Agent tooling, editor, package-manager, Git, and search policy. |
| `.prettier*`, `README.md`, `version.json`, `LICENSE`, `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` | Formatting policy, project metadata, and shared/local contributor and agent guidance. |
| `dist/`, `data/`, `data-agent/`, `node_modules/`, `coverage/`, `test-results/`, `fast-bootstrap-results/` | Generated or runtime state. Persisted/user-uploaded assets live under `data/assets/`; see [Generated And Legacy](docs/structure/generated-and-legacy.md). |

### Runtime Entrypoints

| Path | Responsibility |
| --- | --- |
| `index.html` | Restores the display-only paint caches synchronously, declares the app mount/preloader, loads `src/main.ts`, and requests `interactive-widget=resizes-content`. |
| `src/main.ts` | Thin browser entry boundary: records entry readiness, installs the runtime environment, handles preload failures, and dynamically imports `src/appStartup.ts`. |
| `src/appStartup.ts` | Installs routing, push listeners, viewport coordination, root-scroll protection, and completion-audio unlocking; mounts the app, starts bootstrap/hotkeys and route warming, and removes the preloader. |
| `src/App.svelte` | Svelte application shell, top-level render routing, overlays, and selected-character visibility guard. |
| `src/ts/bootstrap.ts` | Auth/writer bootstrap, recovery preparation, resource hydration/invalidation, plugin/runtime setup, and active-work reattachment. |
| `src/ts/startupReadiness.ts` | Monotonic startup milestones, narrow render/route/mutation/plugin/generation capabilities, retry diagnostics, and privacy-safe measurement events. |
| `public/service-worker.js` | Web Push display, notification-click navigation, and client messaging. |
| `server/fastify/src/index.ts` | Loads configuration, builds the API, listens, and handles shutdown. |
| `server/fastify/src/app.ts` | Fastify composition root: plugins, SQLite, auth, writer policy, routes, jobs, workers, timers, and optional SPA. |

## Domain Ownership

The [cross-layer ownership map](docs/structure/domain-glossary.md#cross-layer-ownership)
lists the shared protocol/core, browser/UI, and Fastify/storage owners for each
domain. Use the
[cross-cutting change checklist](docs/structure/README.md#cross-cutting-changes)
to find companion files and tests.
