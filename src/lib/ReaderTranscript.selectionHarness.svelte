<script lang="ts">
  import ReaderTranscript from './ReaderTranscript.svelte'
  let { characterId, chatId }: { characterId: string; chatId: string } = $props()
  export function select(nextCharacterId: string, nextChatId: string) {
    characterId = nextCharacterId
    chatId = nextChatId
  }
</script>

<ReaderTranscript {characterId} {chatId} />
