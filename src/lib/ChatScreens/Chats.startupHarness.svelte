<script lang="ts">
  import Chats from './Chats.svelte'
  import { setContext, untrack } from 'svelte'
  import { charactersResourceState, getCharacterResourceOwner } from '../../ts/server/resourceState.svelte'
  import { getChatMessageOwnerState } from '../../ts/server/chatMessageHydration.svelte'
  import { createChatReadOwners } from './chatReadOwners.svelte'
  import { CHAT_READ_OWNERS_CONTEXT } from './chatReadOwnersContext'
  let {
    characterId,
    chatId,
    loadPages = 6,
    readOnly = false,
  }: { characterId: string; chatId: string; loadPages?: number; readOnly?: boolean } = $props()
  if (untrack(() => readOnly))
    setContext(
      CHAT_READ_OWNERS_CONTEXT,
      createChatReadOwners(
        charactersResourceState,
        (id) => getChatMessageOwnerState(id)?.messages,
        () => ({ characterId, chatId }),
      ),
    )
  export function setLoadPages(value: number) {
    loadPages = value
  }
  const character = $derived(getCharacterResourceOwner(characterId))
  const messages = $derived(getChatMessageOwnerState(chatId)?.messages ?? [])
</script>

{#if character}
  <Chats
    {readOnly}
    {chatId}
    currentCharacter={character}
    {messages}
    currentUsername="User"
    userIcon=""
    {loadPages}
    rerollTarget={null}
    onReroll={() => {}}
    unReroll={() => {}}
    onNewReroll={() => {}}
    onSelectRerollCandidate={() => {}} />
{/if}
