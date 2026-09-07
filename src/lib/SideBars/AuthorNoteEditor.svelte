<script module lang="ts">
  let nextAuthorNoteEditorFlushId = 1
</script>

<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { captureClientSessionGeneration, isClientSessionGenerationCurrent } from 'src/ts/clientSession'

  import { onDestroy, untrack } from 'svelte'

  import { language } from 'src/lang'
  import {
    applyChatNoteValueLocally,
    dispatchStagedChatNoteMutation,
    stageChatNoteMutation,
    type ChatScriptstateSnapshot,
    type StagedChatNoteMutation,
  } from 'src/ts/chatCommands'
  import type { character } from 'src/ts/storage/database.svelte'
  import { tokenizeAccurate } from 'src/ts/tokenizer'
  import { getAuthorNoteDefaultText } from 'src/ts/utilState'
  import type { ServerCommandTransportOptions } from 'src/ts/server/commands'
  import { registerPendingOwnerMutationFlusher } from 'src/ts/server/pendingOwnerMutationRegistry'
  import { acknowledgePendingMutation } from 'src/ts/server/pendingMutationOutbox'
  import { registerDurableMutationSettlementListener } from 'src/ts/server/durableMutationDispatch'

  import Help from '../Others/Help.svelte'
  import TextAreaInput from '../UI/GUI/TextAreaInput.svelte'

  interface Props {
    chara: character
  }

  let { chara }: Props = $props()

  let authorNoteDraft = $state('')
  let authorNoteChatId: string | null = $state(null)
  let authorNoteServerNote = ''
  let authorNoteLastSubmitted = ''
  let authorNoteRecoveryBaseline = ''
  const noteSettlementCleanups = new Map<string, () => void>()
  let tokenCount = $state(0)
  let lastTokenizedNote = ''
  let tokenizeRun = 0
  let authorNoteSaveTimer: ReturnType<typeof setTimeout> | null = null
  let pendingAuthorNoteSave: (StagedChatNoteMutation & { rollback: ChatScriptstateSnapshot }) | null = null

  async function loadTokenCount(note: string, run: number): Promise<void> {
    if (lastTokenizedNote === note) return
    const count = await tokenizeAccurate(note)
    if (run !== tokenizeRun) return
    lastTokenizedNote = note
    tokenCount = count
  }

  function scheduleTokenize(note: string): void {
    const run = ++tokenizeRun
    setTimeout(() => {
      requestAnimationFrame(() => {
        if (run !== tokenizeRun) return
        void loadTokenCount(note, run)
      })
    }, 0)
  }

  function clearAuthorNoteSaveTimer(): void {
    if (!authorNoteSaveTimer) return
    clearTimeout(authorNoteSaveTimer)
    authorNoteSaveTimer = null
  }

  function clearPendingAuthorNoteSave(): void {
    clearAuthorNoteSaveTimer()
    if (pendingAuthorNoteSave) {
      noteSettlementCleanups.get(pendingAuthorNoteSave.outbox.mutationId)?.()
      noteSettlementCleanups.delete(pendingAuthorNoteSave.outbox.mutationId)
      void acknowledgePendingMutation(pendingAuthorNoteSave.outbox)
    }
    pendingAuthorNoteSave = null
  }

  function flushPendingAuthorNoteSave(options: ServerCommandTransportOptions = {}): void {
    const pending = pendingAuthorNoteSave
    if (!pending) return
    clearAuthorNoteSaveTimer()
    pendingAuthorNoteSave = null
    authorNoteLastSubmitted = pending.note
    const sessionGeneration = captureClientSessionGeneration()
    void dispatchStagedChatNoteMutation(pending, pending.rollback, options).then((result) => {
      if (
        result.status === 'ok' &&
        pending.chatId === authorNoteChatId &&
        isClientSessionGenerationCurrent(sessionGeneration)
      ) {
        authorNoteRecoveryBaseline = pending.note
      }
    })
  }

  function scheduleAuthorNoteSave(chatId: string, note: string, rollback: ChatScriptstateSnapshot): void {
    clearAuthorNoteSaveTimer()
    const previousPending = pendingAuthorNoteSave?.chatId === chatId ? pendingAuthorNoteSave : null
    const staged = stageChatNoteMutation({
      chatId,
      characterId: chara?.chaId,
      note,
      previous: previousPending?.outbox,
    })
    if (previousPending && previousPending.outbox.mutationId !== staged.outbox.mutationId) {
      noteSettlementCleanups.get(previousPending.outbox.mutationId)?.()
      noteSettlementCleanups.delete(previousPending.outbox.mutationId)
    }
    const sessionGeneration = captureClientSessionGeneration()
    noteSettlementCleanups.get(staged.outbox.mutationId)?.()
    const stopSettlement = registerDurableMutationSettlementListener(staged.outbox.mutationId, (settlement) => {
      stopSettlement()
      noteSettlementCleanups.delete(staged.outbox.mutationId)
      if (
        settlement === 'accepted' &&
        chatId === authorNoteChatId &&
        isClientSessionGenerationCurrent(sessionGeneration)
      ) {
        authorNoteRecoveryBaseline = note
      }
    })
    noteSettlementCleanups.set(staged.outbox.mutationId, stopSettlement)
    pendingAuthorNoteSave = {
      ...staged,
      rollback: previousPending?.rollback ?? rollback,
    }
    const correctionOnly =
      previousPending?.rollback.note !== undefined &&
      note === previousPending.rollback.note &&
      note !== previousPending.note
    if (correctionOnly) {
      flushPendingAuthorNoteSave()
    } else {
      authorNoteSaveTimer = setTimeout(flushPendingAuthorNoteSave, 250)
    }
  }

  function handleAuthorNoteInput(note: string): void {
    const chatId = authorNoteChatId
    if (!chatId) {
      clearPendingAuthorNoteSave()
      return
    }
    const previousPending = pendingAuthorNoteSave?.chatId === chatId ? pendingAuthorNoteSave : null
    if (previousPending?.note === note) return

    const rollback = applyChatNoteValueLocally(chatId, note)
    if (!rollback) return
    authorNoteServerNote = note

    if (!previousPending && note === authorNoteLastSubmitted) return
    scheduleAuthorNoteSave(chatId, note, rollback)
  }

  $effect.pre(() => {
    const note = authorNoteDraft
    untrack(() => {
      scheduleTokenize(note)
    })
  })

  $effect(() => {
    const chat = chara?.chats?.[chara.chatPage]
    const nextChatId = chat?.id ?? null
    const nextNote = chat?.note ?? ''
    if (nextChatId !== authorNoteChatId) {
      untrack(flushPendingAuthorNoteSave)
      authorNoteChatId = nextChatId
      authorNoteDraft = nextNote
      authorNoteServerNote = nextNote
      authorNoteLastSubmitted = nextNote
      authorNoteRecoveryBaseline = nextNote
    } else if (nextNote !== authorNoteServerNote) {
      authorNoteRecoveryBaseline = nextNote
      authorNoteServerNote = nextNote
      if (authorNoteDraft === authorNoteLastSubmitted) {
        authorNoteDraft = nextNote
      }
      authorNoteLastSubmitted = nextNote
    }
  })

  const unregisterPendingAuthorNoteFlush = registerPendingOwnerMutationFlusher(
    `author-note-editor:${nextAuthorNoteEditorFlushId++}`,
    flushPendingAuthorNoteSave,
  )

  const unregisterWriterDraft = registerWriterDraftCapture(() => {
    if (!authorNoteChatId || authorNoteDraft === authorNoteRecoveryBaseline) return null
    return {
      key: `author-note:${chara.chaId}:${authorNoteChatId}`,
      label: `${chara.name}: ${language.authorNote}`,
      fields: [{ label: language.authorNote, value: authorNoteDraft }],
      data: { note: authorNoteDraft },
      baseline: { note: authorNoteRecoveryBaseline },
    }
  })

  onDestroy(() => {
    unregisterWriterDraft()
    for (const stopSettlement of noteSettlementCleanups.values()) stopSettlement()
    noteSettlementCleanups.clear()
    unregisterPendingAuthorNoteFlush()
    flushPendingAuthorNoteSave()
  })
</script>

<div data-risu-chat-author-note>
  <span class="text-textcolor">{language.authorNote} <Help key="chatNote" /></span>
  <TextAreaInput
    margin="both"
    autocomplete="off"
    ariaLabel={language.authorNote}
    bind:value={authorNoteDraft}
    onInput={handleAuthorNoteInput}
    popupEditorContext={authorNoteChatId}
    highlight
    placeholder={getAuthorNoteDefaultText()} />
  <span class="text-textcolor2 mb-6 text-sm">{tokenCount} {language.tokens}</span>
</div>
