# RisuAI Fastify

[![Svelte](https://img.shields.io/badge/svelte-5-red?logo=svelte)](https://svelte.dev/) [![Typescript](https://img.shields.io/badge/typescript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/) [![Vite](https://img.shields.io/badge/vite-8-%23646CFF?logo=vite)](https://vite.dev/) [![Tailwind CSS](https://img.shields.io/badge/tailwindcss-4-%2306B6D4?logo=tailwindcss)](https://tailwindcss.com/) [![Fastify](https://img.shields.io/badge/fastify-5-black?logo=fastify)](https://fastify.dev/)

A self-hosted web application for AI character chat and roleplay, forked from [RisuAI](https://github.com/kwaroran/RisuAI). A Fastify server manages persistent data, model requests, and background work; a responsive Svelte client provides the desktop and mobile browser interface.

> [!IMPORTANT]
> This is an unofficial fork. It is not affiliated with, or supported by, the upstream RisuAI project. If you are looking for the original application, use [kwaroran/RisuAI](https://github.com/kwaroran/RisuAI). Please report issues with this fork on [this repository's issue tracker](https://github.com/rhplus0831/risuai-fastify/issues), never to the upstream community.

## Status

This project is under active development for personal use and is not stable enough for general distribution. There are no releases, no published Docker image, and no upgrade or data-migration guarantees. Running from source is the only supported path.

## How this fork works

- Server-owned data: SQLite stores chats, characters, settings, and memory; uploaded assets and backups live alongside it in the server's data directory. Browser caches are disposable, while local drafts and queued edits retain pending work.
- Password-protected access: connect to your server from desktop or mobile browsers. One tab or device holds write access at a time; switching devices transfers that role.
- Server-side generation: prompt assembly, provider requests, and Lua scripting run on Fastify. Stored provider credentials are resolved on the server and masked in browser settings.
- Recoverable work: chat generation continues through browser disconnections, and the client can reattach to active work. Interrupted operations expose recovery and retry controls.

The supported runtime is a web client connected to Fastify, with one shared installation and data directory across your devices. See the [architecture overview](STRUCTURE.md) for the full runtime contract.

## Features

### Models, prompts, and automation

- Model profiles and presets: configure reusable profiles with shared credentials, model-role assignments, generation settings, and fallback models. Profile editors cover OpenAI, Anthropic Claude, Google Gemini / Vertex AI, Ollama, LLM Gateway, Neuralwatt, and custom OpenAI-compatible Chat Completions endpoints. See [providers and models](docs/structure/providers-and-models.md) for compatibility details.
- Reusable chat setups: manage model and prompt presets separately, then combine them with an Agent Preset, persona, and modules in saved loadouts.
- Agents and Agent Presets: compose helper-model steps before or after the main response. Agents can use selected chat, lorebook, and memory inputs; presets control dependencies, parallel execution, model overrides, and how outputs feed the prompt or final reply. See [Agents and Presets](docs/structure/agents-and-presets.md).
- Prompt customization: arrange prompt templates, use conditions and variables, activate character/chat/module lorebooks, and transform input or output with regex and server-side Lua. Chat token estimates include a breakdown of active lore entries.

### Memory and translation

- Hypa V3 memory: server-managed summaries and embeddings support long conversations, with background memory processing and summary rerolls.
- BardWiki memory: maintain per-chat Markdown documents with wikilinks, version history, and review controls. Use manual or automatic updates, rebuild memory from chat history, and import or export a vault. Hypa, BardWiki, and hybrid modes are available. See [BardWiki](docs/structure/bardwiki.md).
  - This feature is based on the main idea of [RisuBard](https://github.com/rpaddict/RisuBard), and it may not work completely yet.
- Translation pipelines: build translator presets with up to five steps, model-profile overrides, chat-history context, and per-chat selection. Message translation runs on the server, including automatic translation after generation.
- Draft and BTW input hooks: run configurable model prompts on composer text, review a rewritten or translated draft before sending, or use an ad hoc helper. See [translation and input hooks](docs/structure/translation-and-input-hooks.md).

### Chat, media, and extensions

- Customizable chat UI: responsive layouts, built-in and custom color schemes, character emotion images, recoverable composer drafts, and generation-stage feedback. Long transcripts load in pages and render a bounded set of messages.
- Media tools: attach images, audio, and video; configure text-to-speech, image generation, and audio transcription through supported providers.
- Completion notifications: optional Web Push notifications can open the completed chat; completion sounds are configurable separately. Push availability depends on browser support and notification permission.
- Modules and plugins: organize reusable modules in folders and extend the client with Plugin API 3.0. Plugins run in the browser; remote MCP tools are available through the Playground. See [plugins and MCP](docs/structure/plugins-and-mcp.md) for execution boundaries.

### Data and troubleshooting

- Imports and backups: import character cards, CharX packages, modules, and compatible RisuAI saves with upload/import progress. Create server backups or download portable backups, and restore through Backup & Restore.
- Storage usage: view database, asset, backup, and other file totals alongside available disk capacity in Backup & Restore.
- Request history and diagnostics: inspect model requests and responses in Request History. Optional client diagnostics provide downloadable reports of connectivity, startup, and runtime events without prompt or message content. See [Diagnostics](docs/structure/diagnostics.md) for collection and privacy boundaries.

## Running from source

### Prerequisites

- Node.js 24+
- pnpm (use the version declared in [`package.json`](package.json))

### Build and serve

Build the web client and serve it through Fastify:

```sh
pnpm install
pnpm build
pnpm api:start
```

Open [http://localhost:6002](http://localhost:6002), set the server password when prompted, and complete the initial setup. Configure a model profile and its credentials in Settings before starting a chat.

### Configuration

Set environment variables on the server process as needed:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RISU_API_HOST` | `0.0.0.0` | Listen address; use `127.0.0.1` for access only from this machine. |
| `RISU_API_PORT` | `6002` | Fastify HTTP port. |
| `RISU_API_DATA_DIR` | `data/` in the repository | Persistent database, assets, backups, and authentication state. |
| `RISU_API_STATIC_ROOT` | `dist/` in the repository | Built web client directory; `none` disables static serving. |
| `RISU_CLIENT_DIAGNOSTICS` | Off outside dev trace modes | Set to `1` to enable the diagnostics viewer in Settings → Advanced. |

For additional options, see the [environment reference](docs/structure/development-and-observability.md#environment-variables).

### Data and import compatibility

Keep the configured data directory across restarts and updates. Backup & Restore manages server snapshots and portable backup files; initialized installations also create automatic safety snapshots before whole-database replacement. Whole-database exports can include provider credentials, so keep them private.

When importing block-format saves, supported blocks are imported and standalone `CHAT` blocks are skipped and listed in the completion report. Review that report before relying on the imported data. See [assets, saves, and backups](docs/structure/assets-and-saves.md) for supported formats and import constraints.

## Development

Run the full stack (Vite dev server plus hot-reloading Fastify API) with one command:

```sh
pnpm dev:human
```

When Tailscale is connected, the app is available at the Tailscale IPv4 URL
printed during startup, with the API on port `6001`. The runner binds only to
that Tailscale address, not public or LAN interfaces. Without Tailscale it falls
back to `http://localhost:6002`.

Alternatively, run the two halves in separate terminals:

```sh
pnpm api:dev
pnpm dev
```

This serves the Vite dev server at `http://localhost:5174`, proxying `/api/*` requests to the Fastify server at `http://localhost:6002`.

### Validation

Run one exact test or tests related to one source file:

```sh
pnpm test -- <test-or-source-file>
```

Validate documentation changes with `pnpm check:docs`. Run the complete quality suite with `pnpm test:all`; it covers formatting, typechecks, documentation, test topology, frontend/server tests, compatibility, UI coverage, scale/performance gates, and browser smoke tests.

The complete suite defaults to two concurrent regular lanes. Use `pnpm test:all --jobs 3` to adjust concurrency or `pnpm test:all --dry-run` to inspect the schedule. See the [test suite guide](docs/tests/README.md) for focused test discovery and [testing and operations](docs/structure/testing-and-operations.md) for CI details.

### Contributing

- Run Prettier (`pnpm format`) before committing.
- Use conventional commit prefixes such as `feat:`, `fix:`, and `refactor:`.

## Architecture and contributor docs

Start with [`STRUCTURE.md`](STRUCTURE.md) for the current codebase map. The [architecture index](docs/structure/README.md) links to focused backend, data, provider, plugin, asset, diagnostics, intermediate-display, client-runtime, and UI guides. Use the [development guide](docs/structure/development-and-observability.md) for dev runners and tracing.

Current source and architecture guides describe shipped behavior. Documents under `docs/plan/` describe work in progress, and `.archived-docs/` contains historical records.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE), inherited from upstream RisuAI. The original work is copyright Kwaroran and the RisuAI contributors.
