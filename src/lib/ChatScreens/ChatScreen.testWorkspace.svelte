<script lang="ts">
  let { chatId, close }: { chatId: string; close: () => void } = $props()
</script>

<div role="dialog" aria-label="Test BardWiki workspace" data-chat-id={chatId}>
  <button onclick={close}>Close test workspace</button>
</div>
