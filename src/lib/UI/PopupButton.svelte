<script lang="ts">
  import { MenuIcon } from '@lucide/svelte'
  import { popupStore } from 'src/ts/stores.svelte'
  import { sleep } from 'src/ts/util'
  import { language } from 'src/lang'

  let {
    children,
    ariaLabel = language.moreActions,
    disabled = false,
    className = '',
    dataAction,
    ariaBusy = false,
  }: {
    children: import('svelte').Snippet
    ariaLabel?: string
    disabled?: boolean
    className?: string
    dataAction?: string
    ariaBusy?: boolean
  } = $props()

  let buttonId = Math.random()
  let buttonElement: HTMLButtonElement
</script>

<button
  bind:this={buttonElement}
  type="button"
  aria-label={ariaLabel}
  title={ariaLabel}
  aria-haspopup="menu"
  aria-controls="risu-popup-menu"
  aria-busy={ariaBusy}
  aria-expanded={popupStore.openId === buttonId && Boolean(popupStore.children)}
  {disabled}
  data-risu-chat-action={dataAction}
  onclick={async (e: MouseEvent) => {
    e.stopPropagation()
    if (popupStore.openId === buttonId) {
      popupStore.children = null
      popupStore.openId = 0
      popupStore.trigger = null
      return
    }

    const trigger = e.currentTarget as HTMLButtonElement
    const keyboardClick = e.detail === 0
    const rect = trigger.getBoundingClientRect()
    await sleep(0)
    popupStore.mouseX = keyboardClick ? rect.left : e.clientX
    popupStore.mouseY = keyboardClick ? rect.bottom : e.clientY
    popupStore.children = children
    popupStore.openId = buttonId
    popupStore.trigger = buttonElement
  }}
  class="button-icon-menu flex min-h-11 min-w-11 items-center justify-center rounded-md text-textcolor2 transition-colors hover:bg-selected hover:text-textcolor focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 {className}">
  <MenuIcon size={20} />
</button>
