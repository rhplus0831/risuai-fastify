# Svelte UI Guide

Last audited: 2026-08-27.
Targeted source check: 2026-09-10 (modal opener ownership, theme contrast, and compact reflow).

This guide owns the Svelte application shell, routing, shared frontend
platform behavior, localization, styling, responsive behavior, and Playground.
Start at the [source documentation index](README.md) for browser-runtime and
surface-specific ownership.

## Related Guides

| Guide                                     | Owns                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Chat UI](svelte-chat-ui.md)              | Transcript and message rendering, composer variants, generation states, and in-chat confirmations.         |
| [Navigation UI](svelte-navigation-ui.md)  | Sidebar, character folders, chat and character selection, and internal reordering.                         |
| [Settings UI](svelte-settings-ui.md)      | Settings routes, data-driven rows, controls, authoring surfaces, model profiles, and settings persistence. |
| [Client Runtime](client-runtime.md)       | Startup resources, hydration, commands, durable recovery, and server-operation adapters.                   |
| [Generation Client](generation-client.md) | Durable generation acceptance, streaming, cancellation, reattach, effects, and completion audio.           |

The frontend is a Svelte 5 SPA with no SvelteKit routes tree:
`src/ts/router.ts` parses URLs and synchronizes Svelte stores, while
`src/App.svelte` chooses the visible screen. Fastify owns durable state and most
side effects. The browser owns rendering, local input state, visible optimistic
state, media previews, alerts and modals, TTS playback, hotkeys, custom HTML and
CSS, and plugin execution.

## Fast Triage

| Symptom                                                                                | Inspect first                                                                                     | Continue with                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Loading, settings, grid, chat, or global overlay is wrong                              | `src/App.svelte`, `src/appStartup.ts`, `src/ts/router.ts`                                         | This guide and [Client Runtime](client-runtime.md)         |
| Transcript, message HTML, composer, generation progress, or chat confirmation is wrong | `src/lib/ChatScreens/DefaultChatScreen.svelte`, `src/lib/ChatScreens/Chat.svelte`                 | [Chat UI](svelte-chat-ui.md)                               |
| Sidebar, character folder, character/chat list, or reorder is wrong                    | `src/lib/SideBars/Sidebar.svelte`, `src/lib/SideBars/SideChatList.svelte`                         | [Navigation UI](svelte-navigation-ui.md)                   |
| Settings nav, row, authoring editor, model profile, or shared control is wrong         | `src/lib/Setting/Settings.svelte`, `src/lib/Setting/SettingRenderer.svelte`                       | [Settings UI](svelte-settings-ui.md)                       |
| Theme, motion, clipping, font, scale, or custom CSS is wrong                           | `src/styles.css`, `src/ts/gui/colorscheme.ts`, `src/ts/gui/animation.ts`, `src/ts/gui/guisize.ts` | [Styling, Theme, And Layout](#styling-theme-and-layout)    |
| URL, back/forward, settings section, Playground tool, or character route is wrong      | `src/ts/router.ts`, route effects in `src/App.svelte`                                             | `src/ts/router.test.ts`, `src/App.routeEffect.dom.test.ts` |
| The document moved or window scrolling appeared                                        | `src/ts/gui/viewportScrollGuard.ts`, `src/appStartup.ts`, `src/styles.css`                        | Code that scrolls `window` or `document.scrollingElement`  |

## Entrypoints And Shell

| Path                                                                                                                    | Role                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                                                                                                            | Mounts `#app` and loads `/src/main.ts`.                                                                                                       |
| `src/main.ts`                                                                                                           | Thin entry boundary: readiness marker, preload-error handling, runtime-environment installation, and dynamic import of `src/appStartup.ts`.   |
| `src/ts/entryStartup.ts`, `src/ts/polyfill.ts`, `src/ts/entryLoadError.ts`                                              | Environment-before-app ordering, conditional baseline globals/polyfills, and the localized pre-mount reload surface.                          |
| `src/appStartup.ts`                                                                                                     | Installs routing, push and viewport coordinators, mounts `App.svelte`, starts bootstrap/hotkeys and route warming, and removes `#preloading`. |
| `src/App.svelte`                                                                                                        | Main role/route render switch, responsive sidebar state, app-level file drop, route effects, and global overlay host.                         |
| `src/lib/ConversationShell.svelte`, `src/ts/gui/shellGeometry.ts`                                                       | Role-neutral conversation frame, responsive dialog semantics, and canonical rail/panel dimensions.                                            |
| `src/styles.css`                                                                                                        | Tailwind v4 import, theme defaults, full-height shell, global chat text CSS, and compatibility base rules.                                    |
| `src/ts/bootstrap.ts`                                                                                                   | Loads Fastify resources and starts hydration, events, bridges, and UI-derived CSS state.                                                      |
| `src/ts/startupReadiness.ts`                                                                                            | Publishes startup milestones, narrow UI/action capabilities, and localized retry diagnostics.                                                 |
| `src/lib/Workspace.svelte`                                                                                              | Persistent role-neutral workspace host with separate reader and writer controllers inside one `ConversationShell`.                            |
| `src/ts/clientSession.ts`, `readerWorkspaceLifecycle.svelte.ts`, `readerRouteIntent.ts`, `readerProjectionLifecycle.ts` | Role/content admission, read/switch lifecycle state, local route intent, and authentication/lineage projection fencing.                       |
| `src/ts/platform.ts`                                                                                                    | Fastify-only platform flag; `isFastifyServer` is always true.                                                                                 |

`src/main.ts` listens for `vite:preloadError` before mounting the app. While the
entry preloader exists, a failed entry/lazy chunk renders the localized offline
or stale-build message plus reload action directly into that surface; later
lazy-component failures remain owned by their local retry UI.
`src/ts/globalApi.svelte.ts` loads `streamsaver`
inside `LocalWriter.init()`, so ordinary downloads and imports of the global API
do not fetch the streamed-download implementation.

`src/LiteMain.svelte` is not the live entrypoint. Live Lite behavior comes from
`VITE_RISU_LITE`, `src/ts/lite.ts`, and consumers in settings, themes, and
retained mobile code.

The app shell accepts external file drops. `.risup` imports a preset, `.risum`
imports a module through the Fastify-backed browser path, and other supported
files use character/card import. `src/ts/dragTypes.ts` defines app-internal MIME
markers. `src/App.svelte` marks drags that originate inside the app and ignores
those markers, including the sidebar-specific marker, before inspecting files;
external `Files` drags still advertise a copy operation. See
[Navigation UI](svelte-navigation-ui.md#drag-drop-and-reordering) for the
feature-owned reorder rules. The content-exchange entrypoints are:

- dataset and chat: `src/ts/storage/exportAsDataset.ts` and
  `src/ts/characters.ts`;
- character card, persona, and preset: `src/ts/characterCards.ts`,
  `src/ts/persona.ts`, and `src/ts/storage/database.svelte.ts`;
- lorebook, regex, module, and translator preset:
  `src/ts/process/lorebook.svelte.ts`, `src/ts/process/scripts.ts`,
  `src/ts/process/modules.ts`, and `src/ts/translator/presets.ts`.

Their formats and durable ownership are canonical in
[Assets And Saves](../../docs/structure/assets-and-saves.md#content-exchange).

Application startup has no Terms of Service gate, and the former
application-wide legal component is gone. The remaining `realmTerms` alert is
scoped to downloading a character from RisuRealm; it is not an application
startup requirement. The agent dev runner bypasses that download confirmation
for its disposable browser session.

## App Render Priority

`src/App.svelte` renders these mutually exclusive branches in order:

1. April 1 joke screen.
2. The managed authentication-required screen with its Sign in action.
3. Loading while `$startupCoordinatorStore.capabilities.canRenderShell` is false.
4. `Workspace` supplying either the contained reader controller or writer
   navigation/content to one persistent `ConversationShell`. Writer content
   selects `CustomGUISettingMenu`, Settings, Grid, or Chat without changing the
   outer workspace owner.

Route loading and Retry status mount alongside the current writer route, whose
content stays mounted and inert while its resources or code settle. They are
not separate main render branches.

`ConversationShell` keeps the navigation and main-column structure consistent
between reader and writer roles. The controller/content branch changes with
authority, but role resolution does not select different shell dimensions or a
reader-only top row. On responsive layouts the sidebar becomes an app-hosted,
focus-trapped dialog over the chat. Global overlays mount after the main branch:
alerts, Realm, preset/persona lists, saved-toggle management, bookmarks, Hypa V3,
the saving icon, popup list and editor, EasyPanel, loadouts, Iris, and custom
sidebar configuration. Feature-owned overlays can mount below their surface
instead; for example, `Sidebar.svelte` owns character-folder expansion and
editing.

Connected-reader and writer startup use the same role-first path. A managed
writer loss revokes mutation/generation authority and
writer route effects, captures local drafts, and replaces writer services with
reader synchronization. Authenticated local reader navigation stays available;
`canApplyRoutes` does not grant permission to persist selection or other edits.

Automatic writer candidates remain behind the loading boundary until recovery
is complete. `canUseClientReaderContent()` admits detail, transcript, display,
greeting, and missing-route repair only for an established reading/writing
disposition. Established reader content remains readable through promotion and
interrupted writer recovery; a new authentication/session or lineage resets
that admission.

**Use this device** explicitly starts conditional acquisition and writer
recovery. Reading and local navigation remain available while confirmation is
pending. Current cancellation or recovery failure returns to reading while
authentication and lineage remain valid; a superseded attempt cannot change a
newer role. Authentication loss instead clears the visible projection and shows
Sign in. Managed import/restore replacement revalidates the new lineage and
may install a reader projection; it does not infer write access from a matching
session id. The precise recovery/reload boundaries belong in
[Client Runtime](client-runtime.md#active-writer-loss).

Reader navigation records only the latest valid memory-only reading route and
cannot enqueue a command or outbox row. Direct Settings/authoring URLs show a
localized gate with Home and Return to reading; in-app restricted entries leave
selection unchanged. `routeIntentPrefetch`, component preload and resource
warming are writer-only, including idle callbacks that outlive their session.

Writer overlays and `SavePopupIcon.svelte` require `canApplyWriterRoutes`.
Restricted overlay stores are closed synchronously on writer loss and on late
restoration. `readerAlertPolicy.ts` admits passive/auth feedback and explicit
client-session takeover selections, while rejecting authoring/plugin dialogs. The saving icon also
respects `showSavingIcon`. `WriterDraftRecovery.svelte` remains available with
the readable shell for explicit local-copy recovery.

Blocking dialogs share `src/ts/gui/modalFocusTrap.ts`, which stacks nested
modals, makes background branches inert, traps focus, locks body scrolling, and
restores focus and background state. Migrated backdrop-closing dialogs use
`src/ts/gui/modalBackdropDismiss.ts`; dismissal requires the same primary
pointer gesture to start and end on the backdrop. Guards are
`src/ts/gui/modalFocusTrap.test.ts` and
`src/ts/gui/modalBackdropDismiss.test.ts`. Not every overlay has migrated to
both actions. For a focus escape or clickable background, inspect the local
`data-modal-root`, `use:modalFocusTrap`, and `use:modalBackdropDismiss` wiring
instead of assuming the shared backdrop behavior is present.

When a transient menu opens a blocking modal, focus a connected persistent
opener before removing the menu. The active-chat menu does this for Chat List,
BardWiki, and Modules so modal teardown can restore the menu button rather than
a disconnected menu item. Popup menus opened from a modal are explicit focus
extensions: the top modal can admit that one portal while all unrelated
background branches stay inert and hidden.

## Routes And Stores

`src/ts/router.ts` parses `window.location`, maintains `currentRoute`, applies
URLs to stores, and synchronizes user-owned store changes back to history.
Routes are not file-system based. The store effects below describe writer
route application. Connected readers resolve home/grid and stable
character/chat URLs locally through `Workspace.svelte` and
`readerRouteScope.ts`, without changing persisted selection or mounting
authoring controls.

| Route                               | Store effect                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/`                                 | Home; clears selection and closes settings and Playground.                                            |
| `/settings`                         | Opens settings; split layout selects model settings, while the narrow layout shows the category list. |
| `/settings/:section`                | Opens settings and maps the slug to `SettingsMenuIndex`.                                              |
| `/settings/persona/:personaId`      | Opens persona settings and selects the unique matching persona.                                       |
| `/grid` and `/characters`           | Opens the character grid.                                                                             |
| `/character/:chaId/:chatId?`        | Selects the character and optionally a chat.                                                          |
| `/characters/:chaId/chats/:chatId?` | Retained character/chat route shape.                                                                  |
| `/playground/:tool`                 | Maps tool slugs to `PlaygroundStore`.                                                                 |
| `/inlay` or `/inlays`               | Opens the inlay explorer as Playground value `14`.                                                    |
| Unknown root                        | Becomes `not-found` and closes route-owned surfaces.                                                  |

Unknown settings and Playground slugs fall back to their default menu; they are
not general not-found routes.

`packages/shared-core/src/resourceManifest.ts` maps every route family to the
settings groups, collections, standalone values, and detail projections it
owns. The shared application shell is inherited; settings and Playground add
their shared navigation shells, while chat generation and optional overlays
remain separate runtime/first-use surfaces. `applyRouteToStores()` calls
`prepareRouteResources()` while the memoized loaders in
`src/ts/routeComponentPreload.ts` resolve the target route shell/page, before
mutating route-backed stores, and calls
`finishRouteResources()` after selection to revalidate the already-resident chat
window and apply its prompt compatibility projection. Newer navigation aborts
older route work. The App render switch owns the
route-local loading/error/Retry UI. URL intent and the committed render route
are separate, so it keeps the last coherent route content mounted and inert
while target data and code settle. Navigation remains available to supersede
the request. Transitions that settle within one second show no loading status;
longer work shows a compact pending or Retry status instead of replacing the
shell. Intent prefetch and rendering share the exact component promises, so a
prefetched or revisited route cannot remount into a cold lazy fallback.

`src/App.svelte` has two load-bearing writer effects. Both require
`canApplyWriterRoutes`, which combines `canApplyRoutes` with the current writer
role. The URL-to-store effect consumes state-driven updates and calls
`applyRouteToStores(route)` inside `untrack`; after promotion it consumes the
latest reader intent only when that exact session's route application succeeds.
The store-to-URL effect skips while route application is active or pending,
then calls `syncRouteFromState`. The `untrack` matters because route
application closes state such as
`CustomGUISettingMenuStore`, `botMakerMode`, and `CharEmotion`; unrelated
resource reactivity must not reapply a route and reset the sidebar.

Important route and store facts:

- `canRenderShell` opens the coherent shell. Managed readers keep local route
  capability, while `canApplyWriterRoutes` separately gates both
  persistence-capable effects. Reader content admission is also distinct from
  the automatic writer loading boundary.
- Optional-work completion is exposed as the coordinator-owned
  `backgroundReady()` selector, not as a Svelte UI store. It does not gate
  `App.svelte`; new UI and route work must use their narrow capabilities.
- `src/ts/server/resourceState.svelte.ts` owns the settings, collections, and
  character resources that UI reads. Its compatibility proxy and snapshot
  helpers compose a database-shaped view over those slices; they do not own a
  second database state tree. `src/ts/server/resourceState.svelte.test.ts`
  guards that composition.
- `selectedCharID` drives the writer character, sidebar, and chat surfaces;
  reader selection comes from explicit local route IDs.
- `settingsOpen` and `SettingsMenuIndex` drive the settings shell.
- `PlaygroundStore` drives Playground; value `2` is chat and `14` is inlays.
- A character route without a chat ID intentionally shows select-chat state.
  Hidden targets replace the URL with `/`.
- In-app settings and grid openings record their history origin. Close actions
  go back only for an owned origin; direct entry replaces the route with home.
- `navigateToCharacterChatMessage` queues a single bookmark jump until route
  application, then the chat surface expands and hydrates the required window.
- Character-sidebar view mode is stored in the active history entry.
- Character, pinned-chat, settings, and Playground navigation intent warms the
  exact likely target. Matching navigation joins an in-flight resource read;
  optional startup completion also schedules at most three likely character
  details sequentially while the browser is idle and not data-saving.
- Writer route application canonicalizes active durable generation navigation
  to its owner; delayed work is fenced against newer navigation. A missing
  chat ID canonicalizes to the bare selected-character route; the focused guard
  is `src/ts/router.test.ts`.

## Component Ownership

| Path                   | Visible ownership                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/ChatScreens/` | Chat frame, transcript, message rows, composer variants, suggestions, partial edit, resize/emotion displays, and progress; see [Chat UI](svelte-chat-ui.md).                      |
| `src/lib/SideBars/`    | Desktop navigation, character folders, lists, character config, lorebook, scripts, quick settings, and the custom-sidebar renderer; see [Navigation UI](svelte-navigation-ui.md). |
| `src/lib/Setting/`     | Settings shell, renderer, wrappers, pages, authoring surfaces, bot presets, persona lists, and lore presets; see [Settings UI](svelte-settings-ui.md).                            |
| `src/lib/UI/`          | Shared higher-level UI such as accordions, menus, model/provider pickers, prompt rows, and Realm UI.                                                                              |
| `src/lib/UI/GUI/`      | Shared primitive inputs, buttons, selects, sliders, portals, and multilingual controls.                                                                                           |
| `src/lib/Others/`      | App-level and miscellaneous modals, grid/trash, bookmark/chat-list surfaces, Hypa V3, popup editor, loadouts, and Iris.                                                           |
| `src/lib/Playground/`  | Playground menu and parser, tokenizer, MCP, image, translation, subtitle, inlay, and conversion tools.                                                                            |
| `src/lib/Mobile/`      | Active mobile character grid pieces plus an unmounted full mobile shell.                                                                                                          |
| `src/lib/LiteUI/`      | Lite/hub card support; not the live app entrypoint.                                                                                                                               |
| `src/lang/`            | UI string contract.                                                                                                                                                               |
| `src/etc/`             | Bundled documentation, media, and tokenizer seed data imported by client code.                                                                                                    |

Plugin V3 can inject settings, floating-action, hamburger, and chat-menu
surfaces. Registration and unload contracts belong to
[Plugins And MCP](../../docs/structure/plugins-and-mcp.md#ui-surfaces).

## Localization

`src/lang/en.ts` is the complete UI string contract. Other language files are
deep partials merged over English by `src/lang/index.ts`. English remains a
synchronous entry/error fallback. `getLanguageForCode()` loads and memoizes only
the selected pack; `changeLanguage()` applies English or a cached pack immediately
and otherwise returns a promise for the latest selection. Superseded or canceled
selections resolve false, including late failures. A failed current selection
keeps the last applied language and can be retried.

Synchronous database/resource projection starts language loading without delaying
its revision result. Bootstrap overlaps that load with shell setup and awaits
`awaitLanguageReady()` before publishing shell readiness, including resumed
startup retries. `src/lang/reactivity.ts` installs property-read subscriptions
before mounting the app so live imported labels repaint after deferred loading;
the language entry itself has no Svelte dependency. Settings handle load failures
through the existing error dialog; onboarding waits before persisting and cancels
its own pending selection when destroyed.

`src/lang/loadLanguagePack.ts` uses six literal dynamic imports for ordinary
loading. Browsers retain failed module URLs, so retries use a fresh query on
build-owned chunk URLs emitted by `util/locale-chunk-urls.ts`; successful packs
remain memoized. URLs never come from error text or server data. The bundle
report rejects non-English packs in either static startup closure, and browser
startup checks allow only the selected non-English asset to be requested.

Data-driven settings prefer `labelKey`, `helpKey`, and option `labelKey`; `fallbackLabel` is an escape
hatch. Add every new visible frontend string to English first.

`src/lib/UI/MainMenu.svelte` uses `language.openRisuRealm` for the Open Risu
Realm action. `src/lib/Others/Help.svelte` renders Markdown from `language.help`.

Language settings own translation-cache import/export and global cached-only
and input-translation controls. For an LLM translator with Send Text As-Is,
`translatorExcludeThoughts` removes `<Thoughts>` and `<think>` blocks from the
source, source/translated history, and greeting text before dispatch. The
effective setting participates in translation-cache identity. Automatic message
translation is chat-scoped in the sidebar. The removed UI-translation-template
download must not return; `src/ts/setting/languageSettingsData.test.ts` guards
the setting visibility and absence of that action. Translation and input-hook
runtime behavior belongs to
[Translation And Input Hooks](../../docs/structure/translation-and-input-hooks.md).

## Styling, Theme, And Layout

Global styles live in `src/styles.css`. Tailwind v4 theme variables are backed
by CSS variables such as `--risu-theme-bgcolor`, `--risu-theme-textcolor`, and
`--risu-height-size`.

Display controls update CSS through `src/ts/gui/colorscheme.ts` for color and
text themes, `src/ts/gui/guisize.ts` for dimensions,
`src/ts/gui/animation.ts` for animation and the `risu-reduced-motion` class,
and `CustomCSSStore` for injected custom CSS. `gui/displaySettingsCache.ts`
stores an allowlisted, display-only `localStorage` snapshot of theme/layout,
font, size, and motion preferences plus their resolved root CSS properties.
The synchronous `index.html` bootstraps restore those properties and Custom CSS
before visible markup or the application bundle. Both loading surfaces use
theme colors. Size and palette stores initialize from the cache;
`gui/displaySettings.ts` supplies read-only paint hints while the Display group
loads, without marking any resource ready or enabling mutations. Resident
server settings take precedence during later refreshes, and shell/group
projections reconcile the cache without rewriting unchanged styles. Managed
readers use the separately certified display allowlist, including during writer
recovery; pending writer appearance never becomes reader paint. Writer loss
repaints palette, font, CSS and dimensions from confirmed values. Both chat
adapters share `ChatScreenLayout.svelte` with explicit settings/background and
controller snippets. Safe Mode
clears only live Custom CSS, not its cache. The visual palette selector and
durable custom scheme are documented in
[Settings UI](svelte-settings-ui.md#display-and-theme-controls).

`colorSchemeAccessibilityIssues()` is the palette-level accessibility oracle.
It requires 4.5:1 for primary/muted text and text on selected/control surfaces,
and 3:1 for focus indicators, identifying control borders, composited disabled
text, and destructive text. Built-ins also require a 3:1 modal edge against the
page under the established 70%-black scrim. Exact old built-in token sets may
migrate; custom or user-modified schemes keep their values and receive a
visible warning in Display settings.

`updateColorScheme()` also publishes the active light/dark type as the root
`color-scheme`. Global base styles give native select options and option groups
the active theme foreground and dark-surface background; fixed-palette selects
must declare their own `color-scheme` and option colors.

`chatScreenWidth` becomes `--chat-screen-width` and constrains transcript and
composer content without changing the outer shell. `DefaultChatScreen.svelte`
also publishes `--chat-content-rendered-width` and
`--chat-content-inline-end` for either composer mode and its menu, plus
`--chat-content-fixed-inline-end` for the temporary floating card and menu.
Ordinary content-width rows use `chat-screen-content-width`. Preserve those
contracts; hard-coded viewport offsets drift with narrow content. Chat geometry belongs to
[Chat UI](svelte-chat-ui.md#composer-layout-modes-and-mobile-viewport).

Reduced Motion is a durable Accessibility setting, not an operating-system
media-query preference. Bootstrap and settings effects call
`updateReducedMotion()`, while global styles and progress components consume
the root class. Shell entry/exit animation additionally requires an explicit
`sideBarTransitionCause`; startup, automatic role changes, reconnect, and
recovery mount directly at settled geometry. Explicit sidebar/drawer open and
close retain the existing Reduced Motion contract.

`shellGeometry.ts` is the canonical conversation-shell dimension model. It
normalizes `sideBarSize` to 0–3 (24, 28, 32, or 36 rem), desktop rail columns to
1–4, mobile rail columns to 1–2, and each rail column to 5 rem. Both reader and
writer adapters consume those values. Managed readers receive the column values
only through the certified display projection; pending writer settings remain
isolated.

The body is overflow-hidden and full-height, and `#app` uses `overflow: clip`.
`src/ts/gui/viewportScrollGuard.ts` pins the document root at the origin before
mount, preventing focus, `scrollIntoView`, custom CSS, or automation from moving
the fixed shell. While a text editor is focused,
`src/ts/gui/visualViewportCoordinator.ts` applies only
`window.visualViewport.height` to the app shell; it never consumes page/offset
coordinates and never transforms the focused editor's ancestors. A settled
focused height whose full-window delta exceeds 100 pixels is cached under
`risu-keyboard-viewport-height:portrait` or
`risu-keyboard-viewport-height:landscape`. On a later focus with no current
adjustment, a sane cached height is applied synchronously so the composer is
already inside the expected keyboard viewport. Storage failures are ignored.

Initial focus and viewport events still restart a 275-millisecond quiet-window
latch. Geometry motion unlatches a cache-miss session so WebKit owns the reveal;
a pre-lifted session remains clamped while the timer restarts. The settled pass
reconciles the measured height and refreshes a real keyboard-height cache. It
also restores the full measured height after a stale pre-lift with a hardware
keyboard. Once settled, the coordinator calls the sanctioned guard reset after
the style frame and the guard enforces root `scrollTop = 0` again. A trailing
700-millisecond validation catches late coordinate drift. The focused settling
window yields vertical ownership; horizontal drift is always reset. `index.html` also requests
`interactive-widget=resizes-content` so supporting Android browsers resize the
layout viewport themselves. Composer layout stays component-owned: dock mode is
an outer flex sibling, while the default in-flow mode remains the first item in
the reverse transcript scroller and stays bottom-pinned when that shell height
contracts. When default-on `floatingChatInput` reveals its bottom-right button
and the user opens the in-flow surface as a fixed card, component CSS offsets
window-fixed positioning by the layout/visual viewport height difference; the
`backdrop-filter` containing-block variant is already relative to the clamped
shell.

The passive `viewportDebugOverlay.ts` is lazy-loaded only when
`?risuViewportDebug=1` is present or local storage contains
`risu-viewport-debug=1`. It reports visual-viewport coordinates, root scroll,
applied height, focus, and recent viewport/focus events without altering either
coordinator. `window.__RISU_VIEWPORT_DEBUG_DUMP__()` returns its ring buffer as
JSON for remote-inspector copying.

Scroll application content through inner containers, not `window` or the
document root. For clipping, double scrollbars, or invisible content, inspect
`src/styles.css`, route-branch height classes, and child `min-w-0`/overflow
constraints. The two coordinators have focused unit and browser coverage.

## Mobile And Lite

`DynamicGUI` uses the canonical `window.innerWidth <= 1024` conversation-shell
boundary. Reader and writer roles both consume that store; there is no
reader-only media-query threshold. `sideBarStore`, `sideBarClosing`,
`sideBarTransitionCause`, `SizeStore`, `MobileGUI`, `MobileGUIStack`,
`MobileSideBar`, and `MobileSearch` coordinate responsive state. The responsive
reader drawer remains mounted while hidden to preserve local navigation state,
but its dialog focus trap is active only while open.

At 550×775 and 655×691, shared shell geometry preserves a 56-pixel scrim target
and reduces configured rail columns only when needed to keep the drawer within
the viewport. Compact/touch actions use a 44-pixel minimum target. The UI/UX
browser journey additionally checks the equivalent 640-CSS-pixel reflow of a
1280-pixel desktop at 200% zoom, long labels, footer reachability, rail
overflow, reduced motion, and BardWiki list/detail navigation.

The full `MobileHeader`, `MobileBody`, and `MobileFooter` shell is not mounted
from `src/App.svelte`. Do not start there for a live mobile bug unless the work
intentionally restores that shell. `GridCatalog.svelte` and
`MobileCharacters.svelte` are live. Lite mode is controlled by
`VITE_RISU_LITE` and `src/ts/lite.ts`, not `LiteMain.svelte`.

Focused live-surface guards include `src/lib/Others/ChatList.svelte.test.ts`,
`src/lib/Others/WelcomeRisu.svelte.test.ts`, and
`src/lib/Others/IrisModal.svelte.test.ts`.

## Playground

`src/lib/Playground/PlaygroundMenu.svelte` maps most `PlaygroundStore` values to
tool components. Value `2` is the exception: routing creates the synthetic
playground character and the normal chat shell renders it. Keep menu buttons
aligned with the slug maps in `src/ts/router.ts`.

| Value    | Tool                                                             |
| -------- | ---------------------------------------------------------------- |
| `1`      | Menu                                                             |
| `2`      | Playground chat through `src/ts/playground.ts`                   |
| `3`–`8`  | Embedding, tokenizer, syntax, Jinja, image generation, parser    |
| `9`–`14` | Subtitles, image translation, translation, MCP, CBS docs, inlays |
| `101`    | Tool conversion                                                  |

Tool-specific problems normally belong in the matching component under
`src/lib/Playground/` after the route/store mapping is confirmed.
Focused guards include `src/lib/Playground/ToolConversion.svelte.test.ts`,
`src/lib/Playground/PlaygroundSubtitle.svelte.test.ts`,
`src/lib/Playground/PlaygroundSubtitle.test.ts`, and
`src/lib/Playground/PlaygroundImageTrans.svelte.test.ts`.

## Visible-State Testing

The canonical policy is
[Testing And Operations](../../docs/structure/testing-and-operations.md#visible-state-test-contract).
For a Svelte UI regression, choose the focused colocated DOM test for the
surface and assert the rendered state after its transition. The repository
command inventory and `pnpm dev:agent` runner are in
[Testing And Operations](../../docs/structure/testing-and-operations.md#scripts);
this guide does not duplicate them.
