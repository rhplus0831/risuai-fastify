<script lang="ts" module>
  export function resolveSelectedCharacterForDisplay<T>(
    owner: T | undefined,
    resourceStatus: string,
    compatibilityOwner: T | undefined,
  ): T | undefined {
    if (resourceStatus === 'ready') return owner
    if (resourceStatus === 'idle' || resourceStatus === 'loading') return compatibilityOwner
    return undefined
  }
</script>

<script lang="ts">
  import {
    getCustomBackground,
    getEmotionForCharacter,
    getSelectedCharacterOwner,
    selectCharacterOwner,
  } from '../../ts/characterState'

  import { isServerCharacterShell, type character } from 'src/ts/storage/database.svelte'
  import { charactersResourceState, getChatMetadataOwnerState } from 'src/ts/server/resourceState.svelte'
  import { bardWikiWorkspaceOpenRequest, CharEmotion, selectedCharID } from '../../ts/stores.svelte'
  import ResizeBox from './ResizeBox.svelte'
  import DefaultChatScreen from './DefaultChatScreen.svelte'
  import ChatScreenLayout from './ChatScreenLayout.svelte'
  import TransitionImage from './TransitionImage.svelte'
  import BackgroundDom from './BackgroundDom.svelte'
  import SideBarArrow from '../UI/GUI/SideBarArrow.svelte'
  import { createLatestBackgroundLoader } from './ChatScreenBackground'
  import LazyComponent from '../UI/LazyComponent.svelte'
  import CharacterShellHydrationGate from './CharacterShellHydrationGate.svelte'
  import { currentRoute, type AppRoute } from 'src/ts/router'
  import { language } from 'src/lang'
  import { displaySettingsForPaint } from 'src/ts/gui/displaySettings'

  let { route }: { route?: AppRoute } = $props()
  let visibleRoute = $derived(route ?? $currentRoute)

  const loadChatList = () => import('../Others/ChatList.svelte')
  const loadModuleChatMenu = () => import('../Setting/Pages/Module/ModuleChatMenu.svelte')
  const loadBardWikiWorkspace = () => import('./BardWikiWorkspace.svelte')
  let openChatList = $state(false)
  let openModuleList = $state(false)
  let openBardWiki = $state(false)
  let bardWikiChatId = $state<string | null>(null)
  let selectedCharacter = $derived.by(() => {
    // Home, Settings, and non-chat Playground routes intentionally clear the
    // view selection without changing the durable last-selected character.
    // Do not let that retained owner activate the shell-hydration gate over a
    // route that is supposed to render a menu.
    if ($selectedCharID < 0) return undefined
    const status = charactersResourceState.status
    const character = resolveSelectedCharacterForDisplay(
      status === 'ready' ? getSelectedCharacterOwner() : undefined,
      status,
      status === 'idle' || status === 'loading'
        ? selectCharacterOwner(charactersResourceState.characters, $selectedCharID)
        : undefined,
    )
    if (character?.chaId && charactersResourceState.rowStatuses[character.chaId] === 'error') return undefined
    return character
  })

  function stableId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0
  }

  function uniqueSelectedChatId(characterOwner: character | undefined): string | null {
    const characterId = characterOwner?.chaId
    const chatId = characterOwner?.chats?.[characterOwner.chatPage]?.id
    if (!stableId(characterId) || !stableId(chatId)) return null
    if (charactersResourceState.characters.filter((character) => character?.chaId === characterId).length !== 1) {
      return null
    }
    const matchCount = charactersResourceState.characters.reduce(
      (count, character) => count + (character.chats ?? []).filter((chat) => chat?.id === chatId).length,
      0,
    )
    return matchCount === 1 ? chatId : null
  }

  let selectedChatId = $derived.by(() => {
    const chatId = uniqueSelectedChatId(selectedCharacter)
    if (!chatId) return null
    if (charactersResourceState.status === 'ready') return getChatMetadataOwnerState(chatId)?.chatId ?? null
    if (charactersResourceState.status !== 'idle' && charactersResourceState.status !== 'loading') return null
    return chatId
  })
  let selectedCharacterShellId = $derived(
    isServerCharacterShell(selectedCharacter) ? (selectedCharacter?.chaId ?? null) : null,
  )

  $effect(() => {
    if (!openBardWiki) {
      bardWikiChatId = null
      return
    }
    if (!selectedChatId) {
      openBardWiki = false
      return
    }
    if (bardWikiChatId === null) {
      bardWikiChatId = selectedChatId
      return
    }
    if (bardWikiChatId !== selectedChatId) openBardWiki = false
  })

  $effect(() => {
    const request = $bardWikiWorkspaceOpenRequest
    if (!request || !selectedChatId || selectedCharacter?.chaId !== request.characterId) return
    if (request.chatId && request.chatId !== selectedChatId) return
    openBardWiki = true
    bardWikiWorkspaceOpenRequest.set(null)
  })

  let displaySettings = $derived(displaySettingsForPaint())
  let bgImg = $state('')
  let lastBg = $state('')
  const loadLatestBackground = createLatestBackgroundLoader(getCustomBackground)
  $effect.pre(() => {
    ;(async () => {
      const customBackground =
        typeof displaySettings.customBackground === 'string' ? displaySettings.customBackground : ''
      if (customBackground !== lastBg) {
        lastBg = customBackground
        const loadedBackground = await loadLatestBackground(customBackground)
        if (loadedBackground !== undefined) {
          bgImg = loadedBackground
        }
      }
    })()
  })
</script>

{#if selectedCharacterShellId}
  <CharacterShellHydrationGate characterId={selectedCharacterShellId} />
{:else}
  <ChatScreenLayout
    settings={displaySettings}
    backgroundStyle={bgImg}
    showPortrait={selectedCharacter !== undefined && selectedCharacter.viewScreen !== 'none'}>
    {#snippet navigation()}<SideBarArrow />{/snippet}
    {#snippet background()}<BackgroundDom />{/snippet}
    {#snippet portrait(classType: 'waifu' | 'mobile')}
      {#if selectedCharacter}
        <TransitionImage {classType} src={getEmotionForCharacter(selectedCharacter, $CharEmotion, 'plain')} />
      {/if}
    {/snippet}
    {#snippet classicPortrait()}
      {#if selectedCharacter && selectedCharacter.viewScreen !== 'none' && !selectedCharacter.inlayViewScreen}
        <ResizeBox />
      {/if}
    {/snippet}
    {#snippet content(customStyle: string)}
      <DefaultChatScreen route={visibleRoute} {customStyle} bind:openChatList bind:openModuleList bind:openBardWiki />
    {/snippet}
  </ChatScreenLayout>
{/if}
{#if openChatList}
  <LazyComponent
    loader={loadChatList}
    componentProps={{ close: () => (openChatList = false) }}
    modal
    onDismiss={() => (openChatList = false)}
    testId="chat-list" />
{:else if openModuleList}
  <LazyComponent
    loader={loadModuleChatMenu}
    componentProps={{ close: () => (openModuleList = false) }}
    modal
    onDismiss={() => (openModuleList = false)}
    testId="module-chat-menu" />
{:else if openBardWiki && bardWikiChatId}
  <LazyComponent
    loader={loadBardWikiWorkspace}
    componentProps={{ chatId: bardWikiChatId, close: () => (openBardWiki = false) }}
    modal
    label={language.bardWiki.workspaceTitle}
    onDismiss={() => (openBardWiki = false)}
    testId="bardwiki-workspace" />
{/if}
