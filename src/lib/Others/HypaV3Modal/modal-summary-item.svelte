<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { onDestroy, tick, untrack } from 'svelte'
  import {
    LanguagesIcon,
    StarIcon,
    RefreshCw,
    Trash2Icon,
    ScissorsLineDashed,
    XIcon,
    CheckIcon,
    TagIcon,
    ChevronUpIcon,
    ChevronDownIcon,
  } from '@lucide/svelte'
  import { language } from 'src/lang'
  import {
    type SerializableHypaV3Data,
    type SerializableSummary,
    summarize,
    getCurrentHypaV3Preset,
    ensureHypaV3SummaryResources,
  } from 'src/ts/process/memory/hypav3'
  import { type OpenAIChat } from 'src/ts/process/index.svelte'
  import { getCurrentChat, type Chat, type Message } from 'src/ts/storage/database.svelte'
  import { hydrateChatMessages } from 'src/ts/server/chatMessageHydration.svelte'
  import { translateHTML } from 'src/ts/translator/translator'
  import { alertConfirm } from 'src/ts/alert'
  import type { SummaryItemState, ExpandedMessageState, SearchState, Category, BulkEditState, UIState } from './types'
  import { alertConfirmTwice, handleDualAction, getFirstMessage, processRegexScript, getCategoryName } from './utils'
  import type { ServerSummaryPatchField } from './server-summary-patch'

  interface Props {
    summaryIndex: number
    hypaV3Data: SerializableHypaV3Data
    summaryItemStateMap: WeakMap<SerializableSummary, SummaryItemState>
    expandedMessageState: ExpandedMessageState
    searchState: SearchState
    filterSelected: boolean
    categories: Category[]
    bulkEditState?: BulkEditState
    uiState?: UIState
    readOnly?: boolean
    tagsReadOnly?: boolean
    inactiveModel?: string
    onToggleSummarySelection?: (index: number) => void
    onOpenTagManager?: (index: number) => void
    onToggleCollapse?: (index: number) => void
    onSummaryInput?: (index: number) => void
    onSummaryChanged?: (index: number, field: ServerSummaryPatchField) => void | Promise<unknown>
    onDeleteSummary?: (index: number) => void | Promise<void>
    onDeleteAfter?: (index: number) => void | Promise<void>
  }

  let {
    summaryIndex,
    hypaV3Data,
    summaryItemStateMap,
    expandedMessageState = $bindable(),
    searchState = $bindable(),
    filterSelected,
    categories,
    bulkEditState,
    uiState,
    readOnly = false,
    tagsReadOnly = false,
    inactiveModel,
    onToggleSummarySelection,
    onOpenTagManager,
    onToggleCollapse,
    onSummaryInput,
    onSummaryChanged,
    onDeleteSummary,
    onDeleteAfter,
  }: Props = $props()

  const summary = $derived(hypaV3Data.summaries[summaryIndex])
  const summaryItemState = $state<SummaryItemState>({
    originalRef: null,
    translationRef: null,
    rerolledTranslationRef: null,
    chatMemoRefs: null,
  })

  let isTranslating = $state(false)
  let translation = $state<string | null>(null)
  let isRerolling = $state(false)
  let rerolled = $state<string | null>(null)
  let rerollReady = $state(false)
  let isTranslatingRerolled = $state(false)
  let rerolledTranslation = $state<string | null>(null)
  let componentActive = true
  let deletionOwnerActive = true
  let translationRun = 0
  let rerollRun = 0
  let rerolledTranslationRun = 0
  let expandedTranslationRun = 0
  let connectedMessageHydrationRun = 0
  let connectedMessageHydrationState = $state<'ready' | 'loading' | 'error'>('ready')
  let connectedMessageHydrationPromise: Promise<boolean> | null = null

  interface SummaryDeletionTarget {
    summary: SerializableSummary
  }

  onDestroy(() => {
    componentActive = false
    deletionOwnerActive = false
    translationRun += 1
    rerollRun += 1
    rerolledTranslationRun += 1
    expandedTranslationRun += 1
    connectedMessageHydrationRun += 1
  })

  function ownsSummary(candidate: SerializableSummary): boolean {
    return componentActive && summary === candidate && hypaV3Data.summaries.includes(candidate)
  }

  function isCurrentTranslation(run: number, owner: SerializableSummary, source: string): boolean {
    return run === translationRun && ownsSummary(owner) && owner.text === source
  }

  function cancelTranslation(): void {
    translationRun += 1
    isTranslating = false
    translation = null
  }

  function isCurrentReroll(run: number, owner: SerializableSummary): boolean {
    return run === rerollRun && ownsSummary(owner)
  }

  function cancelRerolledTranslation(): void {
    rerolledTranslationRun += 1
    isTranslatingRerolled = false
    rerolledTranslation = null
  }

  function isCurrentRerolledTranslation(run: number, owner: SerializableSummary, source: string): boolean {
    return run === rerolledTranslationRun && ownsSummary(owner) && rerolled === source && rerollReady
  }

  function isCurrentExpandedTranslation(
    run: number,
    owner: SerializableSummary,
    ownerState: NonNullable<ExpandedMessageState>,
  ): boolean {
    return (
      run === expandedTranslationRun &&
      ownsSummary(owner) &&
      expandedMessageState === ownerState &&
      ownerState.summaryIndex === summaryIndex
    )
  }

  function captureSummaryDeletionTarget(): SummaryDeletionTarget | null {
    if (!summary || !hypaV3Data.summaries.includes(summary)) return null
    return { summary }
  }

  function resolveSummaryDeletionIndex(target: SummaryDeletionTarget): number {
    if (!deletionOwnerActive) return -1
    return hypaV3Data.summaries.indexOf(target.summary)
  }

  $effect.pre(() => {
    summaryItemStateMap.set(summary, summaryItemState)
  })

  function hasNonresidentConnectedMessages(owner: SerializableSummary, chat: Chat): boolean {
    const residentMessageIds = new Set(chat.message.map((message) => message.chatId))
    return owner.chatMemos.some((chatMemo) => chatMemo !== null && !residentMessageIds.has(chatMemo))
  }

  async function ensureConnectedMessages(owner: SerializableSummary = summary): Promise<boolean> {
    const chat = getCurrentChat()
    if (!hasNonresidentConnectedMessages(owner, chat)) {
      if (connectedMessageHydrationState !== 'ready') connectedMessageHydrationState = 'ready'
      return true
    }
    if (!chat.id) {
      connectedMessageHydrationState = 'error'
      return false
    }
    if (connectedMessageHydrationPromise) return connectedMessageHydrationPromise

    const chatId = chat.id
    const run = ++connectedMessageHydrationRun
    connectedMessageHydrationState = 'loading'
    let hydrationPromise: Promise<boolean>
    hydrationPromise = (async () => {
      try {
        await hydrateChatMessages(chatId, { strict: true })
        if (run !== connectedMessageHydrationRun || !ownsSummary(owner) || getCurrentChat().id !== chatId) {
          return false
        }
        connectedMessageHydrationState = 'ready'
        return true
      } catch {
        if (run === connectedMessageHydrationRun && ownsSummary(owner) && getCurrentChat().id === chatId) {
          connectedMessageHydrationState = 'error'
        }
        return false
      } finally {
        if (connectedMessageHydrationPromise === hydrationPromise) connectedMessageHydrationPromise = null
      }
    })()
    connectedMessageHydrationPromise = hydrationPromise
    return hydrationPromise
  }

  $effect(() => {
    const owner = summary
    const chat = getCurrentChat()
    owner.chatMemos
    chat.message
    if (!hasNonresidentConnectedMessages(owner, chat)) {
      if (connectedMessageHydrationState !== 'ready') connectedMessageHydrationState = 'ready'
      return
    }
    untrack(() => void ensureConnectedMessages(owner))
  })

  $effect.pre(() => {
    summary?.chatMemos?.length

    untrack(() => {
      summaryItemState.chatMemoRefs = new Array(summary.chatMemos.length).fill(null)

      expandedMessageState = null
      searchState = null
    })
  })

  async function toggleTranslate(regenerate: boolean): Promise<void> {
    if (isTranslating) return

    if (translation) {
      translation = null
      return
    }

    const owner = summary
    const source = owner.text
    const run = ++translationRun

    isTranslating = true
    translation = `${language.loading}...`

    // Focus on translation element after it's rendered
    await tick()

    if (!isCurrentTranslation(run, owner, source)) return

    if (summaryItemState.translationRef) {
      summaryItemState.translationRef.focus()
      summaryItemState.translationRef.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    }

    // Translate
    const result = await translate(source, regenerate)

    if (!isCurrentTranslation(run, owner, source)) {
      if (run === translationRun && ownsSummary(owner)) {
        isTranslating = false
        translation = null
      }
      return
    }
    translation = result
    isTranslating = false
  }

  function handleSummaryInput(): void {
    cancelTranslation()
    onSummaryInput?.(summaryIndex)
  }

  async function translate(text: string, regenerate: boolean): Promise<string> {
    try {
      return await translateHTML(text, false, '', -1, regenerate)
    } catch (error) {
      return `Translation failed: ${error}`
    }
  }

  function toggleImportant(): void {
    summary.isImportant = !summary.isImportant
    void onSummaryChanged?.(summaryIndex, 'isImportant')
  }

  function isOrphan(): boolean {
    const chat = getCurrentChat()

    for (const chatMemo of summary.chatMemos) {
      if (chatMemo == null) {
        // Check first message exists
        if (!getFirstMessage()) return true
      } else {
        if (chat.message.findIndex((m) => m.chatId === chatMemo) === -1) return true
      }
    }

    return false
  }

  async function toggleReroll(): Promise<void> {
    if (isRerolling) return
    if (!(await ensureConnectedMessages())) return
    if (isOrphan()) return

    const owner = summary
    const run = ++rerollRun
    cancelRerolledTranslation()
    isRerolling = true
    rerollReady = false
    rerolled = `${language.loading}...`

    try {
      const toSummarize: OpenAIChat[] = await Promise.all(
        owner.chatMemos.map(async (chatMemo) => {
          const message = await getMessageFromChatMemo(chatMemo)
          if (!message) throw new Error('Connected message not found')

          return {
            role: (message.role === 'char' ? 'assistant' : message.role) as OpenAIChat['role'],
            content: message.data,
          }
        }),
      )

      if (!isCurrentReroll(run, owner)) return
      const summarizeResult = await summarize(toSummarize)

      if (!isCurrentReroll(run, owner)) return
      rerolled = summarizeResult
      rerollReady = true
    } catch (error) {
      if (!isCurrentReroll(run, owner)) return
      rerolled = language.hypaV3Modal.rerollFailed.replace(
        '{0}',
        error instanceof Error ? error.message : String(error),
      )
      rerollReady = false
    } finally {
      if (isCurrentReroll(run, owner)) isRerolling = false
    }
  }

  async function getMessageFromChatMemo(chatMemo: string | null): Promise<Message | null> {
    await ensureHypaV3SummaryResources()
    const shouldProcess = getCurrentHypaV3Preset().settings.processRegexScript

    let msg = null
    let msgIndex = -1

    if (chatMemo == null) {
      const firstMessage = getFirstMessage()

      if (!firstMessage) return null
      msg = { role: 'char', data: firstMessage }
    } else {
      if (!(await ensureConnectedMessages())) return null
      const chat = getCurrentChat()
      msgIndex = chat.message.findIndex((m) => m.chatId === chatMemo)
      if (msgIndex === -1) return null
      msg = chat.message[msgIndex]
    }

    return shouldProcess ? await processRegexScript(msg, msgIndex) : msg
  }

  async function deleteThis(): Promise<void> {
    const target = captureSummaryDeletionTarget()
    if (!target || !(await alertConfirm(language.hypaV3Modal.deleteThisConfirmMessage))) return

    const liveIndex = resolveSummaryDeletionIndex(target)
    if (liveIndex < 0) return
    if (onDeleteSummary) await onDeleteSummary(liveIndex)
    else hypaV3Data.summaries.splice(liveIndex, 1)
  }

  async function deleteAfter(): Promise<void> {
    const target = captureSummaryDeletionTarget()
    if (!target) return
    const targetIndex = hypaV3Data.summaries.indexOf(target.summary)
    const trailingSummaries = hypaV3Data.summaries.slice(targetIndex + 1)
    const confirmed = await alertConfirmTwice(
      language.hypaV3Modal.deleteAfterConfirmMessage,
      language.hypaV3Modal.deleteAfterConfirmSecondMessage,
    )
    if (!confirmed) return

    const liveIndex = resolveSummaryDeletionIndex(target)
    if (liveIndex < 0) return
    const liveTrailingSummaries = hypaV3Data.summaries.slice(liveIndex + 1)
    if (
      liveTrailingSummaries.length !== trailingSummaries.length ||
      liveTrailingSummaries.some((candidate, index) => candidate !== trailingSummaries[index])
    ) {
      return
    }
    if (onDeleteAfter) await onDeleteAfter(liveIndex)
    else hypaV3Data.summaries.splice(liveIndex + 1)
  }

  async function toggleTranslateRerolled(regenerate: boolean): Promise<void> {
    if (isTranslatingRerolled) return

    if (rerolledTranslation) {
      rerolledTranslation = null
      return
    }

    if (!rerolled || !rerollReady || isRerolling) return

    const owner = summary
    const source = rerolled
    const run = ++rerolledTranslationRun

    isTranslatingRerolled = true
    rerolledTranslation = `${language.loading}...`

    // Focus on rerolled translation element after it's rendered
    await tick()

    if (!isCurrentRerolledTranslation(run, owner, source)) return

    if (summaryItemState.rerolledTranslationRef) {
      summaryItemState.rerolledTranslationRef.focus()
      summaryItemState.rerolledTranslationRef.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    }

    // Translate
    const result = await translate(source, regenerate)

    if (!isCurrentRerolledTranslation(run, owner, source)) return
    rerolledTranslation = result
    isTranslatingRerolled = false
  }

  function cancelRerolled(): void {
    rerollRun += 1
    isRerolling = false
    rerollReady = false
    rerolled = null
    cancelRerolledTranslation()
  }

  function applyRerolled(): void {
    if (!rerollReady || isRerolling || !rerolled) return

    const owner = summary
    const appliedSummary = rerolled
    cancelRerolled()
    cancelTranslation()
    if (!ownsSummary(owner)) return

    owner.text = appliedSummary
    void onSummaryChanged?.(summaryIndex, 'text')
  }

  async function toggleTranslateExpandedMessage(regenerate: boolean): Promise<void> {
    if (
      !expandedMessageState ||
      expandedMessageState.summaryIndex !== summaryIndex ||
      expandedMessageState.isTranslating
    ) {
      return
    }

    if (expandedMessageState.translation) {
      expandedMessageState.translation = null
      return
    }

    const owner = summary
    const ownerState = expandedMessageState
    const run = ++expandedTranslationRun
    ownerState.isTranslating = true
    ownerState.translation = `${language.loading}...`

    let message: Message | null
    try {
      message = await getMessageFromChatMemo(ownerState.selectedChatMemo)
    } catch (error) {
      if (isCurrentExpandedTranslation(run, owner, ownerState)) {
        ownerState.translation = `Translation failed: ${error}`
        ownerState.isTranslating = false
      }
      return
    }

    if (!isCurrentExpandedTranslation(run, owner, ownerState)) return
    if (!message) {
      ownerState.translation = null
      ownerState.isTranslating = false
      return
    }

    // Focus on translation element after it's rendered
    await tick()

    if (!isCurrentExpandedTranslation(run, owner, ownerState)) return

    if (ownerState.translationRef) {
      ownerState.translationRef.focus()
      ownerState.translationRef.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    }

    // Translate
    const result = await translate(message.data, regenerate)

    if (!isCurrentExpandedTranslation(run, owner, ownerState)) return
    ownerState.translation = result
    ownerState.isTranslating = false
  }

  function isMessageExpanded(chatMemo: string | null): boolean {
    if (!expandedMessageState) return false

    return expandedMessageState.summaryIndex === summaryIndex && expandedMessageState.selectedChatMemo === chatMemo
  }

  async function toggleExpandMessage(chatMemo: string | null): Promise<void> {
    if (!(await ensureConnectedMessages())) return
    expandedTranslationRun += 1
    expandedMessageState = isMessageExpanded(chatMemo)
      ? null
      : {
          summaryIndex,
          selectedChatMemo: chatMemo,
          isTranslating: false,
          translation: null,
          translationRef: null,
        }
  }

  function toggleSummaryCollapse(): void {
    if (onToggleCollapse) {
      onToggleCollapse(summaryIndex)
    }
  }

  function isCollapsed(): boolean {
    return uiState?.collapsedSummaries?.has(summaryIndex) ?? false
  }

  function isSelected(): boolean {
    return bulkEditState?.selectedSummaries?.has(summaryIndex) ?? false
  }

  const categoryOptions = $derived.by(() => {
    const selectedId = summary.categoryId
    if (!selectedId || categories.some((category) => category.id === selectedId)) return categories
    return [...categories, { id: selectedId, name: selectedId }]
  })

  const recoveryChatId = untrack(() => getCurrentChat()?.id ?? '')
  onDestroy(
    registerWriterDraftCapture(() => {
      if (!rerollReady || !rerolled || isRerolling) return null
      const summaryId =
        (summary as SerializableSummary & { serverId?: string }).serverId ?? JSON.stringify(summary.chatMemos)
      return $state.snapshot({
        key: `memory-reroll:${recoveryChatId}:${summaryId}`,
        label: language.hypaV3Modal.summaryNumberLabel.replace('{0}', String(summaryIndex + 1)),
        fields: [{ label: language.hypaV3Modal.rerolledSummaryLabel, value: rerolled }],
        data: { summaryId, chatMemos: summary.chatMemos, text: rerolled },
        baseline: { text: summary.text },
      })
    }),
  )
</script>

<div
  class="flex flex-col p-2 border rounded-lg sm:p-4 border-zinc-700 bg-zinc-800/50 {isSelected()
    ? 'ring-2 ring-blue-500'
    : ''}">
  <!-- Original Summary Header -->
  <div class="flex items-center justify-between">
    <!-- Summary Number / Metrics Container -->
    <div class="flex items-center gap-2">
      <!-- Bulk Edit Checkbox -->
      {#if bulkEditState?.isEnabled && !readOnly}
        <input
          type="checkbox"
          class="w-4 h-4 text-blue-600 bg-zinc-900 border-zinc-600 rounded-sm focus:ring-blue-500"
          aria-label={(isSelected()
            ? language.hypaV3Modal.deselectSummaryAction
            : language.hypaV3Modal.selectSummaryAction
          ).replace('{0}', (summaryIndex + 1).toString())}
          checked={isSelected()}
          onchange={() => onToggleSummarySelection?.(summaryIndex)} />
      {/if}

      <span id={`hypav3-summary-${summaryIndex}-label`} class="text-sm text-zinc-400"
        >{language.hypaV3Modal.summaryNumberLabel.replace('{0}', (summaryIndex + 1).toString())}</span>

      {#if inactiveModel}
        <span
          data-inactive-summary-model
          class="px-2 py-1 text-xs rounded-full bg-amber-950 text-amber-200"
          title={language.hypaV3Modal.inactiveSummaryModelLabel.replace('{0}', inactiveModel)}>
          {language.hypaV3Modal.inactiveSummaryModelLabel.replace('{0}', inactiveModel)}
        </span>
      {/if}

      <!-- Category Tag -->
      {#if readOnly}
        <span class="px-2 py-1 text-xs rounded-full bg-zinc-700 text-zinc-300">
          <TagIcon class="w-3 h-3 inline mr-1" />
          {getCategoryName(summary.categoryId, categories)}
        </span>
      {:else}
        <label class="flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-zinc-700 text-zinc-300">
          <TagIcon class="w-3 h-3" />
          <select
            class="max-w-36 bg-transparent text-zinc-200 focus:outline-hidden [color-scheme:dark]"
            aria-label={language.hypaV3Modal.summaryCategoryLabel.replace('{0}', (summaryIndex + 1).toString())}
            value={summary.categoryId ?? ''}
            onchange={(event) => {
              summary.categoryId = event.currentTarget.value || undefined
              void onSummaryChanged?.(summaryIndex, 'categoryId')
            }}>
            {#each categoryOptions as category}
              <option value={category.id} class="bg-zinc-900 text-zinc-200">{category.name}</option>
            {/each}
          </select>
        </label>
      {/if}

      <!-- Individual Tags -->
      {#if summary.tags && summary.tags.length > 0}
        {#each summary.tags as tag}
          <button
            class="px-2 py-1 text-xs rounded-full bg-blue-600 text-white transition-colors {readOnly || tagsReadOnly
              ? 'cursor-default'
              : 'hover:bg-blue-500'}"
            disabled={readOnly || tagsReadOnly}
            onclick={() => onOpenTagManager?.(summaryIndex)}>
            #{tag}
          </button>
        {/each}
      {/if}

      <!-- Add Tag Button -->
      {#if !readOnly && !tagsReadOnly}
        <button
          class="px-2 py-1 text-xs rounded-full bg-zinc-600 hover:bg-zinc-500 text-zinc-300 transition-colors"
          onclick={() => onOpenTagManager?.(summaryIndex)}
          title={language.hypaV3Modal.tagManager}>
          + {language.hypaV3Modal.tag}
        </button>
      {/if}

      {#if filterSelected && hypaV3Data.metrics}
        <div class="flex flex-wrap gap-1">
          {#if hypaV3Data.metrics.lastImportantSummaries.includes(summaryIndex)}
            <span class="px-1.5 py-0.5 rounded-full text-xs whitespace-nowrap text-purple-200 bg-purple-900/70">
              Important
            </span>
          {/if}
          {#if hypaV3Data.metrics.lastRecentSummaries.includes(summaryIndex)}
            <span class="px-1.5 py-0.5 rounded-full text-xs whitespace-nowrap text-blue-200 bg-blue-900/70">
              Recent
            </span>
          {/if}
          {#if hypaV3Data.metrics.lastSimilarSummaries.includes(summaryIndex)}
            <span class="px-1.5 py-0.5 rounded-full text-xs whitespace-nowrap text-green-200 bg-green-900/70">
              Similar
            </span>
          {/if}
          {#if hypaV3Data.metrics.lastRandomSummaries.includes(summaryIndex)}
            <span class="px-1.5 py-0.5 rounded-full text-xs whitespace-nowrap text-yellow-200 bg-yellow-900/70">
              Random
            </span>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Buttons Container -->
    <div class="flex items-center gap-2">
      <!-- Translate Button -->
      <button
        class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
        data-summary-action="translate"
        aria-label={language.hypaV3Modal.toggleSummaryTranslationAction}
        aria-pressed={translation !== null}
        title={language.hypaV3Modal.toggleSummaryTranslationAction}
        use:handleDualAction={{
          onMainAction: () => toggleTranslate(false),
          onAlternativeAction: () => toggleTranslate(true),
        }}>
        <LanguagesIcon class="w-4 h-4" />
      </button>

      {#if !readOnly}
        <!-- Important Button -->
        <button
          class="p-2 transition-colors {summary.isImportant
            ? 'text-yellow-400 hover:text-yellow-300'
            : 'text-zinc-400 hover:text-zinc-200'}"
          data-summary-action="important"
          aria-label={language.hypaV3Modal.toggleSummaryImportantAction}
          aria-pressed={summary.isImportant}
          title={language.hypaV3Modal.toggleSummaryImportantAction}
          onclick={toggleImportant}>
          <StarIcon class="w-4 h-4" />
        </button>

        <!-- Reroll Button -->
        <button
          class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
          data-summary-action="reroll"
          aria-label={language.hypaV3Modal.rerollSummaryAction}
          title={language.hypaV3Modal.rerollSummaryAction}
          disabled={connectedMessageHydrationState === 'loading' ||
            (connectedMessageHydrationState === 'ready' && isOrphan())}
          onclick={async () => await toggleReroll()}>
          <RefreshCw class="w-4 h-4" />
        </button>

        <!-- Delete This Button -->
        <button
          class="p-2 transition-colors text-zinc-400 hover:text-rose-300"
          aria-label={language.hypaV3Modal.deleteSummaryAction}
          title={language.hypaV3Modal.deleteSummaryAction}
          onclick={async () => await deleteThis()}>
          <Trash2Icon class="w-4 h-4" />
        </button>

        <!-- Delete After Button -->
        <button
          class="p-2 transition-colors text-zinc-400 hover:text-rose-300"
          aria-label={language.hypaV3Modal.deleteFollowingSummariesAction}
          title={language.hypaV3Modal.deleteFollowingSummariesAction}
          onclick={async () => await deleteAfter()}>
          <ScissorsLineDashed class="w-4 h-4" />
        </button>
      {/if}
    </div>
  </div>

  <!-- Original Summary -->
  <div class="mt-2 sm:mt-4">
    <textarea
      class="w-full p-2 transition-colors border rounded-sm sm:p-4 min-h-40 sm:min-h-56 resize-vertical border-zinc-700 focus:outline-hidden focus:ring-2 focus:ring-zinc-500 text-zinc-200 bg-zinc-900"
      aria-labelledby={`hypav3-summary-${summaryIndex}-label`}
      bind:this={summaryItemState.originalRef}
      bind:value={summary.text}
      readonly={readOnly}
      oninput={handleSummaryInput}
      onchange={() => void onSummaryChanged?.(summaryIndex, 'text')}
      onfocus={() => {
        if (searchState && !searchState.isNavigating) {
          searchState.requestedSearchFromIndex = summaryIndex
        }
      }}>
    </textarea>
  </div>

  <!-- Original Summary Translation -->
  {#if translation}
    <div class="mt-2 sm:mt-4">
      <div id={`hypav3-summary-${summaryIndex}-translation-label`} class="mb-2 text-sm sm:mb-4 text-zinc-400">
        {language.hypaV3Modal.translationLabel}
      </div>

      <textarea
        class="w-full p-2 transition-colors border rounded-sm sm:p-4 min-h-40 sm:min-h-56 resize-vertical border-zinc-700 focus:outline-hidden text-zinc-200 bg-zinc-900"
        aria-labelledby={`hypav3-summary-${summaryIndex}-translation-label`}
        readonly
        tabindex="-1"
        bind:this={summaryItemState.translationRef}
        value={translation}></textarea>
    </div>
  {/if}

  {#if rerolled}
    <!-- Rerolled Summary Header -->
    <div class="mt-2 sm:mt-4">
      <div class="flex items-center justify-between">
        <span id={`hypav3-summary-${summaryIndex}-rerolled-label`} class="text-sm text-zinc-400">
          {language.hypaV3Modal.rerolledSummaryLabel}
        </span>
        <div class="flex items-center gap-2">
          <!-- Translate Rerolled Button -->
          <button
            class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
            data-summary-action="translate-rerolled"
            aria-label={language.hypaV3Modal.toggleRerolledSummaryTranslationAction}
            aria-pressed={rerolledTranslation !== null}
            title={language.hypaV3Modal.toggleRerolledSummaryTranslationAction}
            disabled={isRerolling || !rerollReady}
            use:handleDualAction={{
              onMainAction: () => toggleTranslateRerolled(false),
              onAlternativeAction: () => toggleTranslateRerolled(true),
            }}>
            <LanguagesIcon class="w-4 h-4" />
          </button>

          <!-- Cancel Button -->
          <button
            class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
            data-summary-action="cancel-rerolled"
            aria-label={language.hypaV3Modal.cancelRerollAction}
            title={language.hypaV3Modal.cancelRerollAction}
            onclick={cancelRerolled}>
            <XIcon class="w-4 h-4" />
          </button>

          <!-- Apply Button -->
          <button
            class="p-2 transition-colors text-zinc-400 hover:text-rose-300"
            data-summary-action="apply-rerolled"
            aria-label={language.hypaV3Modal.applyRerollAction}
            title={language.hypaV3Modal.applyRerollAction}
            disabled={isRerolling || !rerollReady || !rerolled}
            onclick={applyRerolled}>
            <CheckIcon class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>

    <!-- Rerolled Summary -->
    <div class="mt-2 sm:mt-4">
      <textarea
        class="w-full p-2 transition-colors border rounded-sm sm:p-4 min-h-40 sm:min-h-56 resize-vertical border-zinc-700 focus:outline-hidden focus:ring-2 focus:ring-zinc-500 text-zinc-200 bg-zinc-900"
        aria-labelledby={`hypav3-summary-${summaryIndex}-rerolled-label`}
        bind:value={rerolled}
        readonly={isRerolling || !rerollReady}
        oninput={cancelRerolledTranslation}>
      </textarea>
    </div>

    <!-- Rerolled Summary Translation -->
    {#if rerolledTranslation}
      <div class="mt-2 sm:mt-4">
        <div
          id={`hypav3-summary-${summaryIndex}-rerolled-translation-label`}
          class="mb-2 text-sm sm:mb-4 text-zinc-400">
          {language.hypaV3Modal.rerolledTranslationLabel}
        </div>

        <textarea
          class="w-full p-2 transition-colors border rounded-sm sm:p-4 min-h-40 sm:min-h-56 resize-vertical border-zinc-700 focus:outline-hidden text-zinc-200 bg-zinc-900"
          aria-labelledby={`hypav3-summary-${summaryIndex}-rerolled-translation-label`}
          readonly
          tabindex="-1"
          bind:this={summaryItemState.rerolledTranslationRef}
          value={rerolledTranslation}></textarea>
      </div>
    {/if}
  {/if}

  <!-- Connected Messages Header -->
  <div class="mt-2 sm:mt-4">
    <div class="flex items-center justify-between">
      <button
        class="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        onclick={toggleSummaryCollapse}>
        {#if isCollapsed()}
          <ChevronDownIcon class="w-4 h-4" />
        {:else}
          <ChevronUpIcon class="w-4 h-4" />
        {/if}
        <span
          >{language.hypaV3Modal.connectedMessageCountLabel.replace('{0}', summary.chatMemos.length.toString())}</span>
      </button>

      <div class="flex items-center gap-2">
        <!-- Translate Message Button -->
        <button
          class="p-2 transition-colors text-zinc-400 hover:text-zinc-200"
          data-summary-action="translate-message"
          aria-label={language.hypaV3Modal.toggleConnectedMessageTranslationAction}
          aria-pressed={expandedMessageState?.summaryIndex === summaryIndex &&
            expandedMessageState.translation !== null}
          title={language.hypaV3Modal.toggleConnectedMessageTranslationAction}
          disabled={!expandedMessageState || expandedMessageState.summaryIndex !== summaryIndex}
          use:handleDualAction={{
            onMainAction: () => toggleTranslateExpandedMessage(false),
            onAlternativeAction: () => toggleTranslateExpandedMessage(true),
          }}>
          <LanguagesIcon class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>

  {#if !isCollapsed()}
    <!-- Connected Message IDs -->
    <div class="flex flex-wrap gap-2 mt-2 sm:mt-4">
      {#key summary.chatMemos.length}
        {#each summary.chatMemos as chatMemo, memoIndex (chatMemo)}
          <button
            class="px-3 py-2 rounded-full text-xs text-zinc-200 hover:bg-zinc-700 transition-colors bg-zinc-900 {isMessageExpanded(
              chatMemo,
            )
              ? 'ring-2 ring-zinc-500'
              : ''}"
            data-chat-memo={chatMemo ?? 'first-message'}
            bind:this={summaryItemState.chatMemoRefs[memoIndex]}
            disabled={connectedMessageHydrationState === 'loading'}
            onclick={() => void toggleExpandMessage(chatMemo)}>
            {chatMemo == null ? language.hypaV3Modal.connectedFirstMessageLabel : chatMemo}
          </button>
        {/each}
      {/key}
    </div>

    {#if expandedMessageState?.summaryIndex === summaryIndex}
      <!-- Expanded Message -->
      <div class="mt-2 sm:mt-4">
        {#await getMessageFromChatMemo(expandedMessageState.selectedChatMemo) then expandedMessage}
          {#if expandedMessage}
            <!-- Role -->
            <div
              id={`hypav3-summary-${summaryIndex}-connected-message-label`}
              class="mb-2 text-sm sm:mb-4 text-zinc-400">
              {language.hypaV3Modal.connectedMessageRoleLabel.replace('{0}', expandedMessage.role)}
            </div>

            <!-- Content -->
            <textarea
              class="w-full p-2 transition-colors border rounded-sm sm:p-4 min-h-40 sm:min-h-56 resize-vertical border-zinc-700 focus:outline-hidden text-zinc-200 bg-zinc-900"
              aria-labelledby={`hypav3-summary-${summaryIndex}-connected-message-label`}
              readonly
              tabindex="-1"
              value={expandedMessage.data}></textarea>
          {:else}
            <span class="text-sm text-red-400">{language.hypaV3Modal.connectedMessageNotFoundLabel}</span>
          {/if}
        {:catch error}
          <span class="text-sm text-red-400"
            >{language.hypaV3Modal.connectedMessageLoadingError.replace('{0}', error.message)}</span>
        {/await}
      </div>

      <!-- Expanded Message Translation -->
      {#if expandedMessageState.translation}
        <div class="mt-2 sm:mt-4">
          <div
            id={`hypav3-summary-${summaryIndex}-connected-message-translation-label`}
            class="mb-2 text-sm sm:mb-4 text-zinc-400">
            {language.hypaV3Modal.connectedMessageTranslationLabel}
          </div>

          <textarea
            class="w-full p-2 transition-colors border rounded-sm sm:p-4 min-h-40 sm:min-h-56 resize-vertical border-zinc-700 focus:outline-hidden text-zinc-200 bg-zinc-900"
            aria-labelledby={`hypav3-summary-${summaryIndex}-connected-message-translation-label`}
            readonly
            tabindex="-1"
            bind:this={expandedMessageState.translationRef}
            value={expandedMessageState.translation}></textarea>
        </div>
      {/if}
    {/if}
  {/if}
</div>
