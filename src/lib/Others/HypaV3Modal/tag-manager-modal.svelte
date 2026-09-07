<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { getCurrentChat } from 'src/ts/storage/database.svelte'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { XIcon, SquarePenIcon, Trash2Icon, CheckIcon } from '@lucide/svelte'
  import { language } from 'src/lang'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'
  import type { SerializableHypaV3Data } from 'src/ts/process/memory/hypav3'
  import type { TagManagerState } from './types'
  import type { ServerSummaryPatchField } from './server-summary-patch'

  interface Props {
    tagManagerState: TagManagerState
    hypaV3Data: SerializableHypaV3Data
    onSummaryChanged?: (index: number, field: ServerSummaryPatchField) => void | Promise<unknown>
  }

  let { tagManagerState = $bindable(), hypaV3Data, onSummaryChanged }: Props = $props()

  function closeTagManager() {
    tagManagerState.isOpen = false
    tagManagerState.currentSummaryIndex = -1
    tagManagerState.currentSummaryId = undefined
    tagManagerState.editingTag = ''
    tagManagerState.editingTagIndex = -1
  }

  function currentSummaryIndex(): number {
    if (tagManagerState.currentSummaryId) {
      return hypaV3Data.summaries.findIndex(
        (summary) => (summary as unknown as { serverId?: string }).serverId === tagManagerState.currentSummaryId,
      )
    }
    return tagManagerState.currentSummaryIndex
  }

  function addTag(summaryIndex: number, tagName: string) {
    if (summaryIndex < 0 || !tagName.trim()) return

    const summary = hypaV3Data.summaries[summaryIndex]
    if (!summary) return
    if (!summary.tags) {
      summary.tags = []
    }

    if (!summary.tags.includes(tagName.trim())) {
      summary.tags.push(tagName.trim())
      void onSummaryChanged?.(summaryIndex, 'tags')
    }
  }

  function removeTag(summaryIndex: number, tagIndex: number) {
    const summary = hypaV3Data.summaries[summaryIndex]
    if (!summary) return
    if (summary.tags && tagIndex >= 0 && tagIndex < summary.tags.length) {
      summary.tags.splice(tagIndex, 1)
      void onSummaryChanged?.(summaryIndex, 'tags')
    }
  }

  function startEditTag(tagIndex: number, tagName: string) {
    tagManagerState.editingTagIndex = tagIndex
    tagManagerState.editingTag = tagName
  }

  function saveEditingTag() {
    if (tagManagerState.editingTagIndex === -1 || !tagManagerState.editingTag.trim()) return

    const summaryIndex = currentSummaryIndex()
    const summary = hypaV3Data.summaries[summaryIndex]
    if (!summary) return
    const editingIndex = tagManagerState.editingTagIndex
    const nextTag = tagManagerState.editingTag.trim()
    if (summary.tags && editingIndex < summary.tags.length) {
      if (summary.tags.some((tag, index) => index !== editingIndex && tag === nextTag)) return
      if (summary.tags[editingIndex] !== nextTag) {
        summary.tags[editingIndex] = nextTag
        void onSummaryChanged?.(summaryIndex, 'tags')
      }
    }

    tagManagerState.editingTag = ''
    tagManagerState.editingTagIndex = -1
  }

  function cancelEditingTag() {
    tagManagerState.editingTag = ''
    tagManagerState.editingTagIndex = -1
  }

  function handleAddTagEnter() {
    addTag(currentSummaryIndex(), tagManagerState.editingTag)
    tagManagerState.editingTag = ''
  }

  function handleEditTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      saveEditingTag()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelEditingTag()
    }
  }

  function handleAddTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      handleAddTagEnter()
    }
  }

  function handleDialogKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeTagManager()
  }

  let recoveryChatId = untrack(() => getCurrentChat()?.id ?? '')
  $effect(() => {
    if (tagManagerState.isOpen) recoveryChatId = untrack(() => getCurrentChat()?.id ?? '')
  })
  onDestroy(
    registerWriterDraftCapture(() => {
      const index = currentSummaryIndex()
      const summary = hypaV3Data.summaries[index]
      const baseline =
        tagManagerState.editingTagIndex >= 0 ? (summary?.tags?.[tagManagerState.editingTagIndex] ?? '') : ''
      if (!tagManagerState.isOpen || !summary || tagManagerState.editingTag === baseline) return null
      const summaryId = tagManagerState.currentSummaryId ?? JSON.stringify(summary.chatMemos)
      return $state.snapshot({
        key: `memory-tag:${recoveryChatId}:${summaryId}`,
        label: language.hypaV3Modal.tagManagerTitle.replace('{0}', String(index + 1)),
        fields: [{ label: language.hypaV3Modal.tagNameLabel, value: tagManagerState.editingTag }],
        data: { summaryId, tagIndex: tagManagerState.editingTagIndex, tag: tagManagerState.editingTag },
        baseline: { tag: baseline },
      })
    }),
  )
</script>

<!-- Tag Manager Modal -->
{#if tagManagerState.isOpen && currentSummaryIndex() >= 0}
  <div data-modal-root class="fixed inset-0 z-50 p-4 bg-black/70 flex items-center justify-center">
    <div
      use:modalFocusTrap
      role="dialog"
      aria-modal="true"
      aria-label={language.hypaV3Modal.tagManagerTitle.replace('{0}', (currentSummaryIndex() + 1).toString())}
      tabindex="-1"
      class="bg-zinc-900 rounded-lg p-6 w-full max-w-md"
      onkeydown={handleDialogKeydown}>
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-lg font-semibold text-zinc-300">
          {language.hypaV3Modal.tagManagerTitle.replace('{0}', (currentSummaryIndex() + 1).toString())}
        </h2>
        <button
          data-modal-initial-focus
          class="p-2 text-zinc-400 hover:text-zinc-200 transition-colors"
          aria-label={language.close}
          title={language.close}
          onclick={closeTagManager}>
          <XIcon class="w-5 h-5" />
        </button>
      </div>

      <!-- Add New Tag -->
      <div class="mb-4">
        <div class="flex gap-2">
          <input
            type="text"
            class="flex-1 px-3 py-2 text-sm rounded-sm border border-zinc-600 bg-zinc-900 text-zinc-200 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
            aria-label={language.hypaV3Modal.newTagName}
            placeholder={language.hypaV3Modal.newTagName}
            bind:value={tagManagerState.editingTag}
            onkeydown={handleAddTagKeydown} />
          <button
            class="px-4 py-2 rounded-sm bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors"
            onclick={handleAddTagEnter}>
            {language.add}
          </button>
        </div>
      </div>

      <!-- Tag List -->
      <div class="space-y-2 max-h-60 overflow-y-auto">
        {#if hypaV3Data.summaries[currentSummaryIndex()]?.tags && hypaV3Data.summaries[currentSummaryIndex()].tags.length > 0}
          {#each hypaV3Data.summaries[currentSummaryIndex()].tags as tag, tagIndex}
            <div class="flex items-center gap-2 px-3 py-2 rounded-sm bg-zinc-800">
              {#if tagManagerState.editingTagIndex === tagIndex}
                <input
                  type="text"
                  class="flex-1 px-2 py-1 text-sm rounded-sm border border-zinc-600 bg-zinc-900 text-zinc-200 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
                  aria-label={language.hypaV3Modal.tagNameLabel}
                  bind:value={tagManagerState.editingTag}
                  onkeydown={handleEditTagKeydown} />
                <button
                  class="p-1.5 text-green-400 hover:text-green-300 transition-colors"
                  aria-label={language.hypaV3Modal.saveTagAction}
                  title={language.hypaV3Modal.saveTagAction}
                  onclick={saveEditingTag}>
                  <CheckIcon class="w-4 h-4" />
                </button>
                <button
                  class="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                  aria-label={language.hypaV3Modal.cancelTagEditAction}
                  title={language.hypaV3Modal.cancelTagEditAction}
                  onclick={cancelEditingTag}>
                  <XIcon class="w-4 h-4" />
                </button>
              {:else}
                <span class="flex-1 text-sm text-zinc-200">#{tag}</span>
                <button
                  class="p-1.5 text-zinc-400 hover:text-zinc-200 transition-colors"
                  aria-label={language.hypaV3Modal.editTagAction}
                  title={language.hypaV3Modal.editTagAction}
                  onclick={() => startEditTag(tagIndex, tag)}>
                  <SquarePenIcon class="w-4 h-4" />
                </button>
                <button
                  class="p-1.5 text-red-400 hover:text-red-300 transition-colors"
                  aria-label={language.hypaV3Modal.deleteTagAction}
                  title={language.hypaV3Modal.deleteTagAction}
                  onclick={() => removeTag(currentSummaryIndex(), tagIndex)}>
                  <Trash2Icon class="w-4 h-4" />
                </button>
              {/if}
            </div>
          {/each}
        {:else}
          <div class="text-center py-8 text-zinc-500 text-sm">
            {language.hypaV3Modal.noTagsYet}<br />
            <span class="text-xs">{language.hypaV3Modal.addNewTagHint}</span>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
