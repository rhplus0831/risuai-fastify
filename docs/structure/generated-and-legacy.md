# Generated Files And Legacy Caveats

Last audited: 2026-08-27.

These notes help avoid spending time in files that look important but are
generated, local-only, historical, vendored, or intentionally no-port.

## Generated And Local Paths

| Path | Why |
| --- | --- |
| `dist/` | Generated Vite build output created by `pnpm build` and related measurement commands. |
| `node_modules/` | Installed root dependencies. The project has no separate `server/fastify/package.json`. |
| `coverage/` | Local reports from the frontend, backend, and UI coverage scripts. |
| `test-results/` | Playwright/test output. |
| `fast-bootstrap-results/` | Generated startup/bundle measurement and integration reports. Commands and interpretation live in `development-and-observability.md`. |
| `blobs-for-test/` | Ignored local binary/test scratch payloads. |
| `*.tsbuildinfo` | Local TypeScript incremental build artifacts when an ad hoc tool enables incremental compilation; they are not runtime source. |
| `data/` | Local runtime state: `risu.db`/WAL/SHM, assets, backups, auth files, optional Web Push VAPID keys, `data/save/`, request/generation body sidecars and optional tsserver logs under `data/trace/`, and legacy import artifacts. Useful for debugging, not source; see `data-and-events.md`. |
| `data-agent/` | Disposable `pnpm dev:agent` runtime state. Default clone mode snapshots SQLite and links/copies assets/save while excluding auth, VAPID, backups, and traces; see `development-and-observability.md`. |
| `scripts/` when present | Ignored local scratch/tooling directory. |

## Tracked Payloads With Special Handling

| Path | Why |
| --- | --- |
| `public/token/` | Vendored tokenizer data. Only touch when intentionally updating those assets. |
| `public/plugin_start.7z` | Packaged starter plugin archive downloaded by `src/lib/Setting/Pages/PluginSettings.svelte`. |
| `src/etc/o200k_base.json` | Live bundled tokenizer payload. Update only with its tokenizer consumers/tests. |
| `src/etc/Airisu.webp`, `src/etc/bg.jpg`, `src/etc/send.mp3` | Live bundled image/audio assets imported by the current UI/runtime. |
| `src/etc/docs/`, `src/etc/airisu.cbs`, `src/etc/patchNote.ts` | Retained unreferenced legacy documentation/script/update payloads; do not infer a live consumer from their location. |
| `src/ts/rpack/` | Vendored rpack implementation; excluded from Prettier. |
| `src/ts/process/__fixtures__/expected/` | Prompt/generation golden fixtures; regenerate with `UPDATE_FIXTURES=1`. |
| `src/ts/process/__fixtures__/upstream/` | Upstream fixture corpus for request/provider tests. |
| `*.snap` under test fixtures | Tracked Vitest snapshots; update through the relevant test workflow. |

`.archived-docs/` contains historical documentation, not current implementation
guidance. Prefer `STRUCTURE.md`, `docs/structure/`, code, and current behavioral
tests. Archived Markdown is not a live test fixture; archived JSON is live only
when current tooling imports it explicitly.

`docs/structure/frontend.md` is source documentation only as a compatibility
pointer for older links. Add current frontend guidance to
`src/docs/svelte-ui.md` or `src/docs/client-runtime.md`.

Other ignored paths fall into four groups: retired build/runtime trees, local
environment and editor state, logs/caches, and agent scratch files. Treat them
as non-source unless a new plan explicitly reopens one. Project-maintained Git
ignore rules live in `.gitignore`; `.ignore` adds search-only exclusions for
tracked payloads. Workspace-local excludes can add more.

Prettier also skips Markdown/docs/handoff docs, `pnpm-lock.yaml`,
tracked static/vendor payloads, media/binary assets, and generated/local
directories listed in `.prettierignore` or `.gitignore`. Broad file/text
searches also skip tracked static/vendor payloads listed in `.ignore`; use
`--no-ignore` only when intentionally inspecting those assets. `pnpm format` will
not tidy structure docs, so preserve table wrapping manually.

## Static Assets

`public/` is source for static assets copied by Vite. `dist/` is the generated
copy. Edit `public/` when changing a static source asset, then rebuild.

`resources/` retains app icon/splash artwork such as `icon-*.png` and
`splash*.png`. No current package script, Vite/Fastify source, or packaging
configuration consumes it.

`src/etc/` mixes live imported image/audio/tokenizer data with unreferenced
legacy CBS/docs/update payloads, as classified above. Keep both separate from
Fastify runtime assets, which are addressed by server asset ids and stored under
`data/assets/`.

No tracked files live under `public/functions/`; in some workspaces the empty
directory may exist. Do not reintroduce old public worker/OAuth surfaces without
a new roadmap.

`tsconfig.json` includes `public/service-worker.js`. That worker is active only
for Web Push chat-completion notifications through
`src/ts/server/pushNotifications.ts`. Legacy `public/sw.js`
share/file-handler/offline service-worker surfaces remain absent and guarded by
`src/ts/browserLocalSurface.test.ts`.

## Fastify-Only Runtime

The project targets a Fastify-served web runtime. Historical mentions of native
wrappers, browser-local persistence as primary runtime, peer sync, Drive sync,
Risu Account Sync, and legacy `public/sw.js` share/file-handler/offline
service-worker behavior are archival unless a new plan reopens them.

Historical migration and audit records explain how the current runtime landed,
but current ownership belongs in the focused guides linked from
[`README.md`](README.md).

## Legacy Names Still Active

Do not remove these just because the name sounds old:

- `server/fastify/src/routes/legacyStorage.ts` backs active `/api/v1/storage/*`
  compatibility routes used by `src/ts/storage/fastifyStorage.ts` and
  `src/ts/storage/autoStorage.ts`.
- `server/fastify/src/routes/hub.ts` backs retained hub passthrough behavior.
- Browser plugin runtime remains in `src/ts/plugins/`; server command routes
  store plugin records and plugin storage but do not execute plugin code.
- Server Lua scripting executes during prompt assembly in
  `server/fastify/src/prompt/luaRuntime.ts`. Plugin V2-series import,
  persistence, and browser execution are unsupported. The active V3 host still
  uses deprecated `pluginV2`-named compatibility maps/shims internally; those
  names do not imply API-2.x record execution.

`data/db.json` is also a legacy name now. If present, `ensureDbJsonImported()`
imports a valid snapshot in one transaction, checkpoints SQLite, then renames
it to `db.json.migrated`; current runtime state is not written back to live
`db.json`. An invalid object envelope is quarantined as `db.json.invalid*`.
Malformed JSON remains untouched and fails startup so it can be repaired. If
`risu.db` later disappears while a migration/quarantine marker, a non-empty
`backups/`, `assets/`, or `save/` directory, or the password file proves prior
use, startup refuses to create a fresh database unless
`RISU_API_ALLOW_MISSING_DATABASE=1` is explicit.

Old UI strings may still mention `save/__password` or `save/__password.txt`.
Fastify auth state actually lives under `data/__password`,
`data/__known_public_key_hashes.json`, and
`data/__known_session_token_hashes.json`.

## Stale Or No-Port Surfaces

The settings UI intentionally omits these imported/legacy keys:

- `coldstorage`, `enableRemoteSaving`, `presetChain`, and `realmDirectOpen`;
- `showPromptComparison`;
- `claudeBatching`, `claudeRetrivalCaching`, `forceProxyAsOpenAI`,
  `googleClaudeTokenizing`, `removePunctuationHypa`, and `antiServerOverloads`;
- browser-only `localNetworkMode` and `localNetworkTimeoutSec`.

Some keys remain in serialized compatibility shapes, defaults, or import
normalizers. That does not make them live controls. Absence is guarded by
`src/ts/setting/advancedSettingsData.test.ts`,
`src/ts/setting/displaySettingsData.svelte.test.ts`, and
`src/ts/setting/utils.test.ts`. Language settings
also intentionally omit the old UI-translation template download, guarded by
`src/ts/setting/languageSettingsData.test.ts`; translation-cache import/export
remains current.

`showSavingIcon` is the exception to that no-control rule: it has no current
settings UI, but it remains a live persisted opt-out. It defaults to `true` and
gates `src/lib/Others/SavePopupIcon.svelte`, whose activity comes from the
browser command queue and current-writer pending mutation outbox.

The automatic cold-storage setting and archive-creation path are retired.
Recovery/read compatibility for imported legacy character/chat archives remains
live through `src/ts/process/coldstorage.svelte.ts` and Fastify recovery
commands; several creation/cleanup helpers are intentional no-ops. The frozen
Advanced Settings usage-statistics dialog is also absent, guarded by
`src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte.test.ts`.

- `src/LiteMain.svelte` is unwired. Live lite mode is `VITE_RISU_LITE` driving
  `src/ts/lite.ts` plus consumers such as settings, color scheme, and legacy
  mobile component branches; it does not re-enable `src/LiteMain.svelte`.
- `src/lib/Mobile/MobileCharacters.svelte` is active through `GridCatalog`.
  `src/lib/Mobile/MobileHeader.svelte`, `src/lib/Mobile/MobileBody.svelte`, and
  `src/lib/Mobile/MobileFooter.svelte` are the unmounted legacy mobile shell.
- `src/lib/UI/3DLoader.svelte` and `src/ts/3d/threeload.ts` are legacy and not
  imported by the current app shell.
- Picture-in-picture session keepalive is retired. Current settings support
  only `off` and `sound`; imported legacy `pip` values normalize to `sound`.
- Old worktrees may contain `src/lib/UI/NewGUI/` or `src/ts/sync/`; both are
  absent from the current tree and should not be reintroduced as active UI/sync
  surfaces without a new plan.
- `src/lib/Others/WelcomeRisu.svelte` is retained and tested onboarding/setup
  UI, but the current shell no longer imports it.
- The former application-wide Terms of Service component and gate are retired;
  `src/lib/Others/Legal.svelte` is absent. Do not confuse that removed flow with
  the live `realmTerms` workflow in `src/ts/alert.ts` and
  `src/lib/Others/AlertComp.svelte`: it is a scoped confirmation before a
  RisuRealm character download invoked by `downloadRisuHub()` in
  `src/ts/characterCards.ts`, and its recorded acceptance remains active.

Removed or intentionally no-port concepts: group chat, peer sync, Google Drive
sync, Risu Account Sync, browser-local durable persistence as the primary
runtime, native/mobile wrapper runtime modes, legacy `public/sw.js`
share/file-handler/offline service-worker behavior, and standalone
SupaMemory/Hypa V2/Hanurai engines. `HypaProcessorV2` remains an active helper
inside maintained Hypa V3 logic, and `supaMemory` field/key/memo names remain
active compatibility names for that maintained path. A persisted, dismissible
once-per-database notice names any selected retired SupaMemory, legacy
HypaMemory, Hypa V2, Hanurai, or experimental Hypa V3 mode and directs the user
to maintained Hypa V3.
