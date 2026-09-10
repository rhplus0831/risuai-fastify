<script lang="ts">
  import { language } from 'src/lang'
  import type { character, Chat, Database } from 'src/ts/storage/database.svelte'
  import { getFileSrc } from 'src/ts/fileSource'
  import { getCharacterDisplayName, getCharacterDisplaySearchText } from 'src/ts/characterDisplayName'
  import {
    ArrowLeftIcon,
    HomeIcon,
    Settings,
    LayoutGridIcon,
    FolderIcon,
    FolderOpenIcon,
    PlusIcon,
    PuzzleIcon,
    XIcon,
  } from '@lucide/svelte'
  import NavigationRail from './NavigationRail.svelte'
  import NavigationButton from './NavigationButton.svelte'
  import HamburgerNavigationMenu from './HamburgerNavigationMenu.svelte'
  import SidebarAvatar from './SidebarAvatar.svelte'
  import SidebarIndicator from './SidebarIndicator.svelte'
  import PinnedChatsRail from './PinnedChatsRail.svelte'
  import ChatSelectionButton from './ChatSelectionButton.svelte'
  import UnreadIndicator from './UnreadIndicator.svelte'
  import type { PinnedChatItem } from './sidebarMultitasking'
  import { buildSidebarCharacterListItems } from './sidebarCharList'
  import { readerCharacterOrder } from './readerNavigation'
  import { resolveShellGeometry } from 'src/ts/gui/shellGeometry'
  import { SizeStore } from 'src/ts/stores.svelte'

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
    responsive,
    backOnly = false,
    onBack = () => {},
    onHome,
    onGrid,
    onCharacter,
    onChat,
    onClose,
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
    responsive: boolean
    backOnly?: boolean
    onBack?: () => void
    onHome: () => void
    onGrid: () => void
    onCharacter: (id: string) => void
    onChat: (characterId: string, chatId: string) => void
    onClose: () => void
  } = $props()
  let search = $state('')
  let chatSearch = $state('')
  let expanded = $state<Record<string, boolean>>({})
  let chatExpanded = $state<Record<string, boolean>>({})
  let hamburgerExpanded = $state(false)
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
  const geometry = $derived(
    resolveShellGeometry({
      responsive,
      sideBarSize: settings.sideBarSize,
      desktopSidebarColumns: settings.desktopSidebarColumns,
      mobileSidebarColumns: settings.mobileSidebarColumns,
      viewportWidthPx: $SizeStore.w,
    }),
  )
  const folderIds = $derived(new Set(folders.map((folder) => folder.id)))
  const image = (path: string) => (settings.hideAllImages ? '' : getFileSrc(path))
  const matches = (index: number) =>
    getCharacterDisplaySearchText(characters[index]).toLocaleLowerCase().includes(search.toLocaleLowerCase())
  const folderOpen = (id: string, folded: boolean) => chatExpanded[`${selectedCharacterId}:${id}`] ?? !folded
  const deny = () => {}
  const openHome = () => {
    hamburgerExpanded = false
    onHome()
  }
  const openGrid = () => {
    hamburgerExpanded = false
    onGrid()
  }
  $effect(() => {
    void settings.menuSideBar
    void settings.hamburgerButtonBottom
    hamburgerExpanded = false
  })
</script>

<nav
  class="flex h-full min-h-0 shrink-0"
  class:w-full={responsive}
  aria-label={language.readOnlyWorkspace.navigationLabel}
  data-reader-navigation>
  {#if backOnly}
    <div class="contents" inert aria-hidden="true" data-reader-restricted-rail>
      <NavigationRail columns={geometry.columns}>
        <span class="sr-only">{language.connectedReaders.writeAccessRequired}</span>
      </NavigationRail>
    </div>
    <div
      class="setting-area h-full max-w-[calc(100vw-3rem)] min-w-0 flex flex-col overflow-hidden bg-darkbg py-4 px-3 text-textcolor"
      style:width={geometry.panelWidth}
      style:min-width={responsive ? undefined : geometry.panelWidth}
      data-reader-back-only
      data-risu-shell-sidebar-panel>
      {#if responsive}
        <button
          type="button"
          data-risu-responsive-navigation-close
          class="mb-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-selected px-3 py-2 font-medium"
          onclick={onClose}><XIcon size={18} aria-hidden="true" />{language.close} {language.menu}</button>
      {/if}
      <button
        type="button"
        class="flex items-center gap-2 rounded-md border border-selected px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        onclick={onBack}
        data-reader-go-back>
        <ArrowLeftIcon size={18} />
        <span>{language.goback}</span>
      </button>
      <p class="mt-3 text-sm text-textcolor2">{language.connectedReaders.composerReadOnly}</p>
    </div>
    {#if responsive}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div aria-hidden="true" class="h-full min-w-14 grow bg-black/70" onclick={onClose}></div>
    {/if}
  {:else}
    <NavigationRail columns={geometry.columns}>
      {#if settings.menuSideBar === true}
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
      {:else if settings.hamburgerButtonBottom !== true}
        <HamburgerNavigationMenu
          expanded={hamburgerExpanded}
          disabledReason={language.connectedReaders.writeAccessRequired}
          settingsEnabled={false}
          playgroundEnabled={false}
          onToggle={() => {
            hamburgerExpanded = !hamburgerExpanded
          }}
          onSettings={deny}
          onHome={openHome}
          onPlayground={deny}
          onGrid={openGrid} />
      {/if}
      <PinnedChatsRail
        items={pins}
        generatingChatIds={new Set()}
        {unreadChatIds}
        rounded={settings.roundIcons === true}
        columns={geometry.columns}
        {selectedCharacterId}
        {selectedChatId}
        resolveImage={image}
        onPrefetch={deny}
        onOpen={(item) => onChat(item.characterId, item.chatId)}
        isInert={settings.menuSideBar !== true && hamburgerExpanded} />
      <div
        class="grid grow w-full auto-rows-min grid-flow-row content-start items-start gap-y-2 overflow-x-hidden overflow-y-auto py-3"
        style:grid-template-columns={`repeat(${geometry.columns}, minmax(0, 1fr))`}
        data-risu-sidebar-character-columns={geometry.columns}
        data-risu-sidebar-character-controls
        inert={settings.menuSideBar !== true && hamburgerExpanded}>
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
      {#if settings.menuSideBar !== true && settings.hamburgerButtonBottom === true}
        <HamburgerNavigationMenu
          expanded={hamburgerExpanded}
          bottom
          disabledReason={language.connectedReaders.writeAccessRequired}
          settingsEnabled={false}
          playgroundEnabled={false}
          onToggle={() => {
            hamburgerExpanded = !hamburgerExpanded
          }}
          onSettings={deny}
          onHome={openHome}
          onPlayground={deny}
          onGrid={openGrid} />
      {/if}
    </NavigationRail>
    <div
      class="setting-area h-full max-w-[calc(100vw-8rem)] min-w-0 flex flex-col overflow-hidden bg-darkbg py-4 px-3 text-textcolor"
      style:width={geometry.panelWidth}
      style:min-width={responsive ? undefined : geometry.panelWidth}
      data-reader-chat-panel
      data-risu-shell-sidebar-panel>
      {#if responsive}
        <button
          type="button"
          data-risu-responsive-navigation-close
          class="mb-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-selected px-3 py-2 font-medium"
          onclick={onClose}><XIcon size={18} aria-hidden="true" />{language.close} {language.menu}</button>
      {/if}
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
          aria-label={`${language.newChat}: ${language.connectedReaders.writeAccessRequired}`}
          >{language.newChat}</button>
        <input
          class="mb-3 w-full rounded-md border border-darkborderc bg-bgcolor px-3 py-2"
          type="search"
          bind:value={chatSearch}
          aria-label={`${language.search}: ${language.readOnlyWorkspace.chatsLabel}`}
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
    {#if responsive}
      <button type="button" aria-label={language.close} class="h-full min-w-14 grow bg-black/70" onclick={onClose}
      ></button>
    {/if}
  {/if}
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
      ariaLabel={language.readOnlyWorkspace.openCharacter(getCharacterDisplayName(row))}
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
      ariaLabel={language.readOnlyWorkspace.openChat(chat.name)}
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
