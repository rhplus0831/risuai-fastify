<script lang="ts">
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'

  import { Maximize2Icon } from '@lucide/svelte'
  import { textAreaSize, textAreaTextSize } from 'src/ts/gui/guisize'
  import { highlighter, getNewHighlightId, removeHighlight, AllCBS } from 'src/ts/gui/highlight'
  import { sleep } from 'src/ts/util'
  import { onDestroy, onMount } from 'svelte'
  import {
    closePopupEditorSession,
    disableHighlight,
    isPopupEditorSessionCurrent,
    openPopupEditorSession,
    popUpEditorStore,
  } from 'src/ts/stores.svelte'
  import { isMobile } from 'src/ts/platform'
  import { hotkeyMatches } from 'src/ts/hotkey'
  import { language } from 'src/lang'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'

  type PopupEditorAvailability = boolean | 'auto'

  interface Props {
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'default'
    autocomplete?: 'on' | 'off'
    autocompleteOptions?: readonly string[]
    placeholder?: string
    value: string
    id?: string
    padding?: boolean
    margin?: 'none' | 'top' | 'bottom' | 'both'
    onInput?: any
    fullwidth?: boolean
    height?: '20' | '24' | '28' | '32' | '36' | 'full' | 'default'
    className?: string
    optimaizedInput?: boolean
    highlight?: boolean
    onchange?: () => void
    popupLanguage?: string
    popupEditor?: PopupEditorAvailability
    popupEditorContext?: unknown
    ariaLabel?: string
    disabled?: boolean
  }

  let {
    size = 'default',
    autocomplete = 'off',
    autocompleteOptions = [],
    placeholder = '',
    value = $bindable(),
    id = undefined,
    padding = true,
    margin = 'none',
    onInput = () => {},
    fullwidth = false,
    height = 'default',
    className = '',
    optimaizedInput = true,
    highlight = false,
    onchange = () => {},
    popupLanguage = 'markdown',
    popupEditor = 'auto',
    popupEditorContext = undefined,
    ariaLabel,
    disabled = false,
  }: Props = $props()
  let selectingAutoComplete = $state(0)
  // highlight is captured once when the input is created.
  // svelte-ignore state_referenced_locally
  let highlightId = highlight ? getNewHighlightId() : 0
  let highlightDom: HTMLDivElement = $state()
  let optiValue = $state(value)
  let autoCompleteDom: HTMLDivElement = $state()
  let autocompleteContents: string[] = $state([])
  let inputDom: HTMLDivElement = $state()
  let textareaDom: HTMLTextAreaElement = $state()
  let mounted = false
  let highlightTimer: ReturnType<typeof setTimeout> | null = null
  let popupEditorRun = 0
  let popupEditorContextRevision = 0
  let activePopupEditorSessionId: number | null = null
  let popupRecoveryBaseline = ''
  let popupRecoveryContext: unknown
  let sidebarSettingsReady = $derived(settingsResourceState.groupStatuses.sidebar === 'ready')
  let popupEditorHotkey = $derived(
    sidebarSettingsReady
      ? settingsResourceState.value.hotkeys?.find((hotkey) => hotkey.action === 'popupEditor')
      : undefined,
  )
  let longPressToPopupEditor = $derived(
    sidebarSettingsReady && Boolean(settingsResourceState.value.longPressToPopupEditor),
  )

  const isInteractionDisabled = () => disabled || Boolean((inputDom ?? textareaDom)?.closest('fieldset[disabled]'))

  const isPopupEditorEnabled = () =>
    popupEditor === true ||
    (popupEditor === 'auto' && (['32', '36', 'full'].includes(height) || (height === 'default' && $textAreaSize >= -2)))

  const openPopupEditor = async () => {
    if (isInteractionDisabled() || !isPopupEditorEnabled()) {
      return
    }

    const run = ++popupEditorRun
    const initialValue = value
    const initialContext = popupEditorContext
    const initialContextRevision = popupEditorContextRevision
    hideAutoComplete()
    const sessionId = openPopupEditorSession(value, popupLanguage)
    activePopupEditorSessionId = sessionId
    popupRecoveryBaseline = initialValue
    popupRecoveryContext = initialContext

    try {
      while (
        run === popupEditorRun &&
        popupEditorContextRevision === initialContextRevision &&
        popupEditorContext === initialContext &&
        value === initialValue &&
        isPopupEditorSessionCurrent(sessionId) &&
        popUpEditorStore.open
      ) {
        await sleep(100)
      }

      if (
        run !== popupEditorRun ||
        popupEditorContextRevision !== initialContextRevision ||
        popupEditorContext !== initialContext ||
        value !== initialValue
      ) {
        closePopupEditorSession(sessionId)
        return
      }
      if (!isPopupEditorSessionCurrent(sessionId)) return

      value = popUpEditorStore.value
      onInput(value, initialContext)
      onchange()
      scheduleHighlight(value)
    } finally {
      if (activePopupEditorSessionId === sessionId) activePopupEditorSessionId = null
    }
  }

  const getSelectionInInput = () => {
    if (!inputDom) {
      return null
    }

    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) {
      return null
    }

    const range = sel.getRangeAt(0)
    const commonAncestor = range.commonAncestorContainer
    if (commonAncestor !== inputDom && !inputDom.contains(commonAncestor)) {
      return null
    }

    return { sel, range }
  }

  const getRangeOffset = (range: Range, container: Node, offset: number) => {
    if (!inputDom) {
      return 0
    }

    const measuredRange = document.createRange()
    measuredRange.selectNodeContents(inputDom)
    measuredRange.setEnd(container, offset)
    return measuredRange.toString().length
  }

  const ensureInputTextNode = () => {
    if (!inputDom) {
      return null
    }

    const currentText = inputDom.textContent ?? ''
    if (!inputDom.firstChild || inputDom.firstChild.nodeType !== Node.TEXT_NODE) {
      inputDom.textContent = currentText
    }

    if (!inputDom.firstChild) {
      inputDom.appendChild(document.createTextNode(''))
    }

    return inputDom.firstChild as Text
  }

  const setCaretOffset = (offset: number) => {
    const textNode = ensureInputTextNode()
    if (!textNode) {
      return
    }

    const nextOffset = Math.max(0, Math.min(offset, textNode.length))
    const sel = window.getSelection()
    if (!sel) {
      return
    }

    const range = document.createRange()
    range.setStart(textNode, nextOffset)
    range.setEnd(textNode, nextOffset)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const dispatchInputChange = () => {
    if (!inputDom) {
      return
    }

    inputDom.dispatchEvent(new Event('input', { bubbles: true }))
    inputDom.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const replaceSelectionText = (insertContent: string, type: 'autoComplete' | 'paste' = 'paste') => {
    if (!inputDom) {
      return false
    }

    const selection = getSelectionInInput()
    const text = inputDom.textContent ?? ''
    const start = selection
      ? getRangeOffset(selection.range, selection.range.startContainer, selection.range.startOffset)
      : text.length
    const end = selection
      ? getRangeOffset(selection.range, selection.range.endContainer, selection.range.endOffset)
      : text.length

    let contentStart = text.substring(0, Math.min(start, end))
    const contentEnd = text.substring(Math.max(start, end))
    if (type === 'autoComplete') {
      contentStart = contentStart.substring(0, contentStart.lastIndexOf('{{'))
      if (insertContent.endsWith(':')) {
        insertContent = `{{${insertContent}:`
      } else if (insertContent.startsWith('#')) {
        insertContent = `{{${insertContent} `
      } else {
        insertContent = `{{${insertContent}}}`
      }
    }

    inputDom.textContent = contentStart + insertContent + contentEnd
    setCaretOffset(contentStart.length + insertContent.length)
    dispatchInputChange()
    return true
  }

  const autoComplete = () => {
    if (isInteractionDisabled() || isMobile) {
      hideAutoComplete()
      return
    }
    selectingAutoComplete = 0
    const selection = getSelectionInInput()
    if (!selection || !highlightDom || !autoCompleteDom || !inputDom) {
      return
    }

    const { range } = selection
    const caretOffset = getRangeOffset(range, range.startContainer, range.startOffset)
    const qValue = inputDom.textContent ?? ''
    const splited = qValue.substring(0, caretOffset).split('{{')
    if (splited.length === 1) {
      hideAutoComplete()
      return
    }
    const qText = splited.pop() ?? ''
    let filtered = [...new Set([...autocompleteOptions, ...AllCBS])].filter((cb) => cb.startsWith(qText))
    if (filtered.length === 0) {
      hideAutoComplete()
      return
    }
    filtered = filtered.slice(0, 10)
    autocompleteContents = filtered

    const hlRect = highlightDom.getBoundingClientRect()
    const rect = range.getBoundingClientRect()
    if (rect.top === 0 && rect.left === 0) {
      hideAutoComplete()
      return
    }
    const top = rect.top - hlRect.top + 15
    const left = rect.left - hlRect.left
    autoCompleteDom.style.top = top + 'px'
    autoCompleteDom.style.left = left + 'px'
    autoCompleteDom.style.display = 'flex'
  }

  const insertContent = (insertContent: string, type: 'autoComplete' | 'paste' = 'autoComplete') => {
    if (isInteractionDisabled()) {
      hideAutoComplete()
      return
    }
    if (replaceSelectionText(insertContent, type)) {
      hideAutoComplete()
    }
  }

  const hideAutoComplete = () => {
    if (autoCompleteDom) {
      autoCompleteDom.style.display = 'none'
    }
    selectingAutoComplete = 0
    autocompleteContents = []
  }

  const unregisterPopupDraft = registerWriterDraftCapture(() => {
    if (
      activePopupEditorSessionId === null ||
      !isPopupEditorSessionCurrent(activePopupEditorSessionId) ||
      value !== popupRecoveryBaseline ||
      popupEditorContext !== popupRecoveryContext ||
      popUpEditorStore.value === popupRecoveryBaseline
    )
      return null
    const label = ariaLabel || placeholder || language.hotkeyDesc.popupEditor
    return {
      key: `popup-editor:${activePopupEditorSessionId}`,
      label,
      fields: [{ label, value: popUpEditorStore.value }],
      data: {
        value: popUpEditorStore.value,
        context: typeof popupEditorContext === 'string' ? popupEditorContext : undefined,
        language: popupLanguage,
      },
      baseline: { value: popupRecoveryBaseline },
    }
  })

  onMount(() => {
    mounted = true
    scheduleHighlight()
  })

  onDestroy(() => {
    mounted = false
    unregisterPopupDraft()
    popupEditorRun++
    if (activePopupEditorSessionId !== null) {
      closePopupEditorSession(activePopupEditorSessionId)
      activePopupEditorSessionId = null
    }
    if (highlightTimer) {
      clearTimeout(highlightTimer)
      highlightTimer = null
    }
    removeHighlight(highlightId)
  })

  const scheduleHighlight = (_nextValue = value) => {
    void _nextValue
    if (!highlight || highlightId === 0 || $disableHighlight) return
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      highlightTimer = null
      if (highlightDom) {
        highlighter(highlightDom, highlightId)
      }
    }, 50)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (autocompleteContents.length >= 1) {
      switch (e.key) {
        case 'ArrowDown':
          selectingAutoComplete = Math.min(selectingAutoComplete + 1, autocompleteContents.length - 1)
          e.preventDefault()
          return
        case 'ArrowUp':
          selectingAutoComplete = Math.max(selectingAutoComplete - 1, 0)
          e.preventDefault()
          return
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          insertContent(autocompleteContents[selectingAutoComplete])
          return
        case 'Escape':
          e.preventDefault()
          e.stopPropagation()
          hideAutoComplete()
          return
      }
    }
    if (e.key === 'Enter') {
      e.stopPropagation()
      e.preventDefault()
      insertTextAtSelection('\n')
    }
  }

  const blockDisabledInteraction = (event: Event) => {
    if (!isInteractionDisabled()) return false

    event.preventDefault()
    hideAutoComplete()
    return true
  }

  function insertTextAtSelection(txt: string) {
    txt = txt.replace(/\r/g, '')

    if (!replaceSelectionText(txt)) {
      dispatchInputChange()
    }
  }

  export async function insertAtCaret(text: string): Promise<boolean> {
    if (!mounted || isInteractionDisabled()) return false
    if (inputDom) {
      inputDom.focus()
      return replaceSelectionText(text)
    }
    if (!textareaDom) return false
    const start = textareaDom.selectionStart ?? textareaDom.value.length
    const end = textareaDom.selectionEnd ?? start
    const nextValue = `${textareaDom.value.slice(0, start)}${text}${textareaDom.value.slice(end)}`
    textareaDom.value = nextValue
    textareaDom.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
    if (!mounted || !textareaDom.isConnected) return false
    textareaDom.focus()
    textareaDom.setSelectionRange(start + text.length, start + text.length)
    return true
  }

  export function focusEditor(): void {
    if (!mounted || isInteractionDisabled()) return
    ;(inputDom ?? textareaDom)?.focus()
  }

  $effect.pre(() => {
    void popupEditorContext
    popupEditorContextRevision++
  })
  $effect.pre(() => {
    optiValue = value
  })
  $effect.pre(() => {
    scheduleHighlight(value)
  })
</script>

<div
  class={'border border-darkborderc relative n-scroll focus-within:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus-within:ring-borderc focus-within:ring-2 focus-within:outline-hidden transition-colors duration-200 z-20 focus-within:z-40' +
    (className ? ' ' + className : '')}
  class:text-sm={size === 'sm' || (size === 'default' && $textAreaTextSize === 1)}
  class:text-md={size === 'md' || (size === 'default' && $textAreaTextSize === 2)}
  class:text-lg={size === 'lg' || (size === 'default' && $textAreaTextSize === 3)}
  class:text-xl={size === 'xl'}
  class:text-xs={size === 'xs' || (size === 'default' && $textAreaTextSize === 0)}
  class:w-full={fullwidth}
  class:h-20={height === '20' || (height === 'default' && $textAreaSize === -5)}
  class:h-24={height === '24' || (height === 'default' && $textAreaSize === -4)}
  class:h-28={height === '28' || (height === 'default' && $textAreaSize === -3)}
  class:h-32={height === '32' || (height === 'default' && $textAreaSize === -2)}
  class:h-36={height === '36' || (height === 'default' && $textAreaSize === -1)}
  class:h-40={height === 'default' && $textAreaSize === 0}
  class:h-44={height === 'default' && $textAreaSize === 1}
  class:h-48={height === 'default' && $textAreaSize === 2}
  class:h-52={height === 'default' && $textAreaSize === 3}
  class:h-56={height === 'default' && $textAreaSize === 4}
  class:h-60={height === 'default' && $textAreaSize === 5}
  class:h-full={height === 'full'}
  class:min-h-20={height === '20' || (height === 'default' && $textAreaSize === -5)}
  class:min-h-24={height === '24' || (height === 'default' && $textAreaSize === -4)}
  class:min-h-28={height === '28' || (height === 'default' && $textAreaSize === -3)}
  class:min-h-32={height === '32' || (height === 'default' && $textAreaSize === -2)}
  class:min-h-36={height === '36' || (height === 'default' && $textAreaSize === -1)}
  class:min-h-40={height === 'default' && $textAreaSize === 0}
  class:min-h-48={height === 'default' && $textAreaSize === 1}
  class:min-h-56={height === 'default' && $textAreaSize === 2}
  class:min-h-64={height === 'default' && $textAreaSize === 3}
  class:min-h-72={height === 'default' && $textAreaSize === 4}
  class:min-h-80={height === 'default' && $textAreaSize === 5}
  class:cursor-not-allowed={disabled}
  class:opacity-60={disabled}
  class:mb-4={margin === 'bottom'}
  class:mb-2={margin === 'both'}
  class:mt-4={margin === 'top'}
  class:mt-2={margin === 'both'}
  bind:this={highlightDom}
  onfocusout={(event) => {
    if (event.relatedTarget instanceof Node && autoCompleteDom?.contains(event.relatedTarget)) return
    hideAutoComplete()
  }}>
  {#if !highlight || $disableHighlight}
    <textarea
      class="w-full h-full bg-transparent focus-within:outline-hidden resize-none absolute top-0 left-0 z-50 overflow-y-auto"
      class:px-4={padding}
      class:py-2={padding}
      class:pr-10={isPopupEditorEnabled()}
      {autocomplete}
      {placeholder}
      {id}
      {disabled}
      aria-label={ariaLabel}
      bind:this={textareaDom}
      bind:value
      oninput={(e) => {
        if (optimaizedInput) {
          value = e.currentTarget.value
          onInput(value)
        } else {
          value = e.currentTarget.value
          onInput(value)
        }
      }}
      onchange={(e) => {
        if (optimaizedInput) {
          value = e.currentTarget.value
          onInput(value)
        }
        onchange()
      }}
      onkeydown={async (e) => {
        if (
          isPopupEditorEnabled() &&
          popupEditorHotkey &&
          (e.ctrlKey || e.shiftKey || e.altKey) &&
          hotkeyMatches(popupEditorHotkey, e)
        ) {
          e.preventDefault()
          await openPopupEditor()
        }
      }}
      oncontextmenu={(e) => {
        if (isPopupEditorEnabled() && longPressToPopupEditor) {
          e.preventDefault()
          void openPopupEditor()
        }
      }}></textarea>
  {:else}
    <div
      class="w-full h-full bg-transparent focus-within:outline-hidden resize-none absolute top-0 left-0 z-50 overflow-y-auto px-4 py-2 wrap-break-word whitespace-pre-wrap"
      class:pr-10={isPopupEditorEnabled()}
      class:pointer-events-none={disabled}
      contenteditable="true"
      bind:textContent={value}
      onkeydown={(e) => {
        if (blockDisabledInteraction(e)) return
        handleKeyDown(e)
      }}
      onbeforeinput={(e) => {
        blockDisabledInteraction(e)
      }}
      onpaste={(e) => {
        blockDisabledInteraction(e)
      }}
      ondrop={(e) => {
        blockDisabledInteraction(e)
      }}
      oncompositionstart={(e) => {
        blockDisabledInteraction(e)
      }}
      role="textbox"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      tabindex={disabled ? -1 : 0}
      oninput={(e) => {
        if (isInteractionDisabled()) {
          value = optiValue
          e.currentTarget.textContent = optiValue
          hideAutoComplete()
          return
        }
        value = e.currentTarget.textContent ?? ''
        onInput(value)
        autoComplete()
      }}
      onchange={(e) => {
        if (isInteractionDisabled()) return
        onchange()
      }}
      bind:this={inputDom}
      translate="no">
      {value ?? ''}
    </div>
  {/if}
  {#if isPopupEditorEnabled()}
    <button
      type="button"
      {disabled}
      class="absolute right-1 top-1 z-60 flex h-7 w-7 items-center justify-center rounded-md text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-borderc"
      aria-label={language.hotkeyDesc.popupEditor}
      title={language.hotkeyDesc.popupEditor}
      onclick={() => {
        void openPopupEditor()
      }}>
      <Maximize2Icon size={16} />
    </button>
  {/if}
  <div class="hidden absolute z-100 bg-bgcolor border border-darkborderc p-2 flex-col" bind:this={autoCompleteDom}>
    {#each autocompleteContents as content, i}
      <button
        class="w-full text-left py-1 px-2 bg-bgcolor"
        class:text-blue-500={selectingAutoComplete === i}
        onclick={() => {
          insertContent(content)
        }}>{content}</button>
    {/each}
  </div>
</div>
