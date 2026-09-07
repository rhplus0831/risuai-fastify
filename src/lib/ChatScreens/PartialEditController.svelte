<script lang="ts" module>
  import { EDITABLE_BLOCK_SELECTORS } from 'src/ts/parser/partialEdit'

  const SELECTOR = EDITABLE_BLOCK_SELECTORS.join(', ')

  interface SharedBlockHoverController {
    bodyRoot: HTMLElement
    isEditing: () => boolean
    getCurrentHoveredBlock: () => HTMLElement | null
    isEditableBlock: (el: HTMLElement) => boolean
    isMouseOnBlockButton: (mouseX: number, mouseY: number) => boolean
    isMouseInButtonZone: (mouseX: number, mouseY: number, block: HTMLElement) => boolean
    showBlockButton: (block: HTMLElement) => void
    hideBlockButton: () => void
  }

  interface SharedBlockHoverRoute {
    controller: SharedBlockHoverController
    block?: HTMLElement
  }

  const sharedBlockHoverControllers = new Set<SharedBlockHoverController>()
  let sharedBlockHoverRafId: number | null = null
  let sharedBlockHoverMouseX = 0
  let sharedBlockHoverMouseY = 0
  let sharedBlockHoverListenersInstalled = false

  function isControllerEligible(controller: SharedBlockHoverController): boolean {
    return !controller.isEditing() && controller.bodyRoot.isConnected
  }

  function cancelSharedBlockHoverFrame() {
    if (sharedBlockHoverRafId === null) return
    cancelAnimationFrame(sharedBlockHoverRafId)
    sharedBlockHoverRafId = null
  }

  function hideSharedBlockButtonsExcept(controllerToKeep: SharedBlockHoverController | null) {
    for (const controller of sharedBlockHoverControllers) {
      if (controller !== controllerToKeep && !controller.isEditing()) {
        controller.hideBlockButton()
      }
    }
  }

  function hasActiveTextSelection(): boolean {
    const selection = window.getSelection()
    return !!selection && !selection.isCollapsed
  }

  function findButtonRoute(mouseX: number, mouseY: number): SharedBlockHoverRoute | null {
    for (const controller of sharedBlockHoverControllers) {
      if (isControllerEligible(controller) && controller.isMouseOnBlockButton(mouseX, mouseY)) {
        return { controller }
      }
    }
    return null
  }

  function findCurrentButtonZoneRoute(mouseX: number, mouseY: number): SharedBlockHoverRoute | null {
    for (const controller of sharedBlockHoverControllers) {
      if (!isControllerEligible(controller)) continue

      const block = controller.getCurrentHoveredBlock()
      if (block && controller.isMouseInButtonZone(mouseX, mouseY, block)) {
        return { controller }
      }
    }
    return null
  }

  function findHoveredBlockRoute(mouseX: number, mouseY: number): SharedBlockHoverRoute | null {
    const elementAtPoint = document.elementFromPoint(mouseX, mouseY)
    if (!elementAtPoint) return null

    const block = elementAtPoint.closest(SELECTOR) as HTMLElement | null
    if (!block) return null

    for (const controller of sharedBlockHoverControllers) {
      if (
        isControllerEligible(controller) &&
        controller.bodyRoot.contains(block) &&
        controller.isEditableBlock(block)
      ) {
        return { controller, block }
      }
    }
    return null
  }

  function findFallbackButtonZoneRoute(mouseX: number, mouseY: number): SharedBlockHoverRoute | null {
    for (const controller of sharedBlockHoverControllers) {
      if (!isControllerEligible(controller)) continue

      const blocks = controller.bodyRoot.querySelectorAll(SELECTOR)
      for (const blockCandidate of blocks) {
        const block = blockCandidate as HTMLElement
        if (!controller.isMouseInButtonZone(mouseX, mouseY, block)) continue
        if (!controller.isEditableBlock(block)) continue

        const rect = block.getBoundingClientRect()
        const checkX = rect.left + rect.width / 2
        const checkY = rect.top + 5
        const elementAtBlock = document.elementFromPoint(checkX, checkY)
        if (elementAtBlock && (block.contains(elementAtBlock) || elementAtBlock === block)) {
          return { controller, block }
        }
      }
    }
    return null
  }

  function runSharedBlockHover(mouseX: number, mouseY: number) {
    if (hasActiveTextSelection()) {
      hideSharedBlockButtonsExcept(null)
      return
    }

    const route =
      findButtonRoute(mouseX, mouseY) ??
      findCurrentButtonZoneRoute(mouseX, mouseY) ??
      findHoveredBlockRoute(mouseX, mouseY) ??
      findFallbackButtonZoneRoute(mouseX, mouseY)

    if (!route) {
      hideSharedBlockButtonsExcept(null)
      return
    }

    hideSharedBlockButtonsExcept(route.controller)
    if (route.block) {
      route.controller.showBlockButton(route.block)
    }
  }

  function handleSharedBlockHoverMouseMove(e: MouseEvent) {
    if (sharedBlockHoverControllers.size === 0) return

    if (hasActiveTextSelection()) {
      cancelSharedBlockHoverFrame()
      hideSharedBlockButtonsExcept(null)
      return
    }

    sharedBlockHoverMouseX = e.clientX
    sharedBlockHoverMouseY = e.clientY

    if (sharedBlockHoverRafId !== null) return
    sharedBlockHoverRafId = requestAnimationFrame(() => {
      sharedBlockHoverRafId = null
      runSharedBlockHover(sharedBlockHoverMouseX, sharedBlockHoverMouseY)
    })
  }

  function handleSharedBlockHoverScroll() {
    cancelSharedBlockHoverFrame()
    hideSharedBlockButtonsExcept(null)
  }

  function installSharedBlockHoverListeners() {
    if (sharedBlockHoverListenersInstalled) return
    document.addEventListener('mousemove', handleSharedBlockHoverMouseMove)
    document.addEventListener('scroll', handleSharedBlockHoverScroll, true)
    sharedBlockHoverListenersInstalled = true
  }

  function removeSharedBlockHoverListeners() {
    if (!sharedBlockHoverListenersInstalled) return
    document.removeEventListener('mousemove', handleSharedBlockHoverMouseMove)
    document.removeEventListener('scroll', handleSharedBlockHoverScroll, true)
    sharedBlockHoverListenersInstalled = false
    cancelSharedBlockHoverFrame()
  }

  function registerSharedBlockHoverController(controller: SharedBlockHoverController): () => void {
    sharedBlockHoverControllers.add(controller)
    installSharedBlockHoverListeners()

    return () => {
      sharedBlockHoverControllers.delete(controller)
      controller.hideBlockButton()
      if (sharedBlockHoverControllers.size === 0) {
        removeSharedBlockHoverListeners()
      }
    }
  }
</script>

<script lang="ts">
  import { CheckIcon, XIcon } from '@lucide/svelte'
  import { createEventDispatcher, getContext, onDestroy, untrack } from 'svelte'
  import {
    canUseClientWriteAccess,
    captureClientSessionGeneration,
    isClientSessionGenerationCurrent,
  } from 'src/ts/clientSession'
  import { registerWriterDraftCapture } from 'src/ts/server/writerDraftRecovery'
  import { language } from 'src/lang'
  import { alertNormal } from 'src/ts/alert'
  import {
    createTranscriptInteractionScope,
    TRANSCRIPT_INTERACTION_CONTEXT,
    type TranscriptInteractionProvider,
  } from './transcriptInteraction'
  import { displaySettingForPaint } from 'src/ts/gui/displaySettings'
  import {
    findAllOriginalRangesFromHtml,
    findAllOriginalRangesFromText,
    replaceRange,
    type RangeResult,
    type RangeResultWithContext,
  } from 'src/ts/parser/partialEdit'
  import type { PartialEditMode, PartialEditSaveDetail } from './partialEditFreshness'
  import {
    resolvePartialEditLayer,
    resolveRangePartialEditLayer,
    type PartialEditDisplayMode,
    type PartialEditLayer,
  } from './partialEditLayer'
  import { attachPartialEditTouchTrigger } from './partialEditTouchTrigger'
  import { modalBackdropDismiss } from 'src/ts/gui/modalBackdropDismiss'
  import { modalFocusTrap } from 'src/ts/gui/modalFocusTrap'

  interface Props {
    messageData: string
    chatIndex: number
    chatId?: string
    messageId?: string
    bodyRoot: HTMLElement | null
    blockEditEnabled?: boolean
    dragEditEnabled?: boolean
    translationText?: string | null
    bilingualActive?: boolean
  }

  let {
    messageData = $bindable(''),
    chatIndex,
    chatId,
    messageId,
    bodyRoot,
    blockEditEnabled = false,
    dragEditEnabled = false,
    translationText = null,
    bilingualActive = false,
  }: Props = $props()

  const interactions = createTranscriptInteractionScope(
    getContext<TranscriptInteractionProvider | undefined>(TRANSCRIPT_INTERACTION_CONTEXT),
    () => messageId,
    () => alertNormal(language.transcriptInteractionLimit),
  )
  let interactionReservation: (() => void) | null = null

  let displayMode: PartialEditDisplayMode = $derived(
    typeof translationText !== 'string' ? 'original' : bilingualActive ? 'bilingual' : 'translation',
  )
  let zoomSize = $derived(displaySettingForPaint('zoomsize') ?? 100)
  let lineHeight = $derived(displaySettingForPaint('lineHeight') ?? 1.25)

  function layerSourceData(layer: PartialEditLayer): string | null {
    if (layer === 'translation') return typeof translationText === 'string' ? translationText : null
    return messageData
  }

  const dispatch = createEventDispatcher<{
    save: PartialEditSaveDetail
  }>()

  const MIN_DRAG_SELECTION_LENGTH = 5
  let isEditing = $state(false)
  let editText = $state('')
  let textareaRef: HTMLTextAreaElement | null = $state(null)
  let editFocusTimer: ReturnType<typeof setTimeout> | null = null
  let editScrollTimer: ReturnType<typeof setTimeout> | null = null

  let isConfirmingDelete = $state(false)
  let modalReturnFocus: HTMLElement | null = null
  let modalReturnBlock: HTMLElement | null = null

  // Unified matching state: tracks both edit and delete operations.
  type MatchingMode = PartialEditMode | null
  interface MatchingState {
    mode: MatchingMode
    layer: PartialEditLayer
    targetElement: HTMLElement | null
    originalHTML: string
    sourceData: string
    foundMatches: RangeResultWithContext[]
    selectedRange: RangeResult | null
  }

  type CapturedPartialEditOperation = Omit<PartialEditSaveDetail, 'newData'>

  function createEmptyMatchingState(): MatchingState {
    return {
      mode: null,
      layer: 'original',
      targetElement: null,
      originalHTML: '',
      sourceData: '',
      foundMatches: [],
      selectedRange: null,
    }
  }

  function cloneRange(range: RangeResult): RangeResult {
    return {
      start: range.start,
      end: range.end,
      method: range.method,
      confidence: range.confidence,
    }
  }

  function normalizeOptionalId(value: string | undefined): string | undefined {
    return value && value.length > 0 ? value : undefined
  }

  let operationGeneration = captureClientSessionGeneration()
  function canContinueEdit(): boolean {
    return canUseClientWriteAccess() && isClientSessionGenerationCurrent(operationGeneration)
  }

  let matchingState = $state<MatchingState>(createEmptyMatchingState())
  let activeOperation = $state<CapturedPartialEditOperation | null>(null)
  onDestroy(
    registerWriterDraftCapture(() => {
      if (
        !isEditing ||
        !activeOperation ||
        editText ===
          activeOperation.sourceData.slice(activeOperation.sourceRange.start, activeOperation.sourceRange.end)
      )
        return null
      return {
        key: `partial-edit:${chatId}:${messageId ?? chatIndex}:${activeOperation.layer}`,
        label: activeOperation.layer === 'translation' ? language.editTranslation : language.partialEdit.editModalTitle,
        route: globalThis.location?.pathname,
        fields: [{ label: language.partialEdit.editModalTitle, value: editText }],
        data: { operation: $state.snapshot(activeOperation), text: editText },
        baseline: { source: activeOperation.sourceData },
      }
    }),
  )

  let editModalTitle = $derived(
    activeOperation?.layer === 'translation' ? language.editTranslation : language.partialEdit.editModalTitle,
  )

  function captureOperation(mode: PartialEditMode, match: RangeResult): CapturedPartialEditOperation {
    const sourceRange = cloneRange(match)
    const layer = matchingState.layer
    const operation = {
      sourceData: matchingState.sourceData || layerSourceData(layer) || messageData,
      sourceRange,
      mode,
      layer,
      chatIndex,
      chatId: normalizeOptionalId(chatId),
      messageId: normalizeOptionalId(messageId),
    }

    activeOperation = operation
    matchingState.selectedRange = sourceRange

    return operation
  }

  function clearMatchingState() {
    matchingState = createEmptyMatchingState()
    activeOperation = null
  }

  let showMatchFailedModal = $state(false)
  $effect(() => {
    if (!isEditing && !isConfirmingDelete && !matchingState.mode && !showMatchFailedModal) {
      untrack(() => interactionReservation?.())
      interactionReservation = null
    }
  })

  let blockButtonWrapper: HTMLDivElement | null = null
  let currentHoveredBlock: HTMLElement | null = null

  let dragButtonWrapper: HTMLDivElement | null = null
  let currentDragSelectedText: string = ''
  let currentDragLayer: PartialEditLayer = 'original'

  let isInViewport = $state(false)
  let isBlockActive = $derived(blockEditEnabled && isInViewport)
  let isDragActive = $derived(dragEditEnabled && isInViewport)
  // Exclude action buttons when checking editable block text.
  function hasTextContent(el: HTMLElement): boolean {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('button').forEach((btn) => btn.remove())
    return !!clone.textContent?.trim()
  }

  // A block is only editable when it also resolves to a single text layer;
  // bilingual pair wrappers span both layers and are rejected.
  function isEditableBlock(el: HTMLElement): boolean {
    if (!hasTextContent(el)) return false
    const layer = resolvePartialEditLayer(el, displayMode)
    if (layer === null) return false
    return layerSourceData(layer) !== null
  }

  function actionTargetSummary(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized
  }

  function setFloatingActionNames(wrapper: HTMLDivElement, targetText: string): void {
    const summary = actionTargetSummary(targetText)
    const editLabel = summary
      ? `${language.partialEdit.editButtonTooltip}: ${summary}`
      : language.partialEdit.editButtonTooltip
    const deleteLabel = summary
      ? `${language.partialEdit.deleteButtonTooltip}: ${summary}`
      : language.partialEdit.deleteButtonTooltip
    const editButton = wrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')
    const deleteButton = wrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-delete')

    editButton?.setAttribute('aria-label', editLabel)
    editButton?.setAttribute('title', editLabel)
    deleteButton?.setAttribute('aria-label', deleteLabel)
    deleteButton?.setAttribute('title', deleteLabel)
  }

  function rememberModalReturnFocus(button: HTMLElement): void {
    modalReturnFocus = button
    modalReturnBlock = currentHoveredBlock?.isConnected ? currentHoveredBlock : null
  }

  function revealModalReturnFocus(): void {
    if (modalReturnBlock?.isConnected && blockButtonWrapper?.contains(modalReturnFocus)) {
      showBlockButton(modalReturnBlock)
      armTouchDismissal()
      return
    }

    const wrapper = modalReturnFocus?.closest<HTMLElement>('.partial-edit-btn-wrapper')
    if (wrapper?.isConnected) {
      wrapper.style.display = 'flex'
      armTouchDismissal()
    }
  }

  function hasOpenPartialEditModal(): boolean {
    return showMatchFailedModal || isConfirmingDelete || isEditing || matchingState.mode !== null
  }

  function restoreModalReturnFocus(): void {
    const returnFocus = modalReturnFocus
    const returnBlock = modalReturnBlock
    modalReturnFocus = null
    modalReturnBlock = null

    if (returnFocus?.isConnected) {
      returnFocus.focus()
    } else if (returnBlock?.isConnected) {
      returnBlock.focus()
    }
  }

  function partialEditModalFocusTrap(node: HTMLElement) {
    const trap = modalFocusTrap(node)

    return {
      destroy() {
        trap.destroy()
        queueMicrotask(() => {
          if (!hasOpenPartialEditModal()) restoreModalReturnFocus()
        })
      },
    }
  }

  function handleModalKeydown(event: KeyboardEvent, close: () => void): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  function createButton(
    className: string,
    onEdit: () => void,
    onDelete: () => void,
    onMouseLeave?: (e: MouseEvent) => void,
  ): HTMLDivElement {
    const wrapper = document.createElement('div')
    wrapper.className = className
    wrapper.innerHTML = `
            <button type="button" class="partial-edit-btn partial-edit-btn-edit">
                <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                    <path d="m15 5 4 4"/>
                </svg>
            </button>
            <button type="button" class="partial-edit-btn partial-edit-btn-delete">
                <svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18"/>
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                </svg>
            </button>
        `

    const editBtn = wrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')!
    editBtn.setAttribute('aria-label', language.partialEdit.editButtonTooltip)
    editBtn.setAttribute('title', language.partialEdit.editButtonTooltip)
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      rememberModalReturnFocus(editBtn)
      onEdit()
    })

    const deleteBtn = wrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-delete')!
    deleteBtn.setAttribute('aria-label', language.partialEdit.deleteButtonTooltip)
    deleteBtn.setAttribute('title', language.partialEdit.deleteButtonTooltip)
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      rememberModalReturnFocus(deleteBtn)
      onDelete()
    })

    if (onMouseLeave) {
      wrapper.addEventListener('mouseleave', onMouseLeave)
    }

    return wrapper
  }

  function showBlockButton(block: HTMLElement, options: { focusEdit?: boolean } = {}) {
    if (!canUseClientWriteAccess()) return
    if (currentHoveredBlock === block && blockButtonWrapper?.style.display === 'flex') {
      if (options.focusEdit) blockButtonWrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.focus()
      return
    }

    currentHoveredBlock = block

    if (!blockButtonWrapper) {
      blockButtonWrapper = createButton(
        'partial-edit-btn-wrapper',
        startBlockEdit,
        startBlockDelete,
        (e: MouseEvent) => {
          const relatedTarget = e.relatedTarget as HTMLElement | null
          if (!relatedTarget || !currentHoveredBlock?.contains(relatedTarget)) {
            hideBlockButton()
          }
        },
      )
      document.body.appendChild(blockButtonWrapper)
    }

    setFloatingActionNames(blockButtonWrapper, block.textContent ?? '')

    const rect = block.getBoundingClientRect()
    const buttonHeight = 32
    blockButtonWrapper.style.position = 'fixed'
    blockButtonWrapper.style.top = `${rect.top - buttonHeight - 4}px`
    blockButtonWrapper.style.left = `${rect.left}px`
    blockButtonWrapper.style.display = 'flex'
    blockButtonWrapper.style.gap = '4px'
    blockButtonWrapper.style.zIndex = '1000'
    if (options.focusEdit) blockButtonWrapper.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.focus()
  }

  function hideBlockButton() {
    if (blockButtonWrapper) {
      blockButtonWrapper.style.display = 'none'
    }
    currentHoveredBlock = null
  }

  function showDragButton(rect: DOMRect) {
    if (!canUseClientWriteAccess()) return
    if (!dragButtonWrapper) {
      dragButtonWrapper = createButton(
        'partial-edit-btn-wrapper partial-edit-drag-btn-wrapper',
        startDragEdit,
        startDragDelete,
      )
      document.body.appendChild(dragButtonWrapper)
    }

    setFloatingActionNames(dragButtonWrapper, currentDragSelectedText)

    // 72px: 2 buttons (32px*2) + gap(4px) + margin
    const buttonTotalWidth = 72
    const centerX = (rect.left + rect.right) / 2

    dragButtonWrapper.style.position = 'fixed'
    dragButtonWrapper.style.top = `${rect.bottom + 4}px`
    dragButtonWrapper.style.left = `${centerX - buttonTotalWidth / 2}px`
    dragButtonWrapper.style.display = 'flex'
    dragButtonWrapper.style.gap = '4px'
    dragButtonWrapper.style.zIndex = '1000'
  }

  function hideDragButton() {
    if (dragButtonWrapper) {
      dragButtonWrapper.style.display = 'none'
    }
    currentDragSelectedText = ''
    currentDragLayer = 'original'
  }

  function findAndProcessMatches(
    mode: PartialEditMode,
    layer: PartialEditLayer,
    elementOrText: HTMLElement | string,
    proceedCallback: (match: RangeResultWithContext) => void,
  ) {
    if (!canUseClientWriteAccess()) return
    operationGeneration = captureClientSessionGeneration()
    const sourceData = layerSourceData(layer)
    if (!elementOrText || !sourceData) return
    if (!interactionReservation) {
      interactionReservation = interactions.acquire()
      if (!interactionReservation) return
    }

    matchingState.mode = mode
    matchingState.layer = layer
    matchingState.sourceData = sourceData

    const options =
      mode === 'edit'
        ? { extendToEOL: false, snapStartToPrevEOL: false }
        : { extendToEOL: true, snapStartToPrevEOL: true }

    if (typeof elementOrText === 'string') {
      matchingState.targetElement = null
      matchingState.originalHTML = ''
      matchingState.foundMatches = findAllOriginalRangesFromText(sourceData, elementOrText, options)
    } else {
      matchingState.targetElement = elementOrText
      matchingState.originalHTML = elementOrText.innerHTML
      matchingState.foundMatches = findAllOriginalRangesFromHtml(sourceData, elementOrText, options)
    }

    if (matchingState.foundMatches.length === 0) {
      showMatchFailedModal = true
      clearMatchingState()
      hideBlockButton()
      hideDragButton()
      return
    }

    const highConfidenceMatches = matchingState.foundMatches.filter((m) => m.confidence >= 0.95)

    if (highConfidenceMatches.length === 1) {
      proceedCallback(highConfidenceMatches[0])
    } else if (matchingState.foundMatches.length === 1) {
      proceedCallback(matchingState.foundMatches[0])
    }

    hideBlockButton()
    hideDragButton()
  }

  function startBlockEdit() {
    if (!currentHoveredBlock) return
    const layer = resolvePartialEditLayer(currentHoveredBlock, displayMode)
    if (layer === null) return
    findAndProcessMatches('edit', layer, currentHoveredBlock, proceedWithEdit)
  }

  function startBlockDelete() {
    if (!currentHoveredBlock) return
    const layer = resolvePartialEditLayer(currentHoveredBlock, displayMode)
    if (layer === null) return
    findAndProcessMatches('delete', layer, currentHoveredBlock, proceedWithDelete)
  }

  function startDragEdit() {
    if (!currentDragSelectedText) return
    findAndProcessMatches('edit', currentDragLayer, currentDragSelectedText, proceedWithEdit)
  }

  function startDragDelete() {
    if (!currentDragSelectedText) return
    findAndProcessMatches('delete', currentDragLayer, currentDragSelectedText, proceedWithDelete)
  }

  function proceedWithEdit(match: RangeResultWithContext) {
    if (!canContinueEdit()) return
    clearEditSetupTimers()
    const operation = captureOperation('edit', match)
    matchingState.mode = null
    editText = operation.sourceData.slice(operation.sourceRange.start, operation.sourceRange.end)
    isEditing = true

    editFocusTimer = setTimeout(() => {
      editFocusTimer = null
      const editTextarea = textareaRef
      if (!isEditing || !editTextarea?.isConnected) return

      editTextarea.focus()
      adjustHeight()
      editScrollTimer = setTimeout(() => {
        editScrollTimer = null
        if (!isEditing || textareaRef !== editTextarea || !editTextarea.isConnected) return

        const buttonsEl = editTextarea.closest('.partial-edit-modal')?.querySelector('.partial-edit-buttons')
        if (buttonsEl) {
          ;(buttonsEl as HTMLElement).scrollIntoView({ behavior: 'instant', block: 'nearest' })
        }
      }, 200)
    }, 10)
  }

  function clearEditSetupTimers(): void {
    if (editFocusTimer) {
      clearTimeout(editFocusTimer)
      editFocusTimer = null
    }
    if (editScrollTimer) {
      clearTimeout(editScrollTimer)
      editScrollTimer = null
    }
  }

  function selectMatchAtIndex(index: number) {
    if (!canContinueEdit()) return
    const match = matchingState.foundMatches[index]
    if (!match) return

    if (matchingState.mode === 'edit') {
      proceedWithEdit(match)
    } else if (matchingState.mode === 'delete') {
      proceedWithDelete(match)
    }
  }

  // Restore block HTML if match selection is canceled during edit.
  function cancelMatchSelection() {
    if (matchingState.mode === 'edit' && matchingState.targetElement && matchingState.originalHTML) {
      matchingState.targetElement.innerHTML = matchingState.originalHTML
    }

    revealModalReturnFocus()
    clearMatchingState()
  }

  function closeMatchFailed(): void {
    revealModalReturnFocus()
    showMatchFailedModal = false
  }

  function handleSave() {
    if (!activeOperation || !canContinueEdit()) return

    const newData = replaceRange(activeOperation.sourceData, activeOperation.sourceRange, editText)
    dispatch('save', {
      ...activeOperation,
      sourceRange: cloneRange(activeOperation.sourceRange),
      newData,
    })

    closeEdit()
  }

  function handleCancel() {
    if (matchingState.targetElement && matchingState.originalHTML) {
      matchingState.targetElement.innerHTML = matchingState.originalHTML
    }
    closeEdit()
  }

  function closeEdit() {
    clearEditSetupTimers()
    revealModalReturnFocus()
    isEditing = false
    editText = ''
    clearMatchingState()
  }

  function proceedWithDelete(match: RangeResultWithContext) {
    if (!canContinueEdit()) return
    captureOperation('delete', match)
    matchingState.mode = null
    isConfirmingDelete = true
  }

  function handleConfirmDelete() {
    if (!activeOperation || !canContinueEdit()) return

    let newData = replaceRange(activeOperation.sourceData, activeOperation.sourceRange, '')
    newData = newData.replace(/\n{3,}/g, '\n\n').trim()

    dispatch('save', {
      ...activeOperation,
      sourceRange: cloneRange(activeOperation.sourceRange),
      newData,
    })
    closeDeleteConfirm()
  }

  function handleCancelDelete() {
    closeDeleteConfirm()
  }

  function closeDeleteConfirm() {
    revealModalReturnFocus()
    isConfirmingDelete = false
    clearMatchingState()
  }

  function handleEditTextareaKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSave()
    }
  }

  // Auto-adjust textarea height
  function adjustHeight() {
    if (textareaRef) {
      textareaRef.style.height = 'auto'
      textareaRef.style.height = Math.max(60, textareaRef.scrollHeight) + 'px'
    }
  }

  function isMouseOnBlockButton(mouseX: number, mouseY: number): boolean {
    if (!blockButtonWrapper || blockButtonWrapper.style.display === 'none') return false
    const rect = blockButtonWrapper.getBoundingClientRect()
    return mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom
  }

  function isMouseInButtonZone(mouseX: number, mouseY: number, block: HTMLElement): boolean {
    const rect = block.getBoundingClientRect()
    const buttonHeight = 32
    const gap = 4
    const extendedTop = rect.top - buttonHeight - gap - 8

    return mouseX >= rect.left && mouseX <= rect.right && mouseY >= extendedTop && mouseY < rect.top
  }

  $effect(() => {
    if (!bodyRoot || (!blockEditEnabled && !dragEditEnabled)) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        isInViewport = entry.isIntersecting
        if (!entry.isIntersecting) {
          hideBlockButton()
          hideDragButton()
        }
      },
      {
        threshold: [0, 0.1, 0.5, 1.0],
        rootMargin: '300px',
      },
    )

    observer.observe(bodyRoot)

    return () => {
      observer.disconnect()
      isInViewport = false
    }
  })

  // Track hover using document-level coordinates so the floating button stays reachable.
  $effect(() => {
    const root = bodyRoot
    if (!root || !isBlockActive) return

    const unregisterHoverController = registerSharedBlockHoverController({
      bodyRoot: root,
      isEditing: () => isEditing,
      getCurrentHoveredBlock: () => currentHoveredBlock,
      isEditableBlock,
      isMouseOnBlockButton,
      isMouseInButtonZone,
      showBlockButton,
      hideBlockButton,
    })

    const handleLeave = (e: MouseEvent) => {
      if (isEditing) return

      const relatedTarget = e.relatedTarget as HTMLElement | null

      if (relatedTarget && blockButtonWrapper?.contains(relatedTarget)) {
        return
      }

      hideBlockButton()
    }

    root.addEventListener('mouseleave', handleLeave)

    return () => {
      unregisterHoverController()
      root.removeEventListener('mouseleave', handleLeave)
    }
  })

  // Touch trigger: long-press reveals the same block buttons hover would.
  let touchDismissTimer: ReturnType<typeof setTimeout> | null = null

  function handleTouchDismissPointerDown(e: PointerEvent) {
    const target = e.target as Node | null
    if (target && (blockButtonWrapper?.contains(target) || currentHoveredBlock?.contains(target))) return
    removeTouchDismissal()
    if (!isEditing && !hasOpenPartialEditModal()) hideBlockButton()
  }

  function removeTouchDismissal() {
    if (touchDismissTimer !== null) {
      clearTimeout(touchDismissTimer)
      touchDismissTimer = null
    }
    document.removeEventListener('pointerdown', handleTouchDismissPointerDown, true)
  }

  // Attach the outside-tap listener on a macrotask: attaching same-tick would
  // let the microtask queue drain mid-dispatch of the triggering tap and
  // dismiss the buttons immediately.
  function armTouchDismissal() {
    removeTouchDismissal()
    touchDismissTimer = setTimeout(() => {
      touchDismissTimer = null
      document.addEventListener('pointerdown', handleTouchDismissPointerDown, true)
    }, 0)
  }

  $effect(() => {
    const root = bodyRoot
    if (!root || !isBlockActive) return

    const detachTouchTrigger = attachPartialEditTouchTrigger({
      bodyRoot: root,
      resolveBlock: (clientX, clientY) => {
        if (isEditing || hasOpenPartialEditModal()) return null
        const elementAtPoint = document.elementFromPoint(clientX, clientY)
        const block = elementAtPoint?.closest(SELECTOR) as HTMLElement | null
        if (!block || !root.contains(block) || !isEditableBlock(block)) return null
        return block
      },
      onLongPress: (block) => {
        showBlockButton(block)
        armTouchDismissal()
      },
    })

    return () => {
      detachTouchTrigger()
      removeTouchDismissal()
    }
  })

  $effect(() => {
    if (!bodyRoot || !isDragActive) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null

    const handleSelectionChange = () => {
      if (isEditing || isConfirmingDelete || matchingState.mode) return

      // Debounce: wait for selection to stabilize
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          hideDragButton()
          return
        }

        const range = sel.getRangeAt(0)
        const ancestor = range.commonAncestorContainer
        const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as HTMLElement) : ancestor.parentElement

        if (!ancestorEl || !bodyRoot.contains(ancestorEl)) {
          hideDragButton()
          return
        }

        const rect = range.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) {
          hideDragButton()
          return
        }

        const selectedText = sel.toString()
        if (selectedText.length < MIN_DRAG_SELECTION_LENGTH) {
          hideDragButton()
          return
        }

        const layer = resolveRangePartialEditLayer(range, displayMode)
        if (layer === null || layerSourceData(layer) === null) {
          hideDragButton()
          return
        }

        currentDragLayer = layer
        currentDragSelectedText = selectedText
        showDragButton(rect)
      }, 150)
    }

    const handleDragScroll = () => {
      if (isEditing) return
      hideDragButton()
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (isEditing || isConfirmingDelete || matchingState.mode) return
      if (dragButtonWrapper && dragButtonWrapper.contains(e.target as Node)) return
      hideDragButton()
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('scroll', handleDragScroll, true)
    document.addEventListener('mousedown', handleMouseDown)

    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('scroll', handleDragScroll, true)
      document.removeEventListener('mousedown', handleMouseDown)
      if (debounceTimer) clearTimeout(debounceTimer)
    }
  })

  onDestroy(() => {
    interactions.dispose()
    clearEditSetupTimers()
    removeTouchDismissal()
    if (blockButtonWrapper) {
      blockButtonWrapper.remove()
      blockButtonWrapper = null
    }
    if (dragButtonWrapper) {
      dragButtonWrapper.remove()
      dragButtonWrapper = null
    }
  })
</script>

{#snippet MatchSelectionModal(mode: PartialEditMode, matches: RangeResultWithContext[], title: string)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    use:modalBackdropDismiss={cancelMatchSelection}
    data-modal-root
    data-partial-edit-ui
    class="partial-edit-overlay">
    <div
      use:partialEditModalFocusTrap
      class="partial-match-selection-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="partial-{mode}-match-selection-title-{chatIndex}"
      tabindex="-1"
      onkeydown={(event) => handleModalKeydown(event, cancelMatchSelection)}>
      <div class="match-selection-header">
        <h2 id="partial-{mode}-match-selection-title-{chatIndex}" class="match-selection-title">{title}</h2>
        <span class="match-count">{matches.length} {language.partialEdit.matchesFound}</span>
      </div>
      <div class="match-list">
        {#each matches as match, i}
          <button
            type="button"
            class="match-item"
            data-modal-initial-focus={i === 0 ? '' : undefined}
            onclick={() => selectMatchAtIndex(i)}>
            <span class="match-meta">
              <span class="match-line">{language.partialEdit.lineNumber(match.lineNumber)}</span>
              <span
                class="match-confidence"
                class:high-confidence={match.confidence >= 0.95}
                class:medium-confidence={match.confidence >= 0.7 && match.confidence < 0.95}
                class:low-confidence={match.confidence < 0.7}>
                {(match.confidence * 100).toFixed(0)}%
              </span>
              <span class="match-method">{match.method}</span>
            </span>
            {#if match.contextBefore}
              <span class="match-context-before">{match.contextBefore}</span>
            {/if}
            <span class="match-text">
              {matchingState.sourceData.slice(match.start, match.end).slice(0, 150)}{matchingState.sourceData.slice(
                match.start,
                match.end,
              ).length > 150
                ? '...'
                : ''}
            </span>
            {#if match.contextAfter}
              <span class="match-context-after">{match.contextAfter}</span>
            {/if}
          </button>
        {/each}
      </div>
      <div class="partial-edit-buttons">
        <button type="button" class="partial-edit-cancel-btn" onclick={cancelMatchSelection}>
          <XIcon size={14} />
          <span>{language.cancel}</span>
        </button>
      </div>
    </div>
  </div>
{/snippet}

{#if showMatchFailedModal}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div use:modalBackdropDismiss={closeMatchFailed} data-modal-root data-partial-edit-ui class="partial-edit-overlay">
    <div
      use:partialEditModalFocusTrap
      class="partial-match-failed-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="partial-match-failed-title-{chatIndex}"
      tabindex="-1"
      onkeydown={(event) => handleModalKeydown(event, closeMatchFailed)}>
      <div class="partial-match-failed-header">
        <h2 id="partial-match-failed-title-{chatIndex}" class="partial-match-failed-title">
          {language.partialEdit.matchFailedTitle}
        </h2>
      </div>
      <p class="partial-match-failed-message">{language.partialEdit.matchFailedMessage}</p>
      <div class="partial-edit-buttons">
        <button type="button" data-modal-initial-focus class="partial-edit-save-btn" onclick={closeMatchFailed}>
          <CheckIcon size={14} />
          <span>{language.confirm}</span>
        </button>
      </div>
    </div>
  </div>
{/if}

{#if isConfirmingDelete}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div use:modalBackdropDismiss={handleCancelDelete} data-modal-root data-partial-edit-ui class="partial-edit-overlay">
    <div
      use:partialEditModalFocusTrap
      class="partial-delete-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="partial-delete-title-{chatIndex}"
      tabindex="-1"
      onkeydown={(event) => handleModalKeydown(event, handleCancelDelete)}>
      <div class="partial-delete-header">
        <h2 id="partial-delete-title-{chatIndex}" class="partial-delete-title">
          {language.partialEdit.deleteModalTitle}
        </h2>
        <div class="partial-match-meta">
          <span class="partial-match-hint">
            {language.partialEdit.matchFound(matchingState.selectedRange.method)}
          </span>
          <span class="partial-match-confidence" class:low-confidence={matchingState.selectedRange.confidence < 0.7}>
            {(matchingState.selectedRange.confidence * 100).toFixed(0)}%
          </span>
        </div>
      </div>
      <p class="partial-delete-message">{language.partialEdit.deleteConfirmMessage}</p>
      <div class="partial-delete-preview">
        {matchingState.selectedRange && activeOperation
          ? activeOperation.sourceData
              .slice(matchingState.selectedRange.start, matchingState.selectedRange.end)
              .slice(0, 200)
          : ''}{matchingState.selectedRange &&
        activeOperation &&
        activeOperation.sourceData.slice(matchingState.selectedRange.start, matchingState.selectedRange.end).length >
          200
          ? '...'
          : ''}
      </div>
      <div class="partial-edit-buttons">
        <button type="button" class="partial-delete-confirm-btn" onclick={handleConfirmDelete}>
          <CheckIcon size={14} />
          <span>{language.partialEdit.deleteYes}</span>
        </button>
        <button type="button" data-modal-initial-focus class="partial-edit-cancel-btn" onclick={handleCancelDelete}>
          <XIcon size={14} />
          <span>{language.partialEdit.deleteNo}</span>
        </button>
      </div>
    </div>
  </div>
{/if}

{#if matchingState.mode === 'edit'}
  {@render MatchSelectionModal('edit', matchingState.foundMatches, language.partialEdit.selectMatch)}
{:else if matchingState.mode === 'delete'}
  {@render MatchSelectionModal('delete', matchingState.foundMatches, language.partialEdit.selectDeleteMatch)}
{/if}

{#if isEditing}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div use:modalBackdropDismiss={handleCancel} data-modal-root data-partial-edit-ui class="partial-edit-overlay">
    <div
      use:partialEditModalFocusTrap
      class="partial-edit-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="partial-edit-title-{chatIndex}"
      tabindex="-1"
      onkeydown={(event) => handleModalKeydown(event, handleCancel)}>
      <div class="partial-edit-header">
        <h2 id="partial-edit-title-{chatIndex}" class="partial-edit-title">
          {editModalTitle}
        </h2>
        <div class="partial-match-meta">
          <span class="partial-match-hint">
            {language.partialEdit.matchFound(matchingState.selectedRange.method)}
          </span>
          <span class="partial-match-confidence" class:low-confidence={matchingState.selectedRange.confidence < 0.7}>
            {(matchingState.selectedRange.confidence * 100).toFixed(0)}%
          </span>
        </div>
      </div>
      <textarea
        bind:this={textareaRef}
        bind:value={editText}
        data-modal-initial-focus
        class="partial-edit-textarea"
        aria-label={editModalTitle}
        onkeydown={handleEditTextareaKeydown}
        oninput={adjustHeight}
        style:font-size="{0.875 * (zoomSize / 100)}rem"
        style:line-height="{lineHeight * (zoomSize / 100)}rem"></textarea>
      <div class="partial-edit-buttons">
        <button
          type="button"
          class="partial-edit-save-btn"
          onclick={handleSave}
          title={language.partialEdit.saveShortcut}>
          <CheckIcon size={14} />
          <span>{language.partialEdit.save}</span>
        </button>
        <button
          type="button"
          class="partial-edit-cancel-btn"
          onclick={handleCancel}
          title={language.partialEdit.cancelShortcut}>
          <XIcon size={14} />
          <span>{language.partialEdit.cancel}</span>
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(.partial-edit-btn-wrapper) {
    display: none;
  }

  :global(.partial-edit-btn) {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.95);
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 6px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    transition: all 0.15s ease;
    color: #666;
  }

  :global(.partial-edit-btn-edit:hover) {
    background: #e0f2fe;
    border-color: #3b82f6;
    color: #3b82f6;
  }

  :global(.partial-edit-btn-delete:hover) {
    background: #fee2e2;
    border-color: #ef4444;
    color: #ef4444;
  }

  .partial-match-failed-modal,
  .partial-delete-modal,
  .partial-edit-modal,
  .partial-match-selection-modal {
    overflow-wrap: anywhere;
  }

  .partial-match-failed-modal {
    background: var(--risu-theme-bgcolor, #fff);
    border-radius: 12px;
    padding: 20px;
    width: 50vw;
    max-width: min(500px, calc(100vw - 24px));
    min-width: min(320px, calc(100vw - 24px));
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .partial-match-failed-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .partial-match-failed-title {
    font-weight: 600;
    font-size: 16px;
    color: var(--risu-theme-textcolor, #000);
    margin: 0;
  }

  .partial-match-failed-message {
    font-size: 14px;
    color: var(--risu-theme-textcolor, #000);
    margin: 0;
    line-height: 1.5;
  }

  .partial-delete-modal {
    background: var(--risu-theme-bgcolor, #fff);
    border-radius: 12px;
    padding: 20px;
    width: 50vw;
    max-width: min(1600px, calc(100vw - 24px));
    min-width: min(400px, calc(100vw - 24px));
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .partial-delete-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .partial-delete-title {
    font-weight: 600;
    font-size: 16px;
    color: var(--risu-theme-textcolor, #000);
    margin: 0;
  }

  .partial-delete-message {
    font-size: 14px;
    color: var(--risu-theme-textcolor, #000);
    margin: 0;
  }

  .partial-delete-preview {
    padding: 12px;
    background: var(--risu-theme-darkbg, #f5f5f5);
    border-radius: 8px;
    font-size: 13px;
    color: var(--risu-theme-textcolor, #000);
    max-height: 100px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .partial-delete-confirm-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
    background: #ef4444;
    color: white;
  }

  .partial-delete-confirm-btn:hover {
    background: #dc2626;
  }

  .partial-edit-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 12px;
    overflow-y: auto;
    box-sizing: border-box;
  }

  .partial-edit-modal {
    background: var(--risu-theme-bgcolor, #fff);
    border-radius: 12px;
    padding: 20px;
    width: 50vw;
    max-width: min(1600px, calc(100vw - 24px));
    min-width: min(400px, calc(100vw - 24px));
    max-height: min(80vh, calc(100dvh - 24px));
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .partial-edit-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .partial-edit-title {
    font-weight: 600;
    font-size: 16px;
    color: var(--risu-theme-textcolor, #000);
    margin: 0;
  }

  .partial-match-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .partial-match-hint {
    font-size: 12px;
    color: var(--risu-theme-textcolor, #000);
  }

  .partial-match-confidence {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    background: #10b981;
    color: white;
  }

  .partial-match-confidence.low-confidence {
    background: #f59e0b;
  }

  .partial-edit-textarea {
    width: 100%;
    min-height: 120px;
    max-height: 50vh;
    padding: 12px;
    border: 1px solid var(--risu-theme-darkborderc, #ddd);
    border-radius: 8px;
    background: var(--risu-theme-darkbg, #f5f5f5);
    color: var(--risu-theme-textcolor, #000);
    font-family: inherit;
    resize: vertical;
    box-sizing: border-box;
  }

  .partial-edit-textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
  }

  .partial-edit-buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .partial-edit-save-btn,
  .partial-edit-cancel-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .partial-edit-save-btn {
    background: #3b82f6;
    color: white;
  }

  .partial-edit-save-btn:hover {
    background: #2563eb;
  }

  .partial-edit-cancel-btn {
    background: #6b7280;
    color: white;
  }

  .partial-edit-cancel-btn:hover {
    background: #4b5563;
  }

  .partial-match-selection-modal {
    background: var(--risu-theme-bgcolor, #fff);
    border-radius: 12px;
    padding: 20px;
    width: 50vw;
    max-width: min(1200px, calc(100vw - 24px));
    min-width: min(400px, calc(100vw - 24px));
    max-height: min(80vh, calc(100dvh - 24px));
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .match-selection-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--risu-theme-darkborderc, #ddd);
  }

  .match-selection-title {
    font-weight: 600;
    font-size: 16px;
    color: var(--risu-theme-textcolor, #000);
    margin: 0;
  }

  .match-count {
    font-size: 13px;
    font-weight: 500;
    padding: 4px 10px;
    border-radius: 12px;
    background: var(--risu-theme-darkbg, #f5f5f5);
    color: var(--risu-theme-textcolor, #000);
  }

  .match-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    max-height: calc(80vh - 160px);
    padding: 4px;
  }

  .match-item {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    border: 1px solid var(--risu-theme-darkborderc, #ddd);
    border-radius: 8px;
    background: var(--risu-theme-darkbg, #f9f9f9);
    cursor: pointer;
    transition: all 0.15s ease;
    width: 100%;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .match-item:hover {
    background: var(--risu-theme-bgcolor, #fff);
    border-color: #3b82f6;
    box-shadow: 0 2px 8px rgba(59, 130, 246, 0.2);
    transform: translateY(-1px);
  }

  .match-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .match-line {
    font-size: 12px;
    font-weight: 500;
    color: var(--risu-theme-textcolor, #000);
    background: var(--risu-theme-bgcolor, #fff);
    padding: 2px 8px;
    border-radius: 4px;
  }

  .match-confidence {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 8px;
    border-radius: 4px;
    color: white;
  }

  .match-confidence.high-confidence {
    background: #10b981;
  }

  .match-confidence.medium-confidence {
    background: #3b82f6;
  }

  .match-confidence.low-confidence {
    background: #f59e0b;
  }

  .match-method {
    font-size: 11px;
    font-weight: 500;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--risu-theme-bgcolor, #fff);
    color: var(--risu-theme-textcolor, #000);
    font-family: monospace;
  }

  .match-context-before,
  .match-context-after {
    font-size: 12px;
    color: var(--risu-theme-textcolor, #000);
    padding: 8px 12px;
    background: var(--risu-theme-bgcolor, #fff);
    border-radius: 6px;
    border-left: 3px solid var(--risu-theme-darkborderc, #ddd);
    line-height: 1.5;
    font-style: italic;
    white-space: pre-line;
  }

  .match-text {
    font-size: 13px;
    color: var(--risu-theme-textcolor, #000);
    padding: 10px 12px;
    background: var(--risu-theme-bgcolor, #fff);
    border-radius: 6px;
    border-left: 3px solid #3b82f6;
    line-height: 1.5;
    font-weight: 500;
    white-space: pre-line;
  }
</style>
