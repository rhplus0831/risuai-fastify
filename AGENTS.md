# Start Here

- Use `pnpm`.
- Read `STRUCTURE.md` next: its Agent Read Protocol and Repository-Wide
  Invariants, then the one focused guide its Choose By Task table routes you to.
  Do not load every guide.

| Purpose | Command | Notes |
| --- | --- | --- |
| Full-stack dev server | `pnpm dev:agent` | Frontend at `http://localhost:6418`; Fastify on `6419`, proxied through `/api`. Uses a disposable `data-agent/` sandbox that cannot mutate the human database. |
| API server with manual restarts | `pnpm api:dev:flag` | Restart it by running `touch .risu-api-restart`. |
| Focused test | `pnpm test -- <test-or-source-file>` | Runs the focused test selected by the test or source file. |
| Client typecheck | `pnpm check` | Checks `src/` with svelte-check. |
| Server typecheck | `pnpm check:server` | Checks the server tree. |
| Protocol and shared-core typechecks | `pnpm check:protocol`, `pnpm check:shared-core` | Check `packages/protocol` and `packages/shared-core`, respectively. |
| Documentation validation | `pnpm check:docs` | Covers `STRUCTURE.md`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/structure`, `src/docs`, and `docs/tests`. |
| Formatting | `pnpm format` to write; `pnpm format:check` to verify | Markdown is excluded by `.prettierignore`. |
| Agent verification suite | `pnpm test:agent` | Run only under the Testing rules below. |
| Full suite | `pnpm test:all` | User and CI only; never run it unprompted. |

# Search Hygiene

- The root `.ignore` file excludes tracked static/vendor payloads from broad
  file and text searches.
- For initial file-name searches, prefer `rg --files | rg "<name>"` or
  `fd <name>` so `.ignore` is honored. Use `--no-ignore` or a targeted path
  only when intentionally inspecting ignored payloads.
- Avoid broad `rg --files -g "*<name>*"` searches because explicit include globs
  can re-include ignored payloads.

# Testing

## When To Run

- Choose validation by the impact of the actual change, not by task completion or the number of files changed.
- No implementation change (investigation, explanation, review): run a test only to reproduce a problem or verify a specific hypothesis. Never run `pnpm test:agent` just because the task is complete.
- Localized change: run `pnpm test -- <file>` for the touched behavior plus the smallest typecheck for that tree (`pnpm check`, `pnpm check:server`, `pnpm check:protocol`, or `pnpm check:shared-core`). Documentation-only or non-functional edits use only the relevant check (`pnpm check:docs` for docs). Stop when that passes.
- Run `pnpm test:agent` only when the user explicitly asks; when the change affects shared behavior or contracts across areas (shared state, API contracts, dependencies, or build/test configuration); or when there is a concrete integration risk that focused validation cannot resolve. Run it once, after implementation and self-review are complete, not after intermediate edits.
- After a failure, rerun the failing check while fixing it; repeat the broader suite only to confirm the final changes.
- `pnpm test:agent` covers core typechecks, topology validation, core-tagged frontend/server tests, the current compatibility goldens, the browser-smoke build, and the `@core` Playwright journeys. That coverage does not make it mandatory for every task. `pnpm test:all` (formatting, compatibility, Realm scale, performance, full Playwright) belongs to the user and CI; do not run it unless explicitly requested.
- In the final response, state what validation ran and any material gap; if broader validation was needed, name the specific reason.

## Test Policy

The suite has two tiers. The core tier is the files listed in `util/core-test-contract.ts` (cases tagged `core`) plus the `@core` Playwright journeys; every core case was accepted only after a production mutation proved it, and `pnpm test:agent` runs it. Everything else is the extended tier: real-boundary tests that run in `pnpm test:all` and CI but are not protection an agent may rely on. `docs/test-reviews/core-suite-phase-5.md` records how the suite was reduced and why.

- A behavior-preserving change that breaks an extended-tier test means the test was implementation-coupled: delete the test, do not repair it. If the failure reveals a real regression, fix the code instead. When a change intentionally alters behavior a core case observes, update the core case's expected outcome and say so in the commit message.
- Write a new test only when it drives a public boundary and fails before the fix or under a production mutation. Public boundaries are Fastify `inject` or a listening Fastify over real SQLite, Playwright against the smoke build, or real production modules with only process edges replaced (`globalThis.fetch`, an injected `fetchImpl` or `lookup`, timers, storage, `crypto`).
- Never `vi.mock`, `vi.doMock`, or `vi.spyOn` a module under `src/`, `server/`, or `packages/`. Do not assert call counts or call order of the repository's own functions, internal state shape, or source text. Assert responses, persisted rows or bytes, rendered DOM, emitted events, or returned values against explicit expected data.
- User-visible behavior is protected by Playwright journeys, not by mounted Svelte component tests; do not add tests under `src/lib`. Structural rules (import boundaries, caller allowlists, ownership) belong in `util/architecture-inventory.ts` as closed-world checks, not in tests.
- Do not add a file to `util/core-test-contract.ts` or tag a case `core` without recording the mutation that the previous core lane survived and the new case catches, in `docs/test-reviews/`.
- Do not create test inventories, priority lists, or per-file review worklists. Runner discovery is the inventory.

# Collaboration Guideline

- Before committing, run `pnpm format` on the files you touched (or `pnpm format:check` to verify). Markdown is excluded by `.prettierignore`.
- When writing commit titles, use conventional prefixes such as `feat:`, `fix:`, and `refactor:`.
- Describe what you did in the commit message.

# Language File

New visible frontend strings get a key in `src/lang/en.ts` first, because
`en.ts` is the complete UI string contract; other packs under `src/lang` are
deep partials merged over English, so a missing key falls back to English and
translations in the other packs are optional. See
[Localization](src/docs/svelte-ui.md#localization).

# Dev Server

- Use `pnpm dev:agent` for a full-stack development server: the frontend is at `http://localhost:6418`, Fastify runs on `6419` and is proxied through `/api`, password authentication and RisuRealm terms confirmation are bypassed, and the server uses a disposable `data-agent/` sandbox that cannot mutate the human database.
- Use `pnpm api:dev:flag` for an API server that restarts only when you run `touch .risu-api-restart`.
- Stop the dev server when you are done using it.

See [Local Dev](docs/structure/development-and-observability.md#local-dev) for
sandbox data modes and environment variables.

# Dev Trace Logs

- `pnpm dev:agent` writes JSONL traces to `data-agent/trace/agent.jsonl`; `pnpm dev:human` writes them to `data/trace/human.jsonl`.
- Each traced response carries an `X-Request-UID` header. Use `rg "<uid>" data-agent/trace/*.jsonl` (or `rg "<uid>" data/trace/*.jsonl` for human mode) to find the matching entry.

See [Request And Generation Tracing](docs/structure/development-and-observability.md#request-and-generation-tracing)
for entry limits and body sidecars.

# Remote Production Diagnostics

- When an issue originates on an external server and a support config is available, begin with `pnpm diagnostics:remote --investigate`. Add a generated `--requestUid` or opaque `--operationRef` when one is known; prefer the returned correlation groups over guessing category filters.
- Treat the result as bounded, privacy-safe operational evidence. Missing or truncated evidence is not proof that an operation did not occur. The standing channel carries operational state and closed facts only, never content; content-dependent failures still require the offline reproduction tools with synthetic or operator-approved data.
