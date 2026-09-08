<script lang="ts">
  import { untrack } from 'svelte'
  import {
    getReaderModuleDisplayDatabase,
    getReaderTranscriptPersona,
  } from 'src/ts/server/readerTranscriptProjection.svelte'
  import { resolveActiveModuleStates } from 'src/ts/moduleActivation'
  import type { character as Character, Chat, Database } from 'src/ts/storage/database.svelte'
  import { ParseMarkdown } from 'src/ts/parser/parser.svelte'
  import { language } from 'src/lang'
  import {
    captureClientSessionGeneration,
    clientSessionStore,
    isClientSessionGenerationCurrent,
    canUseClientReaderContent,
  } from 'src/ts/clientSession'
  import { disableReaderScriptControls, denyReaderScriptActivation } from './readerPassiveHtml'

  let { character, chat, userIcon }: { character: Character | undefined; chat: Chat | undefined; userIcon: string } =
    $props()
  let html = $state('')
  $effect(() => {
    const modules = resolveActiveModuleStates(
      { ...getReaderModuleDisplayDatabase(), ...getReaderTranscriptPersona() } as Database,
      character,
      chat,
    )
    const source = [character?.backgroundHTML ?? '', ...modules.map(({ module }) => module.backgroundEmbedding ?? '')]
      .filter(Boolean)
      .join('\n')
    const currentCharacter = character
    const currentChat = chat
    const currentUserIcon = userIcon
    void $clientSessionStore.generation
    html = ''
    if (!source || !currentCharacter || !currentChat || !canUseClientReaderContent()) return
    const generation = captureClientSessionGeneration()
    let cancelled = false
    // The authenticated, isolated server display transform owns CBS/scripts.
    // Browser parsing remains explicitly read-only, including its fallback.
    untrack(() => {
      void ParseMarkdown(
        source,
        currentCharacter,
        'back',
        -1,
        {},
        {
          readOnly: true,
          chatId: currentChat.id,
          readContext: { character: currentCharacter, chat: currentChat, userIcon: currentUserIcon },
        },
      )
        .then((parsed) => {
          if (!cancelled && isClientSessionGenerationCurrent(generation) && canUseClientReaderContent()) {
            html = disableReaderScriptControls(parsed, language.connectedReaders.writeAccessRequired)
          }
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
    }
  })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="absolute inset-0 overflow-hidden"
  data-reader-background
  onclickcapture={(event) => denyReaderScriptActivation(event, false)}
  onkeydowncapture={(event) => {
    if (event.key === 'Enter' || event.key === ' ') denyReaderScriptActivation(event, false)
  }}>
  {@html html}
</div>
