import type { FastifyCharacter as character, FastifyDatabase as Database } from './serverTypes.js'
import type { PromptItem } from './promptTemplate.js'
import { applyDescriptionPromptRole, applyPromptBlockRole } from '@risuai/shared-core/prompt-block-role'
import { parseChatMLRows } from '@risuai/shared-core/chatml-rows'
import {
  resolveEffectivePromptTemplate,
  type EffectivePromptTemplateOptions,
} from '@risuai/shared-core/effective-prompt-template'
import { expandVariables, type ExpandContext } from './variables.js'
import type { PromptMessage } from './promptMessage.js'

/**
 * Template normalization + slot contract, ported from the SPA's
 * `normalizeTemplate` and `renderFinalPrompt`.
 *
 * Branch-free renderer foundation:
 *   - the canonical slot contract (`UnformatedPromptSlots`),
 *   - `normalizeTemplate` (utility-bot forced template + implicit
 *     `postEverything`),
 *   - `buildFormatOrder` (the null-template `formatingOrder` fallback),
 *   - `coalesceRows` (the shared empty-row filter + system-row
 *     coalescing helper that every later card branch reuses), and
 *   - `renderByFormatOrder` (the branch-free non-template walk).
 *
 * `renderContentCard` is the single source of truth for per-card rows, shared by
 * preflight token counting and final template rendering. It covers `persona`,
 * `description`, `authornote`, `lorebook`, `postEverything`, `plain`,
 * `jailbreak`, `cot`, `chatML`, and `chat`, returning `null` only for
 * `memory` / `cache`.
 *
 * `renderContentCard` still returns `null` for `memory` / `cache`
 * because they are not pure row-builders: `memory` needs the injected
 * `memories` input and `cache` (plus the automatic walk-back) mutates
 * the accumulated `formated` array. Both are handled directly in
 * `renderByTemplate`.
 *
 * `renderByTemplate` returns `{ formated, promptInfo }`: when
 * both `promptInfoInsideChat` and `promptTextInfoInsideChat` are on it
 * collects a parallel info array via the `deps.promptInfo` sink, and it
 * trims row contents on both the template and (via `renderByFormatOrder`)
 * the non-template paths. The injected `positionParser` supplies
 * `resolvePosition` behavior.
 *
 * `renderFinalPrompt` handles continue prompts, template/non-template
 * dispatch, `depth_prompt` splicing, and request editing.
 */

/**
 * Aggregated slot arrays the assembly root passes into the renderer.
 * Matches the SPA `renderFinalPrompt.ts` (`UnformatedPromptSlots`)
 * exactly. `preflight.ts` re-exports this as `PromptUnformatedSlots`.
 */
export interface UnformatedPromptSlots {
  main: PromptMessage[]
  jailbreak: PromptMessage[]
  chats: PromptMessage[]
  lorebook: PromptMessage[]
  globalNote: PromptMessage[]
  authorNote: PromptMessage[]
  lastChat: PromptMessage[]
  description: PromptMessage[]
  postEverything: PromptMessage[]
  personaPrompt: PromptMessage[]
}

export type FormatOrderKey = keyof UnformatedPromptSlots

export interface NormalizedTemplate {
  promptTemplate: PromptItem[] | null
  usingPromptTemplate: boolean
}

/**
 * Resolve the effective prompt template, ported from
 * `normalizeTemplate.ts`:
 *   - clone `db.promptTemplate` (never mutate the stored template),
 *   - `usingPromptTemplate` reflects whether one is set,
 *   - append an implicit `{ type: 'postEverything' }` when absent,
 *   - swap in the utility-bot forced template unless the user template
 *     opts in via `promptSettings.utilOverride`.
 */
export function normalizeTemplate(
  db: Database,
  currentChar: character,
  options: EffectivePromptTemplateOptions = {},
): NormalizedTemplate {
  const resolved = resolveEffectivePromptTemplate<PromptItem>(db, options)
  let promptTemplate = resolved.promptTemplate ? structuredClone(resolved.promptTemplate) : null
  const usingPromptTemplate = !!promptTemplate

  if (promptTemplate) {
    const hasPostEverything = promptTemplate.some((card: PromptItem) => card.type === 'postEverything')
    if (!hasPostEverything) {
      promptTemplate.push({ type: 'postEverything' })
    }
  }

  if (currentChar.utilityBot && !(usingPromptTemplate && db.promptSettings?.utilOverride)) {
    promptTemplate = [
      { type: 'plain', text: '', role: 'system', type2: 'main' },
      { type: 'description' },
      { type: 'lorebook' },
      { type: 'chat', rangeStart: 0, rangeEnd: 'end' },
      { type: 'plain', text: '', role: 'system', type2: 'globalNote' },
      { type: 'postEverything' },
    ]
  }

  return { promptTemplate, usingPromptTemplate }
}

/**
 * The null-template `formatingOrder` fallback in `assembleLocalSendChatPrompt`:
 * a clone of `db.formatingOrder` with `postEverything` always appended.
 * Used only on the non-template render path.
 */
export function buildFormatOrder(db: Database): FormatOrderKey[] {
  const order = structuredClone(db.formatingOrder ?? []) as FormatOrderKey[]
  order.push('postEverything')
  return order
}

/** Models whose system rows are coalesced (`renderFinalPrompt.ts`). */
function coalescesSystemRows(aiModel: string): boolean {
  return (
    aiModel.startsWith('gpt') || aiModel.startsWith('claude') || aiModel === 'openrouter' || aiModel === 'reverse_proxy'
  )
}

/**
 * The shared row-filter + system-coalescing helper (`pushPrompts`,
 * `renderFinalPrompt.ts`), mutating `formated` in place:
 *   - skip rows with empty `content` and no multimodals,
 *   - on non-coalescing models, push every row verbatim,
 *   - otherwise merge a `system` row into the previous one when both are
 *     `system` and share `memo` + `name`; everything else is pushed.
 *
 * The SPA's trailing `formated.at(-1).content += ''` no-op is omitted.
 */
export function coalesceRows(formated: PromptMessage[], rows: PromptMessage[], aiModel: string): void {
  for (const chat of rows) {
    if (!chat.content.trim() && !(chat.multimodals && chat.multimodals.length > 0)) {
      continue
    }
    if (!coalescesSystemRows(aiModel)) {
      formated.push(chat)
      continue
    }
    if (chat.role === 'system' && chat.memo !== 'bardWiki') {
      const endf = formated.at(-1)
      if (endf && endf.role === 'system' && endf.memo === chat.memo && endf.name === chat.name) {
        endf.content += '\n\n' + chat.content
      } else {
        formated.push(chat)
      }
    } else {
      formated.push(chat)
    }
  }
}

/**
 * The branch-free non-template render path (`renderFinalPrompt.ts`):
 * walk `formatOrder`, pushing each slot through `coalesceRows`, then
 * trim row contents. This path has no prompt-info capture; final render
 * handles `depth_prompt` splicing and request editing.
 */
export function renderByFormatOrder(
  unformated: UnformatedPromptSlots,
  formatOrder: FormatOrderKey[],
  aiModel: string,
): PromptMessage[] {
  const formated: PromptMessage[] = []
  for (const key of formatOrder) {
    coalesceRows(formated, unformated[key], aiModel)
  }
  // SPA trailing trim (`renderFinalPrompt.ts`); this path has no
  // prompt-info capture. Final render handles `depth_prompt` + `editRequest`.
  trimContentsInPlace(formated)
  return formated
}

/** SPA `convertRole` (`renderFinalPrompt.ts`). */
const CONVERT_ROLE = {
  system: 'system',
  user: 'user',
  bot: 'assistant',
} as const

/**
 * The global-note prebuilt image instruction, copied verbatim from
 * `src/ts/util.ts` (`util.ts` pulls in Svelte imports the
 * server can't load). Appended to a `globalNote` card when the
 * character opts in. The `{{join}}` / `{{ele}}` CBS is expanded later.
 */
const PREBUILT_ASSET_COMMAND = `
<Image Tag Instruction>Insert HTML image tags between paragraphs based on context.
Set src as keywords from the list below that matches current character, outfit, situation sentiment and etc.
print as many different images as possible. Use only available keywords.
if there are no matching keywords, try to put clostest matching image src.
try to put at least 1 image per output.
<keywords>{{join::{{chardisplayasset}}::,}}</keywords>
Example: <img src="{{ele::{{chardisplayasset}}::0}}">
<Image Tag Instruction>
`

/**
 * Inlined `parseChatML` from `src/ts/parser/chatML.ts`, expanding each
 * row through the server `expandVariables` (matches the prior copy in
 * `preflight.ts`). Returns `null` when the text is not a ChatML block.
 */
export function parseChatML(text: string, ctx: ExpandContext, onVarDirty?: () => void): PromptMessage[] | null {
  return parseChatMLRows(text, (content) => expanded(content, ctx, onVarDirty))
}

/**
 * Inlined `systemizeChat` from
 * `src/ts/process/promptAssembly/systemizeChat.ts`. Mutates rows
 * in place: `user` / `assistant` rows become `system` with the role
 * (or the `example_*` name) folded into the content, dropping
 * `memo` / `name`. Callers clone first when the source must be
 * preserved (see the `chat` card).
 */
export function systemizeChat(chats: PromptMessage[]): PromptMessage[] {
  for (let i = 0; i < chats.length; i++) {
    const row = chats[i]
    if (row.role === 'user' || row.role === 'assistant') {
      const attr = row.attr ?? []
      if (row.name?.startsWith('example_')) {
        row.content = row.name + ': ' + row.content
      } else if (!attr.includes('nameAdded')) {
        row.content = row.role + ': ' + row.content
      }
      row.role = 'system'
      delete row.memo
      delete row.name
    }
  }
  return chats
}

/**
 * SPA `pushPromptInfoBody` (`renderFinalPrompt.ts`): append a
 * prompt-info row to the prompt-info-inside-chat capture array. Skips
 * an empty `fmt`. `fmt` is expanded with the bare `ctx` (no `chara`),
 * matching the SPA's `risuChatParser(fmt)`.
 */
function pushPromptInfoBody(
  store: PromptMessage[],
  role: PromptMessage['role'],
  fmt: string,
  ctx: ExpandContext,
): void {
  if (!fmt.trim()) return
  store.push({ role, content: expandVariables(fmt, ctx).text })
}

/** SPA trailing content trim (`renderFinalPrompt.ts`). */
function trimContentsInPlace(rows: PromptMessage[]): void {
  for (const row of rows) {
    row.content = row.content.trim()
  }
}

export interface ContentCardDeps {
  ctx: ExpandContext
  currentChar: character
  unformated: UnformatedPromptSlots
  usingPromptTemplate: boolean
  /** `{{position::}}` and `@@inject_at` substitution supplied by the caller. */
  positionParser: (text: string, loc: string | undefined) => string
  /** Index of the base character-description row after lorebook placement. */
  descriptionBaseIndex?: number
  /**
   * Prompt-info capture sink. When present, persona /
   * description / authornote (raw `innerFormat`) and non-globalNote
   * plain / jailbreak / cot (parsed content) rows append a parallel
   * info row here. `renderByTemplate` only supplies it when both
   * `promptInfoInsideChat` and `promptTextInfoInsideChat` are on;
   * `preflight.ts` never supplies it.
   */
  promptInfo?: PromptMessage[]
  /** Called when an expansion writes chat variables through `runVar`. */
  onVarDirty?: () => void
}

/** Render result for the template-walk path. */
export interface RenderedTemplate {
  formated: PromptMessage[]
  /** Parallel prompt-info rows; defined only when capture is on. */
  promptInfo?: PromptMessage[]
}

export class StableCardRenderCache {
  private readonly entries = new Map<string, PromptMessage[]>()
  private dirtyState = false

  get dirty(): boolean {
    return this.dirtyState
  }

  read(key: string): PromptMessage[] | undefined {
    const rows = this.entries.get(key)
    return rows ? structuredClone(rows) : undefined
  }

  write(key: string, rows: PromptMessage[], dirty: boolean): void {
    this.entries.set(key, structuredClone(rows))
    this.dirtyState ||= dirty
  }

  clear(): void {
    this.entries.clear()
    this.dirtyState = false
  }
}

export function createStableCardRenderCache(): StableCardRenderCache {
  return new StableCardRenderCache()
}

function expanded(input: string, ctx: ExpandContext, onVarDirty?: () => void): string {
  const result = expandVariables(input, ctx)
  if (result.dirty) onVarDirty?.()
  return result.text
}

export function isStableTemplateCard(card: PromptItem): boolean {
  return (
    card.type === 'plain' ||
    card.type === 'jailbreak' ||
    card.type === 'cot' ||
    card.type === 'chatML' ||
    card.type === 'persona' ||
    card.type === 'description' ||
    card.type === 'authornote'
  )
}

function stableCardCacheKey(card: PromptItem, templateIndex: number): string {
  return `${templateIndex}:${card.type}:${card.id ?? ''}`
}

function captureStableCardPromptInfo(card: PromptItem, rows: PromptMessage[], deps: ContentCardDeps): void {
  if (!deps.promptInfo) return

  switch (card.type) {
    case 'persona':
    case 'description':
    case 'authornote':
      if (!card.innerFormat || rows.length === 0) return
      for (const row of rows) {
        pushPromptInfoBody(deps.promptInfo, row.role, card.innerFormat, deps.ctx)
      }
      return
    case 'plain':
    case 'jailbreak':
    case 'cot':
      if (card.type2 === 'globalNote') return
      for (const row of rows) {
        pushPromptInfoBody(deps.promptInfo, row.role, row.content, deps.ctx)
      }
      return
  }
}

export function renderContentCardWithStableCache(
  card: PromptItem,
  deps: ContentCardDeps,
  stableCardCache: StableCardRenderCache | undefined,
  templateIndex: number,
): PromptMessage[] | null {
  if (!stableCardCache || !isStableTemplateCard(card)) {
    return renderContentCard(card, deps)
  }

  const key = stableCardCacheKey(card, templateIndex)
  const cached = stableCardCache.read(key)
  if (cached) {
    captureStableCardPromptInfo(card, cached, deps)
    return cached
  }

  let dirty = false
  const rows =
    renderContentCard(card, {
      ...deps,
      ctx: { ...deps.ctx, runVar: true },
      promptInfo: undefined,
      onVarDirty: () => {
        dirty = true
      },
    }) ?? []
  stableCardCache.write(key, rows, dirty)

  const rendered = stableCardCache.read(key) ?? []
  captureStableCardPromptInfo(card, rendered, deps)
  return rendered
}

/**
 * Build the OpenAIChat rows for a single content card
 * (`renderFinalPrompt.ts`). Returns `null` only for `memory` /
 * `cache`, which `renderByTemplate` handles directly because
 * they mutate injected/accumulated state rather than producing rows. A
 * gated-off `jailbreak` / `cot` card returns `[]`.
 *
 * Shared by `preflight.ts` (which tokenizes the rows) and
 * `renderByTemplate` (which coalesces them), so the per-card content
 * logic has a single source of truth.
 *
 * When `deps.promptInfo` is supplied, persona / description /
 * authornote (raw `innerFormat`) and non-globalNote plain / jailbreak /
 * cot (parsed content) rows also append a parallel prompt-info row.
 * `preflight.ts` never supplies the sink, so its tokenization is
 * unaffected.
 */
export function renderContentCard(card: PromptItem, deps: ContentCardDeps): PromptMessage[] | null {
  const { ctx, currentChar, unformated, usingPromptTemplate, positionParser } = deps
  const db = ctx.database

  const wrapInnerFormat = (
    rows: PromptMessage[],
    innerFormat: string | undefined,
    loc: string,
    fallback?: (row: PromptMessage) => string,
  ): PromptMessage[] => {
    if (innerFormat && rows.length > 0) {
      const wrap = expanded(
        positionParser(innerFormat, loc),
        {
          ...ctx,
          chara: currentChar,
        },
        deps.onVarDirty,
      )
      for (const row of rows) {
        row.content = wrap.replace('{{slot}}', fallback ? fallback(row) : row.content)
        // Prompt-info capture uses the RAW `innerFormat` (no positionParser,
        // no chara), once per row — `renderFinalPrompt.ts`.
        if (deps.promptInfo) {
          pushPromptInfoBody(deps.promptInfo, row.role, innerFormat, ctx)
        }
      }
    }
    return rows
  }

  switch (card.type) {
    case 'persona':
      return wrapInnerFormat(
        applyPromptBlockRole(structuredClone(unformated.personaPrompt), card.role2),
        card.innerFormat ?? undefined,
        card.type,
      )
    case 'description':
      return wrapInnerFormat(
        applyDescriptionPromptRole(structuredClone(unformated.description), card.role2, deps.descriptionBaseIndex),
        card.innerFormat ?? undefined,
        card.type,
      )
    case 'authornote':
      return wrapInnerFormat(
        applyPromptBlockRole(structuredClone(unformated.authorNote), card.role2),
        card.innerFormat ?? undefined,
        card.type,
        (row) => row.content || card.defaultText || '',
      )
    case 'lorebook':
      return structuredClone(unformated.lorebook)
    case 'postEverything': {
      const rows = structuredClone(unformated.postEverything)
      if (usingPromptTemplate && db.promptSettings?.postEndInnerFormat) {
        rows.push({ role: 'system', content: db.promptSettings.postEndInnerFormat })
      }
      return rows
    }
    case 'plain':
    case 'jailbreak':
    case 'cot': {
      if (card.type === 'jailbreak' && !db.jailbreakToggle) return []
      if (card.type === 'cot' && !db.chainOfThought) return []

      const posType = card.type === 'plain' ? card.type2 : card.type
      let content = card.text

      if (card.type === 'plain' && card.type2 === 'globalNote') {
        if (currentChar.replaceGlobalNote) {
          content = currentChar.replaceGlobalNote.replaceAll('{{original}}', content)
        }
      }

      // Compose the effective Global Note first, then apply location-targeted
      // lore exactly once. Applying the parser separately to the original and
      // replacement text duplicates `@@inject_at globalNote` whenever the
      // replacement contains `{{original}}`.
      content = positionParser(content, posType)

      // Preserve the existing ordering of the internal asset instruction: it
      // is appended after location-targeted Global Note lore and therefore is
      // not itself an `@@inject_replace` target.
      if (
        card.type === 'plain' &&
        card.type2 === 'globalNote' &&
        currentChar.prebuiltAssetCommand &&
        !card.text.includes('{{//@customimageinstruction}}')
      ) {
        content += PREBUILT_ASSET_COMMAND
      }

      content = expanded(
        content,
        {
          ...ctx,
          chara: currentChar,
          role: card.role,
        },
        deps.onVarDirty,
      )

      const promptRow: PromptMessage = { role: CONVERT_ROLE[card.role], content }
      // Prompt-info capture re-expands the parsed content with the bare
      // ctx, excluding globalNote — `renderFinalPrompt.ts`.
      if (deps.promptInfo && card.type2 !== 'globalNote') {
        pushPromptInfoBody(deps.promptInfo, promptRow.role, promptRow.content, ctx)
      }
      return [promptRow]
    }
    case 'chatML':
      return parseChatML(card.text, { ...ctx, chara: currentChar }, deps.onVarDirty) ?? []
    case 'chat': {
      const chats = unformated.chats
      let start = card.rangeStart
      let end = card.rangeEnd === 'end' ? chats.length : card.rangeEnd

      if (start === -1000) {
        start = 0
        end = chats.length
      }
      if (start < 0) {
        start = chats.length + start
        if (start < 0) start = 0
      }
      if (end < 0) {
        end = chats.length + end
        if (end < 0) end = 0
      }
      if (start >= end) return []

      const slice = chats.slice(start, end)
      if (usingPromptTemplate && db.promptSettings?.sendChatAsSystem && !card.chatAsOriginalOnSystem) {
        // Clone before systemizing so the shared `unformated.chats` is
        // not mutated between the preflight pass and the render pass.
        // Accepted divergence: the baseline's shallow slice plus mutating
        // `systemizeChat` (`index.svelte.ts:1324`, `:2030`) contaminated later
        // chat cards over the same range. Card-local roles are intentional here.
        return systemizeChat(structuredClone(slice))
      }
      return slice
    }
    default:
      // `memory` / `cache`.
      return null
  }
}

/**
 * The template-walk render path (`renderFinalPrompt.ts` `if
 * (promptTemplate)` branch). Dispatches content + `chat` cards through
 * `renderContentCard` + `coalesceRows`, and handles `memory` / `cache`
 * plus the automatic cache-point walk-back inline. When both
 * `promptInfoInsideChat` and `promptTextInfoInsideChat` are on, it also
 * collects the parallel prompt-info rows, then trims both arrays and
 * returns them. Final render handles `depth_prompt` splicing and `editRequest`.
 */
export function renderByTemplate(
  ctx: ExpandContext,
  currentChar: character,
  unformated: UnformatedPromptSlots,
  promptTemplate: PromptItem[],
  usingPromptTemplate: boolean,
  positionParser: (text: string, loc: string | undefined) => string = (text) => text,
  memories: PromptMessage[] = [],
  stableCardCache?: StableCardRenderCache,
  descriptionBaseIndex?: number,
): RenderedTemplate {
  const db = ctx.database
  const aiModel = db.aiModel ?? ''

  // Prompt-info-inside-chat capture (`renderFinalPrompt.ts`):
  // collect a parallel info array, gated on both db flags.
  const capture = !!(db.promptInfoInsideChat && db.promptTextInfoInsideChat)
  const promptInfo: PromptMessage[] | undefined = capture ? [] : undefined

  const deps: ContentCardDeps = {
    ctx,
    currentChar,
    unformated,
    usingPromptTemplate,
    positionParser,
    descriptionBaseIndex,
    promptInfo,
  }

  // SPA `hasCachePoint` (from `preflightTemplateTokens`) is true iff the
  // template contains an explicit `cache` card; the whole-template scan
  // here is identical and keeps the renderer self-contained. It
  // suppresses the automatic cache-point walk-back below.
  const hasCachePoint = promptTemplate.some((card) => card.type === 'cache')

  const formated: PromptMessage[] = []
  for (let templateIndex = 0; templateIndex < promptTemplate.length; templateIndex++) {
    const card = promptTemplate[templateIndex]
    // `memory` builds rows from the injected `memories` and `cache`
    // mutates the accumulated `formated` array, so both live here rather
    // than in the pure `renderContentCard` row-builder.
    if (card.type === 'memory') {
      // `renderFinalPrompt.ts`. Memory deliberately does **not**
      // run `positionParser` (unlike persona / description); it only
      // wraps each row via `innerFormat` + `{{slot}}`.
      const rows = applyPromptBlockRole(structuredClone(memories), card.role2)
      if (card.innerFormat && rows.length > 0) {
        const wrap = expandVariables(card.innerFormat, {
          ...ctx,
          chara: currentChar,
        }).text
        for (const row of rows) {
          row.content = wrap.replace('{{slot}}', row.content)
          // Capture the raw `innerFormat` per row (`renderFinalPrompt.ts`).
          if (promptInfo) {
            pushPromptInfoBody(promptInfo, row.role, card.innerFormat, ctx)
          }
        }
      }
      coalesceRows(formated, rows, aiModel)
      continue
    }

    if (card.type === 'cache') {
      // `renderFinalPrompt.ts`: walk `formated` from the end,
      // marking up to `depth` rows whose role matches (`all` matches any).
      let pointer = formated.length - 1
      let depthRemaining = card.depth
      while (pointer >= 0 && depthRemaining !== undefined && depthRemaining > 0) {
        if (formated[pointer].role === card.role || card.role === 'all') {
          formated[pointer].cachePoint = true
          depthRemaining--
        }
        pointer--
      }
      continue
    }

    const rows = renderContentCardWithStableCache(card, deps, stableCardCache, templateIndex)
    if (rows) {
      coalesceRows(formated, rows, aiModel)
    }

    // Automatic cache point at the tail of a `chat` card
    // (`renderFinalPrompt.ts`): when enabled and no explicit
    // `cache` card suppresses it, mark the last 3 `user` rows.
    if (card.type === 'chat' && db.automaticCachePoint && !hasCachePoint) {
      let pointer = formated.length - 1
      let depthRemaining = 3
      while (pointer >= 0 && depthRemaining > 0) {
        if (formated[pointer].role === 'user') {
          formated[pointer].cachePoint = true
          depthRemaining--
        }
        pointer--
      }
    }
  }

  // SPA trailing trim (`renderFinalPrompt.ts`). The `depth_prompt`
  // splice + `editRequest` seam run after this, in the top-level
  // `renderFinalPrompt`.
  trimContentsInPlace(formated)
  if (promptInfo) trimContentsInPlace(promptInfo)

  return { formated, promptInfo }
}

/** Args for the top-level `renderFinalPrompt` entry. */
export interface RenderFinalPromptArgs {
  ctx: ExpandContext
  currentChar: character
  unformated: UnformatedPromptSlots
  promptTemplate: PromptItem[] | null
  usingPromptTemplate: boolean
  /** Cloned + `postEverything`-appended `formatingOrder`; non-template path only. */
  formatOrder: FormatOrderKey[]
  /** Memory rows for the `memory` template card. */
  memories?: PromptMessage[]
  /** `{{position::}}` and `@@inject_at` substitution supplied by the caller. */
  positionParser?: (text: string, loc: string | undefined) => string
  /** Pushes a `[Continue the last response]` system entry under gpt/claude/openrouter/reverse_proxy. */
  isContinue?: boolean
  /**
   * The `editRequest` request-edit seam (`renderFinalPrompt.ts`).
   * Defaults to an identity transform; dispatch may supply the request-edit
   * transform.
   */
  editRequest?: (rows: PromptMessage[]) => PromptMessage[] | Promise<PromptMessage[]>
  /** Per-assembly stable-card rows shared by template preflight and final render. */
  stableCardCache?: StableCardRenderCache
  /** Index of the base character-description row after lorebook placement. */
  descriptionBaseIndex?: number
}

export interface RenderFinalPromptResult {
  formated: PromptMessage[]
  /** Defined only when the template path captured prompt-info. */
  promptText?: PromptMessage[]
}

/** Models that take the `isContinue` `[Continue the last response]` push. */
function takesContinueMarker(aiModel: string): boolean {
  return (
    aiModel.startsWith('claude') ||
    aiModel.startsWith('gpt') ||
    aiModel.startsWith('openrouter') ||
    aiModel.startsWith('reverse_proxy')
  )
}

/**
 * The top-level render entry (`renderFinalPrompt.ts`), unifying
 * the template (`renderByTemplate`) and non-template
 * (`renderByFormatOrder`) paths with the SPA's pre/post-walk steps:
 *
 *   1. `isContinue` pre-push onto `unformated.postEverything`,
 *   2. dispatch to the path renderer (each already trims its rows),
 *   3. the `depth_prompt` splice — after the trim, so the
 *      spliced row is left untrimmed, matching the SPA,
 *   4. the `editRequest` request-edit seam over `formated` and `promptInfo`.
 *
 * Returns `{ formated, promptText }`; `promptText` is the
 * (editRequest'd) prompt-info array, defined only when the template
 * path captured it.
 */
export async function renderFinalPrompt(args: RenderFinalPromptArgs): Promise<RenderFinalPromptResult> {
  const {
    ctx,
    currentChar,
    unformated,
    promptTemplate,
    usingPromptTemplate,
    formatOrder,
    memories = [],
    positionParser = (text) => text,
    isContinue = false,
    editRequest = (rows) => rows,
    stableCardCache,
    descriptionBaseIndex,
  } = args
  const aiModel = ctx.database.aiModel ?? ''

  // 1. `[Continue the last response]` pre-push (`renderFinalPrompt.ts`).
  if (isContinue && takesContinueMarker(aiModel)) {
    unformated.postEverything.push({
      role: 'system',
      content: '[Continue the last response]',
    })
  }

  // 2. Dispatch. Each path renderer already trims its rows; only
  //    the template path captures prompt-info.
  let formated: PromptMessage[]
  let promptInfo: PromptMessage[] | undefined
  if (promptTemplate) {
    ;({ formated, promptInfo } = renderByTemplate(
      ctx,
      currentChar,
      unformated,
      promptTemplate,
      usingPromptTemplate,
      positionParser,
      memories,
      stableCardCache,
      descriptionBaseIndex,
    ))
  } else {
    formated = renderByFormatOrder(unformated, formatOrder, aiModel)
    promptInfo = undefined
  }

  // 3. Character `depth_prompt` splice (`renderFinalPrompt.ts`).
  //    Runs after the trim, so the inserted row is intentionally not
  //    trimmed.
  const depthPrompt = currentChar.depth_prompt
  if (depthPrompt?.prompt && depthPrompt.prompt.length > 0) {
    formated.splice(formated.length - depthPrompt.depth, 0, {
      role: 'system',
      content: expandVariables(depthPrompt.prompt, { ...ctx, chara: currentChar }).text,
    })
  }

  // 4. `editRequest` request-edit seam (`renderFinalPrompt.ts`).
  formated = await editRequest(formated)
  let promptText: PromptMessage[] | undefined
  if (promptInfo) {
    promptText = await editRequest(promptInfo)
  }

  return { formated, promptText }
}
