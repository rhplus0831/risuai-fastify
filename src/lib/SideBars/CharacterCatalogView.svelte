<script lang="ts" module>
  export interface CatalogDisplayRow {
    key: string
    id: string
    index: number
    name: string
    description: string
    hasImage: boolean
    imageStyle: string | Promise<string>
    selected: boolean
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import { User, SquareMousePointer } from '@lucide/svelte'
  import { language } from 'src/lang'
  import BarIcon from './BarIcon.svelte'
  let {
    rows,
    mode,
    onOpen,
    onPrefetch,
    actions,
  }: {
    rows: readonly CatalogDisplayRow[]
    mode: 'grid' | 'list' | 'trash'
    onOpen: (row: CatalogDisplayRow) => void
    onPrefetch: (row: CatalogDisplayRow) => void
    actions?: Snippet<[CatalogDisplayRow]>
  } = $props()
</script>

<div
  class={mode === 'grid' ? 'flex flex-wrap gap-2 w-full justify-center' : 'contents'}
  data-risu-grid-list
  data-risu-list-kind={mode}>
  {#each rows as row (row.key)}
    <div
      class={mode === 'grid'
        ? 'flex items-center text-textcolor'
        : 'flex p-2 border border-darkborderc rounded-md mb-2'}
      data-risu-grid-character-row
      data-risu-row-id={row.id}
      data-risu-row-index={row.index}
      data-risu-list-kind={mode}
      data-risu-selected={row.selected ? 'true' : 'false'}
      onpointerenter={() => onPrefetch(row)}
      onfocusin={() => onPrefetch(row)}
      role="group"
      aria-current={row.selected ? 'true' : undefined}>
      <span data-risu-grid-action="open">
        <BarIcon
          ariaLabel={language.openCharacter(row.name)}
          onClick={() => onOpen(row)}
          additionalStyle={row.imageStyle}>
          {#if mode === 'grid' && !row.hasImage}<User />{/if}
        </BarIcon>
      </span>
      {#if mode !== 'grid'}
        <div class="flex-1 min-w-0 flex flex-col ml-2">
          <h4 class="text-textcolor font-bold text-lg mb-1" data-risu-character-name>{row.name}</h4>
          <span class="text-textcolor2 whitespace-pre-wrap" data-risu-character-description>{row.description}</span>
          <div class="flex gap-2 justify-end">
            {#if mode !== 'trash'}
              <button
                type="button"
                data-risu-grid-action="open"
                aria-label={language.openCharacter(row.name)}
                class="hover:text-textcolor text-textcolor2"
                onclick={() => onOpen(row)}><SquareMousePointer /></button>
            {/if}
            {@render actions?.(row)}
          </div>
        </div>
      {/if}
    </div>
  {/each}
  {#if rows.length === 0}<p class="p-6 text-center text-textcolor2" role="status" aria-live="polite">
      {language.noSearchResults}
    </p>{/if}
</div>
