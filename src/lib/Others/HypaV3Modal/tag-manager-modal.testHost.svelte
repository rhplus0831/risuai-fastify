<script lang="ts">
  import type { CategoryManagerState, SearchState } from './types'
  import type { SerializableHypaV3Data } from 'src/ts/process/memory/hypav3'
  import type { ServerSummaryPatchField } from './server-summary-patch'
  import TagManagerModal from './tag-manager-modal.svelte'
  import CategoryManagerModal from './category-manager-modal.svelte'

  interface Props {
    category?: boolean
    onSummaryChanged?: (index: number, field: ServerSummaryPatchField) => void | Promise<unknown>
  }

  let { onSummaryChanged, category = false }: Props = $props()
  let categoryManagerState = $state<CategoryManagerState>({
    isOpen: true,
    editingCategory: { id: 'story', name: 'Story' },
    selectedCategoryFilter: 'all',
  })
  let searchState = $state<SearchState>(null as unknown as SearchState)
  let tagManagerState = $state({
    isOpen: true,
    currentSummaryIndex: 0,
    currentSummaryId: undefined as string | undefined,
    editingTag: '',
    editingTagIndex: -1,
  })
  let hypaV3Data = $state<SerializableHypaV3Data>({
    summaries: [{ text: 'Summary', chatMemos: [], tags: ['foo', 'bar'], isImportant: false }],
    categories: [{ id: 'story', name: 'Story' }],
    lastSelectedSummaries: [],
  })

  export function getTags(): string[] {
    return [...(hypaV3Data.summaries[0]?.tags ?? [])]
  }
</script>

{#if category}
  <CategoryManagerModal bind:categoryManagerState bind:searchState {hypaV3Data} />
{:else}
  <TagManagerModal bind:tagManagerState {hypaV3Data} {onSummaryChanged} />
{/if}
