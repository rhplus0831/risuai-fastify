<script lang="ts">
  import { language } from 'src/lang'
  import GenerationIndicator from './GenerationIndicator.svelte'
  import UnreadIndicator from './UnreadIndicator.svelte'
  import SidebarAvatar from './SidebarAvatar.svelte'
  import type { PinnedChatItem } from './sidebarMultitasking'
  import { normalizeDesktopSidebarColumns } from '@risuai/shared-core/sidebar-columns'

  interface Props {
    items: readonly PinnedChatItem[]
    generatingChatIds: ReadonlySet<string>
    warningChatIds?: ReadonlySet<string>
    unreadChatIds?: ReadonlySet<string>
    rounded: boolean
    onOpen: (item: PinnedChatItem) => void
    selectedCharacterId: string | null
    selectedChatId: string | null
    resolveImage: (image: string) => string | Promise<string>
    onPrefetch: (item: PinnedChatItem) => void
    isInert?: boolean
    columns?: number
  }

  let {
    items,
    generatingChatIds,
    warningChatIds = new Set(),
    unreadChatIds = new Set(),
    rounded,
    onOpen,
    onPrefetch,
    selectedCharacterId,
    selectedChatId,
    resolveImage,
    isInert = false,
    columns = 1,
  }: Props = $props()

  const normalizedColumns = $derived(normalizeDesktopSidebarColumns(columns))
</script>

{#if items.length > 0}
  <nav
    class="grid max-h-[35%] w-full shrink-0 items-start gap-2 overflow-x-hidden overflow-y-auto border-b border-b-selected px-1 py-2"
    style:grid-template-columns={`repeat(${normalizedColumns}, minmax(0, 1fr))`}
    aria-label={language.pinnedChats}
    inert={isInert}
    data-risu-pinned-chat-columns={normalizedColumns}
    data-risu-pinned-chats>
    {#each items as item (`${item.characterId}:${item.chatId}`)}
      {@const isCurrent = selectedCharacterId === item.characterId && selectedChatId === item.chatId}
      <div
        class="relative flex w-full flex-col items-center rounded-md"
        class:bg-selected={isCurrent}
        role="group"
        data-risu-pinned-chat={item.chatId}
        data-risu-pinned-chat-current={isCurrent ? 'true' : 'false'}
        onpointerenter={() => onPrefetch(item)}
        onfocusin={() => onPrefetch(item)}>
        <SidebarAvatar
          src={item.characterImage ? resolveImage(item.characterImage) : '/none.webp'}
          size="42"
          {rounded}
          name={`${item.characterName} · ${item.chatName}`}
          {isCurrent}
          onClick={() => onOpen(item)} />
        <span class="mt-0.5 w-16 truncate text-center text-[10px] leading-tight text-textcolor2">
          {item.chatName}
        </span>
        {#if warningChatIds.has(item.chatId)}
          <GenerationIndicator
            state="warning"
            label={language.generationReattachFailure.sidebarWarning(item.chatName)}
            onActivate={() => onOpen(item)} />
        {:else if generatingChatIds.has(item.chatId)}
          <GenerationIndicator
            label={`${language.generatingMessage}: ${item.chatName}`}
            onActivate={() => onOpen(item)} />
        {:else if unreadChatIds.has(item.chatId)}
          <UnreadIndicator label={`${language.newMessage}: ${item.chatName}`} onActivate={() => onOpen(item)} />
        {/if}
      </div>
    {/each}
  </nav>
{/if}
