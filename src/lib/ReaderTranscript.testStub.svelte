<script lang="ts">
  let { characterId, chatId }: { characterId: string; chatId: string } = $props()
</script>

<div data-reader-test-transcript data-character-id={characterId} data-chat-id={chatId}>
  <textarea disabled readonly aria-label="Reader message input"></textarea>
</div>
