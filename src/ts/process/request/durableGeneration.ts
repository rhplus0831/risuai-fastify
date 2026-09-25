import { resolveServerPromptAssembly, type ServerPromptAssemblyInput } from './serverPromptAssembly'

/**
 * Two-arm verdict for durable generation. Unlike prompt/provider routing, a
 * non-durable result is still correct; it just cannot survive disconnect. This
 * gate therefore falls back to the inline flow instead of hard-failing.
 *
 * `reason` is for diagnostics, tests, and UI hints; it never triggers a hard fail.
 */
export type DurableGenerationRoute = { type: 'durable' } | { type: 'non-durable'; reason: string }

type DurableGenerationMode = 'send' | 'continue' | 'preview' | 'preview_prompt' | 'regenerate'

/**
 * Mirrors `deriveMode` (`serverPromptAssembly.ts`) and `serverChatMode`
 * (`serverBackedSendChat.ts`). Kept local so the durable gate has no new input
 * fields — it reuses `ServerPromptAssemblyInput` verbatim.
 */
function deriveMode(input: ServerPromptAssemblyInput): DurableGenerationMode {
  if (input.previewPrompt) return 'preview_prompt'
  if (input.preview) return 'preview'
  if (typeof input.regenerateMessageId === 'string') return 'regenerate'
  if (input.continue) return 'continue'
  return 'send'
}

/**
 * Decide whether a request is **durable-generation-eligible**: the server owns the
 * whole generation lifecycle, including reconnect and result persistence.
 *
 * Decision order:
 *   1. mode must be a **generating** mode: `send`, `continue`, or `regenerate`
 *      The server finalizes all three mode-correctly (`resolvePostGenerationResult`:
 *      continue extends the last row in place, regenerate replaces the target,
 *      send appends), keyed idempotently for replay. `preview` / `preview_prompt`
 *      never generate → `non-durable`.
 *   2. delegate to `resolveServerPromptAssembly`. Anything other than `server`
 *      → `non-durable`, carrying the assembly gate's `unsupported` reason.
 *      This single delegation inherits ALL of the assembly subset: non-text send, group
 *      char, non-server-routable provider, non-vision image caption fallback,
 *      interactive Lua dialogs, and pluginV2 edit/replacer hooks all stay
 *      `non-durable`; image-input multimodal/asset content, the image-gen view
 *      instruction, and non-interactive Lua edit/input hooks stay durable.
 *   3. otherwise → `durable`.
 *
 * Output triggers and `editoutput` are durable: the server runs
 * `runServerPostGeneration` at completion and persists the derived final text
 * and scriptstate delta. This gate adds only the generating-mode restriction on
 * top of the assembly verdict.
 */
const DURABLE_MODES: ReadonlySet<DurableGenerationMode> = new Set(['send', 'continue', 'regenerate'])

export function resolveDurableGeneration(input: ServerPromptAssemblyInput): DurableGenerationRoute {
  if (!DURABLE_MODES.has(deriveMode(input))) {
    return {
      type: 'non-durable',
      reason: 'durable generation supports send, continue, and regenerate modes only',
    }
  }

  const assembly = resolveServerPromptAssembly({
    ...input,
    origin: 'durable',
  })
  if (assembly.type !== 'server') {
    return {
      type: 'non-durable',
      reason: assembly.type === 'unsupported' ? assembly.reason : 'not server-assembled',
    }
  }

  return { type: 'durable' }
}
