<script lang="ts">
  import { language } from 'src/lang'
  import type { character, Chat, Database } from 'src/ts/storage/database.svelte'
  import { getFileSrc } from 'src/ts/fileSource'
  import { getCharacterDisplayName, getCharacterDisplaySearchText } from 'src/ts/characterDisplayName'
  import { HomeIcon, Settings, LayoutGridIcon, FolderIcon, FolderOpenIcon, PlusIcon, PuzzleIcon } from '@lucide/svelte'
  import NavigationRail from './NavigationRail.svelte'
  import NavigationButton from './NavigationButton.svelte'
  import SidebarAvatar from './SidebarAvatar.svelte'
  import SidebarIndicator from './SidebarIndicator.svelte'
  import PinnedChatsRail from './PinnedChatsRail.svelte'
  import ChatSelectionButton from './ChatSelectionButton.svelte'
  import UnreadIndicator from './UnreadIndicator.svelte'
  import type { PinnedChatItem } from './sidebarMultitasking'
  import { buildSidebarCharacterListItems } from './sidebarCharList'
  import { readerCharacterOrder } from './readerNavigation'

  let {
    characters,
    characterOrder,
    settings,
    character: selectedCharacter,
    chats,
    selectedCharacterId,
    selectedChatId,
    homeSelected,
    gridSelected,
    loadingChats,
    unreadChatIds,
    pins,
    onHome,
    onGrid,
    onCharacter,
    onChat,
  }: {
    characters: readonly character[]
    characterOrder: Database['characterOrder']
    settings: Partial<Database>
    character: character | undefined
    chats: readonly Chat[]
    selectedCharacterId: string | null
    selectedChatId: string | null
    homeSelected: boolean
    gridSelected: boolean
    loadingChats: boolean
    unreadChatIds: ReadonlySet<string>
    pins: readonly PinnedChatItem[]
    onHome: () => void
    onGrid: () => void
    onCharacter: (id: string) => void
    onChat: (characterId: string, chatId: string) => void
  } = $props()
  let search = $state('')
  let chatSearch = $state('')
  let expanded = $state<Record<string, boolean>>({})
  let chatExpanded = $state<Record<string, boolean>>({})
  const order = $derived(readerCharacterOrder(characters, characterOrder))
  const items = $derived(buildSidebarCharacterListItems(order, characters))
  const visibleChats = $derived(
    chats.filter((chat) => chat.name?.toLocaleLowerCase().includes(chatSearch.toLocaleLowerCase())),
  )
  const folders = $derived(
    (selectedCharacter?.chatFolders ?? []).filter(
      (folder, index, all) => folder.id && all.findIndex((other) => other.id === folder.id) === index,
    ),
  )
  const panelWidth = $derived(`${24 + 4 * Math.min(3, Math.max(0, Math.trunc(Number(settings.sideBarSize) || 0)))}rem`)
  const folderIds = $derived(new Set(folders.map((folder) => folder.id)))
  const image = (path: string) => (settings.hideAllImages ? '' : getFileSrc(path))
  const matches = (index: number) =>
    getCharacterDisplaySearchText(characters[index]).toLocaleLowerCase().includes(search.toLocaleLowerCase())
  const folderOpen = (id: string, folded: boolean) => chatExpanded[`${selectedCharacterId}:${id}`] ?? !folded
  const deny = () => {}
</script>

<nav class="flex h-full min-h-0 shrink-0" aria-label={language.observerShell.navigationLabel} data-reader-navigation>
  <NavigationRail>
    <NavigationButton
      label={language.home}
      selected={homeSelected}
      enabled
      disabledReason=""
      onActivate={onHome}
      onIntent={deny}><HomeIcon /></NavigationButton>
    <NavigationButton
      label={language.grid}
      selected={gridSelected}
      enabled
      disabledReason=""
      onActivate={onGrid}
      onIntent={deny}><LayoutGridIcon /></NavigationButton>
    <NavigationButton
      label={language.settings}
      selected={false}
      enabled={false}
      disabledReason={language.connectedReaders.writeAccessRequired}
      onActivate={deny}
      onIntent={deny}><Settings /></NavigationButton>
    <NavigationButton
      label={language.plugin}
      selected={false}
      enabled={false}
      disabledReason={language.connectedReaders.writeAccessRequired}
      onActivate={deny}
      onIntent={deny}><PuzzleIcon /></NavigationButton>
    <PinnedChatsRail
      items={pins}
      generatingChatIds={new Set()}
      {unreadChatIds}
      rounded={settings.roundIcons === true}
      {selectedCharacterId}
      {selectedChatId}
      resolveImage={image}
      onPrefetch={deny}
      onOpen={(item) => onChat(item.characterId, item.chatId)} />
    <div
      class="flex grow w-full flex-col items-center overflow-x-hidden overflow-y-auto gap-2 py-3"
      data-risu-sidebar-character-controls>
      {#each items as item, index (item.type === 'folder' ? `folder:${item.id}` : `character:${characters[item.index]?.chaId}`)}
        {#if item.type === 'normal' && matches(item.index)}
          {@render avatar(item.index)}
        {:else if item.type === 'folder' && (!search || item.folder.some((child) => matches(child.index)))}
          <div
            class="flex w-full flex-col items-center gap-2 rounded-md border border-selected py-1"
            data-reader-character-folder={item.id}>
            <div class="relative">
              <SidebarAvatar
                src="slot"
                size="56"
                rounded={settings.roundIcons === true}
                name={item.name}
                color={item.color}
                backgroundimg={item.img ? image(item.img) : ''}
                ariaExpanded={!!expanded[item.id] || !!search}
                ariaControls={`reader-character-folder-${index}`}
                onClick={() => {
                  expanded[item.id] = !expanded[item.id]
                }}>
                {#if settings.showFolderName}<span class="truncate font-bold">{item.name}</span
                  >{:else if expanded[item.id] || search}<FolderOpenIcon />{:else}<FolderIcon />{/if}
              </SidebarAvatar>
            </div>
            <div
              id={`reader-character-folder-${index}`}
              class="flex flex-col items-center gap-2"
              hidden={!expanded[item.id] && !search}>
              {#each item.folder.filter( (child) => matches(child.index), ) as child (characters[child.index]?.chaId)}{@render avatar(
                  child.index,
                )}{/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
    <button
      type="button"
      disabled
      title={language.connectedReaders.writeAccessRequired}
      aria-label={`${language.addCharacter}: ${language.connectedReaders.writeAccessRequired}`}
      class="p-3 text-textcolor2 opacity-50"><PlusIcon /></button>
  </NavigationRail>
  <div
    class="setting-area h-full max-w-[calc(100vw-8rem)] min-w-0 flex flex-col overflow-hidden bg-darkbg py-4 px-3 text-textcolor"
    style:width={panelWidth}
    data-reader-chat-panel>
    <label class="mb-3 block text-sm text-textcolor2"
      >{language.search}<input
        class="mt-1 w-full rounded-md border border-darkborderc bg-bgcolor px-3 py-2 text-textcolor"
        type="search"
        bind:value={search}
        aria-label={`${language.search}: ${language.character}`} /></label>
    {#if selectedCharacter}
      <h2 class="truncate text-lg font-semibold mb-3">{getCharacterDisplayName(selectedCharacter)}</h2>
      <div class="mb-3 flex border border-selected rounded-md">
        <span class="grow p-2 text-center">{language.Chat}</span>
        <button
          type="button"
          disabled
          class="grow border-l border-selected p-2 opacity-50"
          title={language.connectedReaders.writeAccessRequired}
          aria-label={`${language.character}: ${language.connectedReaders.writeAccessRequired}`}
          >{language.character}</button>
      </div>
      <button
        type="button"
        disabled
        class="mb-3 rounded-md bg-borderc p-2 opacity-50"
        title={language.connectedReaders.writeAccessRequired}
        aria-label={`${language.newChat}: ${language.connectedReaders.writeAccessRequired}`}>{language.newChat}</button>
      <input
        class="mb-3 w-full rounded-md border border-darkborderc bg-bgcolor px-3 py-2"
        type="search"
        bind:value={chatSearch}
        aria-label={`${language.search}: ${language.observerShell.chatsLabel}`}
        placeholder={language.search} />
      <div class="min-h-0 overflow-y-auto grow" data-risu-chat-list="sidebar">
        {#each folders as folder, index (folder.id)}
          <div
            class="flex flex-col mb-2 border border-darkborderc rounded-md"
            data-risu-chat-folder-id={folder.id}
            data-risu-chat-folder-folded={!folderOpen(folder.id, folder.folded) ? 'true' : 'false'}>
            <button
              type="button"
              class="flex items-center gap-2 p-2 rounded-md text-left"
              style:background-color={folder.color ? `var(--reader-folder-${folder.color})` : undefined}
              style:color={['red', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink'].includes(folder.color ?? '')
                ? '#ffffff'
                : undefined}
              aria-expanded={folderOpen(folder.id, folder.folded) || !!chatSearch}
              aria-controls={`reader-chat-folder-${index}`}
              onclick={() => {
                chatExpanded[`${selectedCharacterId}:${folder.id}`] = !folderOpen(folder.id, folder.folded)
              }}><FolderIcon size={16} /><span>{folder.name}</span></button>
            <div
              id={`reader-chat-folder-${index}`}
              class="p-2"
              hidden={!folderOpen(folder.id, folder.folded) && !chatSearch}>
              {#each visibleChats.filter((chat) => chat.folderId === folder.id) as chat (chat.id)}{@render chatRow(
                  chat,
                )}{/each}
            </div>
          </div>
        {/each}
        {#each visibleChats.filter((chat) => !chat.folderId || !folderIds.has(chat.folderId)) as chat (chat.id)}{@render chatRow(
            chat,
          )}{/each}
        {#if loadingChats}<p role="status" class="text-sm text-textcolor2">
            {language.loadingChatData}
          </p>{:else if visibleChats.length === 0}<p role="status" class="text-sm text-textcolor2">
            {chatSearch ? language.noSearchResults : language.connectedReaders.noConversations}
          </p>{/if}
      </div>
    {:else}<p class="text-sm text-textcolor2">{language.connectedReaders.chooseCharacterHelp}</p>{/if}
  </div>
</nav>

{#snippet avatar(index: number)}
  {@const row = characters[index]}
  <div class="group relative flex items-center px-2" data-reader-character={row.chaId}>
    <SidebarIndicator isActive={selectedCharacterId === row.chaId} />
    <SidebarAvatar
      src={row.image ? image(row.image) : '/none.webp'}
      size="56"
      rounded={settings.roundIcons === true}
      name={getCharacterDisplayName(row)}
      ariaLabel={language.observerShell.openCharacter(getCharacterDisplayName(row))}
      chaId={row.chaId}
      isCurrent={selectedCharacterId === row.chaId}
      onClick={() => onCharacter(row.chaId)} />
  </div>
{/snippet}

{#snippet chatRow(chat: Chat)}
  <div
    class="risu-chats relative flex items-center text-textcolor p-2 rounded-md"
    class:bg-selected={selectedChatId === chat.id}
    data-risu-chat-id={chat.id}
    data-risu-chat-selected={selectedChatId === chat.id ? 'true' : 'false'}
    data-risu-chat-unread={chat.id && unreadChatIds.has(chat.id) ? 'true' : undefined}>
    <ChatSelectionButton
      name={chat.name}
      selected={selectedChatId === chat.id}
      pinned={chat.pinned === true}
      ariaLabel={language.observerShell.openChat(chat.name)}
      onActivate={() => {
        if (selectedCharacterId && chat.id) onChat(selectedCharacterId, chat.id)
      }} />
    {#if chat.id && unreadChatIds.has(chat.id)}<UnreadIndicator
        label={`${language.newMessage}: ${chat.name}`}
        onActivate={() => {
          if (selectedCharacterId && chat.id) onChat(selectedCharacterId, chat.id)
        }} />{/if}
  </div>
{/snippet}

<style>
  nav {
    --reader-folder-red: #7f1d1d;
    --reader-folder-yellow: #713f12;
    --reader-folder-green: #14532d;
    --reader-folder-blue: #1e3a8a;
    --reader-folder-indigo: #312e81;
    --reader-folder-purple: #581c87;
    --reader-folder-pink: #831843;
  }
</style>
