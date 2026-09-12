# Playground and Specialized Tools

Last audited: 2026-08-29.

This area covers the Playground route and durable starter chat, parser/tokenizer/Jinja/syntax surfaces, image generation and translation, embeddings, subtitles/transcription, translation, inlay asset browsing, MCP tool execution, Iris, and DevTool imports. Provider/media adapters are analyzed in [Providers, Models, and Media](providers-models-and-media.md), MCP runtime and permissions in [Plugins, Modules, and MCP](plugins-modules-and-mcp.md), and parser/script engines in [Scripting, Parsing, and Automation](scripting-parsing-and-automation.md).

## Parser, tokenizer, Jinja, syntax, docs, navigation, and conversion

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/Playground/PlaygroundAccessibleControls.svelte.test.ts`: independent names for Jinja template/data/result; syntax editors in contenteditable/textarea modes; docs search distinct from placeholder. | Keeps text-heavy Playground tools operable to assistive technology. | High accessibility value. |
| `PlaygroundAsyncOutput.svelte.test.ts`: older parser and tokenizer results cannot replace latest input; parser/tokenizer input/output names. | Prevents slow async processing from showing output for obsolete source text. | High request-ownership value. |
| `ToolConversion.svelte.test.ts`: cannot run without a supported file; deleted files absent from conversion. | Prevents invalid or stale conversion submissions. | Medium-high. |
| `PlaygroundNavigation.svelte.test.ts`: Playground and Realm Back controls are named and preserve the expected store transition. | Keeps specialized tools connected to global app navigation. | High navigation value. |
| `src/ts/playground.test.ts`: durable create-and-select, starter-chat optimistic projection, retained projection usability, terminal/no-live-projection/synchronous-staging rollback, remount deduplication, shared-create failure, and stale-route suppression. | Protects entry into Playground mode without duplicate characters, stranded navigation, or late rollback after the user has left. | Critical state-transition coverage. |

## Image translation, image generation, and embeddings

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `PlaygroundImageTrans.svelte.test.ts`: decode object-URL cleanup on success/failure; malformed edited JSON; reverse drag anchor and displayed-canvas scaling; named controls and busy disable; picker cancellation; mode change before/during request; image change; latest manual decode; destination-language change; custom prompt preservation; failed model response; malformed successful JSON; unmount abort and late feedback/render suppression. | Keeps selection geometry, decoded image lifetime, request resources, and model output bound to the mounted component and submitted image/mode/language. | High: stale results or leaked URLs are common media-tool failures. |
| `PlaygroundRunState.svelte.test.ts`: image-generation action recovers after unexpected failure; stale prompts and unmount abort; embedding recovery; submitted embedding input ownership; names for image fields/loading action and embedding model/query/repeated data/add. | Prevents stuck run buttons and obsolete image/vector output. | High reliability value. |

## Subtitle, transcription, and media lifecycle

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `PlaygroundSubtitle.svelte.test.ts`: names and selected language/prompt/mode; unsupported streaming restores Run; unexpected request error/retry; unmount abort/cancel stream; teardown reaches transcription; cancelled format avoids download; local Whisper error details; dispose pipeline mid-transcription. | Keeps long-running remote/local subtitle work cancellable and retryable without false downloads. | High reliability and resource-lifecycle value. |
| `PlaygroundSubtitle.test.ts`: selected media MIME; mono duplicated for MP3; probe URL revoked; AudioContext closes after decode success/failure. | Prevents malformed output and leaked browser media resources. | High cleanup/compatibility value. |

## Translation tool

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `PlaygroundTranslation.svelte.test.ts`: names/checked state; failed single translation then retry; failed JSON chunk remains empty while successes persist; single-object text preserves metadata; valid non-collection JSON translates rather than echoes; source change releases loading; language/settings changes reject mixed/stale output; captured settings stay consistent across chunks. | Protects interactive and bulk translation from partial failure and mid-run configuration changes. | High user-output correctness. |

## Inlay explorer and MCP tools

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `PlaygroundInlayExplorer.svelte.test.ts`: initial list failure/retry state; isolated preview failure; select beyond current page; no late preview URL after unmount; newest remounted preview; no preview after deletion; partial bulk-delete success; failed single delete remains; duplicate delete lock across confirmation/request. | Keeps asset previews and destructive actions consistent under pagination and partial failures. | High asset/data-integrity value. |
| `PlaygroundMCP.svelte.test.ts`: metadata and duplicate-name tools receive distinct names; refreshes serialize and recover; duplicate-name inputs remain separate and selected server tool executes; pending tool disables duplicate activation. | Prevents calling the wrong MCP server/tool and overlapping refresh/execution. | Critical extension/tool safety. |

## Iris assistant

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/Others/IrisModal.svelte.test.ts`: canonical `otherAx` availability; hidden metadata removal; newer typing animation/destroy timer; focused Close/Backlog/dialogue key ownership; Escape from input; sprite hit-testing/z-order; wait for saved hydration; empty/think-only/direction-only output preserves submitted line; hidden-only input rejected; reset ignores late success/failure; only supplied RisuAccess tool executes in bounded follow-up; unsupplied tool error; multibyte UTF-8 truncation; destroy abort without late output/error; failed request restores prior line; stacked backlog focus/restore. | Protects a conversational modal with persistence, animation, model calls, a privileged tool round, and nested focus. | Critical protocol and interaction coverage. |

## DevTool token estimates

`src/lib/SideBars/DevTool.svelte.test.ts` covers accordion lifetime, complete
transcript hydration, failure/retry, cancellation, stale counts, and source rows.
`src/ts/chatVisibleTokens.dom.test.ts` covers all-row display parsing and saved
translation layers; `src/ts/parser/staticVisibleText.dom.test.ts` covers closed
details and static HTML/CSS visibility. `server/fastify/__tests__/lorebook.test.ts`
covers source attribution, shared budgets, random warnings and isolated sticky
state; `server/fastify/__tests__/loreTokenCounts.test.ts` covers authenticated
full-history reads without persistence or revision changes.

## DevTool import

| Relevant locations and included cases | Behavior and scenarios verified | Importance |
| --- | --- | --- |
| `src/lib/SideBars/devToolAutopilotImport.test.ts`: supported extensions case-insensitively; unsupported/non-text JSON list rejection; malformed JSON surfaced. | Defines acceptable autopilot import inputs. | Medium. |

## Especially critical tests

- Image/subtitle unmount and stale-input cases prevent expensive late results from applying to a different tool state.
- Subtitle object-URL/AudioContext/pipeline cleanup prevents long-session browser resource leaks.
- Inlay partial-delete and preview ownership protect assets under real failure patterns.
- MCP duplicate-name and pending-action cases prevent execution against the wrong server/tool.
- Iris supplied-tool enforcement, bounded follow-up, stale reset, and UTF-8 truncation protect a privileged conversational boundary.

## Primary inventory

| Group | Complete in-scope file inventory |
| --- | --- |
| Route/parser/navigation/conversion | `src/ts/playground.test.ts`; `src/lib/Playground/PlaygroundAccessibleControls.svelte.test.ts`; `PlaygroundAsyncOutput.svelte.test.ts`; `PlaygroundNavigation.svelte.test.ts`; `ToolConversion.svelte.test.ts` |
| Image/embedding | `src/lib/Playground/PlaygroundImageTrans.svelte.test.ts`; `PlaygroundRunState.svelte.test.ts` |
| Subtitle/translation | `src/lib/Playground/PlaygroundSubtitle.svelte.test.ts`; `PlaygroundSubtitle.test.ts`; `PlaygroundTranslation.svelte.test.ts` |
| Inlay/MCP | `src/lib/Playground/PlaygroundInlayExplorer.svelte.test.ts`; `PlaygroundMCP.svelte.test.ts` |
| Iris/DevTool | `src/lib/Others/IrisModal.svelte.test.ts`; `src/lib/SideBars/devToolAutopilotImport.test.ts` |
