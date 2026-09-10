# Environment Notes

- Use `pnpm`.

# Dev Server

- Use `pnpm dev:agent` when you need a full-stack development server.
- For an agent-controlled API server that does not restart on every source edit, run `pnpm api:dev:flag` instead of `pnpm api:dev`. It restarts only when `.risu-api-restart` is created or touched (`touch .risu-api-restart`), then deletes that flag after the restart request is consumed.
- The frontend is available at `http://localhost:6418`; Fastify runs on port `6419` and is proxied through `/api` on the frontend server.
- `pnpm dev:agent` bypasses password authentication and RisuRealm terms confirmation for agent-run browser sessions.
- `pnpm dev:agent` runs against a disposable `data-agent/` sandbox and cannot
  mutate the human database. Its default `clone` mode takes an online SQLite
  snapshot and links or copies `assets/` and `save/`, while intentionally
  omitting auth files, backups, traces, and Web Push keys. Set
  `RISU_AGENT_DATA_MODE=keep` to reuse the sandbox or
  `RISU_AGENT_DATA_MODE=fresh` to start empty.
- Stop the dev server when you are done using it.

# Dev Trace Logs

- `pnpm dev:agent` writes API request traces to `data-agent/trace/agent.jsonl`; `pnpm dev:human` writes them to `data/trace/human.jsonl`. Each mode keeps the newest 5,000 trace entries and trims older entries.
- When tracing is enabled, each response has an `X-Request-UID` header. Use `rg "<uid>" data-agent/trace/*.jsonl` (or `data/trace/*.jsonl` for human mode) to find the matching JSONL entry.
- Trace entries inline small text bodies; larger captured text bodies are stored as `.gz` sidecars under `trace/bodies/<mode>/` inside the same data directory when the compressed sidecar is at most 10 MiB.

# Remote Production Diagnostics

- When an issue originates on an external server and a support config is available, begin with `pnpm diagnostics:remote --investigate`. Add a generated `--requestUid` or opaque `--operationRef` when one is known; prefer the returned correlation groups over guessing category filters.
- Treat the result as bounded, privacy-safe operational evidence. Missing or truncated evidence is not proof that an operation did not occur, and content-dependent failures require a separately authorized reproduction path rather than widening the standing channel.

# Search Hygiene

- The root `.ignore` file excludes tracked static/vendor payloads from broad
  file and text searches.
- For initial file-name searches, prefer `rg --files | rg "<name>"` or
  `fd <name>` so `.ignore` is honored. Use `--no-ignore` or a targeted path
  only when intentionally inspecting ignored payloads.
- Avoid broad `rg --files -g "*<name>*"` searches because explicit include globs
  can re-include ignored payloads.

# Project Structure Grounding

Start by reading `STRUCTURE.md` to understand the project structure.

# Collaboration Guideline

- Before committing, run Prettier to ensure the formatting is consistent.
- When writing commit titles, use conventional prefixes such as `feat:`, `fix:`, and `refactor:`.
- Describe what you did in the commit message.

# Test Workflow

- Choose validation based on the actual changes and their impact, not merely on task completion or the number of files changed.
- For investigation, explanation, or review without implementation changes, run tests only when needed to reproduce a problem or verify a specific hypothesis. Do not run `pnpm test:agent` solely because the task is complete.
- While working, prefer narrowly scoped tests using `pnpm test -- <test-or-source-file>`, or the smallest relevant typecheck, validator, or build check.
- For localized changes whose impact is adequately covered by focused validation, stop after that validation passes. Documentation-only or non-functional edits should use only the relevant checks.
- Run `pnpm test:agent` only when:

  - the user explicitly requests it;
  - changes affect shared behavior or contracts across multiple areas, such as shared state, API contracts, dependencies, or build/test configuration; or
  - there is a concrete integration risk or uncertainty about the change's impact that focused validation cannot adequately resolve.
- When required, run `pnpm test:agent` after implementation and self-review are complete, with no known remaining work except validation and any fixes it reveals. Do not run it after every edit or intermediate step.
- After a validation failure, rerun the failing check while fixing it. Repeat the broader suite only when needed to confirm the final changes against the applicable validation requirement.
- `pnpm test:agent` covers core typechecks, current-document validation, topology validation, frontend and server tests, and the browser-smoke build. This coverage does not make it mandatory for every task.
- The user and CI retain `pnpm test:all` for formatting, compatibility, coverage, scale, performance, and full Playwright verification. Do not run it unless explicitly requested.
- In the final response, briefly state what validation was performed and any material gaps. If broader validation was needed, identify the specific reason.

# Language File

When adding strings that appear in the frontend UI, create an appropriate key for them under `src/lang`.
