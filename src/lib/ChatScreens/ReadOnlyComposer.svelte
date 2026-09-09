<script lang="ts">
  import { MenuIcon, PaperclipIcon, SendIcon } from '@lucide/svelte'
  import { language } from '../../lang'

  const reasonId = 'reader-composer-reason'
</script>

<section class="chat-screen-content-width mb-2 mt-2 w-full px-2" aria-labelledby={reasonId} data-reader-composer>
  <p id={reasonId} class="mb-1 text-sm text-textcolor2">
    {language.connectedReaders.composerReadOnly}
  </p>
  <div class="flex w-full items-stretch" data-read-only-composer-row>
    <button
      type="button"
      class="flex w-12 shrink-0 items-center justify-center rounded-l-md border border-darkborderc text-textcolor2 disabled:cursor-not-allowed disabled:opacity-60"
      aria-label={`${language.connectedReaders.attachments}: ${language.connectedReaders.writeAccessRequired}`}
      title={language.connectedReaders.writeAccessRequired}
      disabled
      data-reader-composer-attachment>
      <PaperclipIcon size={20} aria-hidden="true" />
    </button>
    <textarea
      rows="1"
      disabled
      readonly
      aria-label={language.messageInput}
      aria-describedby={reasonId}
      placeholder={language.connectedReaders.composerReadOnly}
      class="min-w-0 grow resize-none border-y border-darkborderc bg-transparent p-2 text-xl text-textcolor2 placeholder:text-sm"
      data-reader-composer-field="message"></textarea>
    <button
      type="button"
      class="flex w-12 shrink-0 items-center justify-center border border-darkborderc text-textcolor2 disabled:cursor-not-allowed disabled:opacity-60"
      aria-label={`${language.hotkeyDesc.send}: ${language.connectedReaders.writeAccessRequired}`}
      title={language.connectedReaders.writeAccessRequired}
      disabled
      data-reader-composer-send>
      <SendIcon size={20} aria-hidden="true" />
    </button>
    <button
      type="button"
      class="flex w-12 shrink-0 items-center justify-center rounded-r-md border-y border-r border-darkborderc text-textcolor2 disabled:cursor-not-allowed disabled:opacity-60"
      aria-label={`${language.menu}: ${language.connectedReaders.writeAccessRequired}`}
      title={language.connectedReaders.writeAccessRequired}
      disabled
      data-reader-composer-menu>
      <MenuIcon size={20} aria-hidden="true" />
    </button>
  </div>

  <!-- These fields/actions are conditional in the writer controller. Keeping
       disabled semantic owners here makes shortcut/delegation assertions
       explicit without installing any writer state or callbacks. -->
  <div hidden aria-hidden="true" data-reader-composer-alternate-controls>
    <textarea disabled readonly data-reader-composer-field="translated"></textarea>
    <textarea disabled readonly data-reader-composer-field="draft"></textarea>
    <textarea disabled readonly data-reader-composer-field="btw"></textarea>
    <button type="button" disabled data-reader-composer-sticker>{language.stickers}</button>
    <button type="button" disabled data-reader-composer-reroll>{language.reroll}</button>
  </div>
</section>
