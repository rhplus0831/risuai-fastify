import { findLazyModalFocusOrigin } from './lazyModalFocusOrigin'

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface BackgroundState {
  ariaHidden: string | null
  inert: boolean
}

interface ModalTrapController {
  node: HTMLElement
  activate(): void
  deactivate(): void
  focusInitial(): void
}

const modalTrapStack: ModalTrapController[] = []
let bodyOverflowBeforeFirstModal: string | null = null

function isFocusable(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false
  if (element.closest('[hidden], [inert]')) return false
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function getFocusableElements(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(focusableSelector)).filter(isFocusable)
}

function focusInitialElement(node: HTMLElement): void {
  if (node.contains(document.activeElement)) return
  const explicitTarget = node.querySelector<HTMLElement>('[data-modal-initial-focus]')
  const target = explicitTarget && isFocusable(explicitTarget) ? explicitTarget : getFocusableElements(node)[0]
  ;(target ?? node).focus()
}

/**
 * Svelte action for a blocking modal.
 *
 * It makes sibling app surfaces inert, keeps keyboard/programmatic focus inside
 * the modal, and restores focus and background state when the modal closes.
 */
export function modalFocusTrap(node: HTMLElement) {
  const lazyFocusOrigin = findLazyModalFocusOrigin(node)
  const previousFocus = lazyFocusOrigin.found
    ? lazyFocusOrigin.origin
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const modalRoot = node.closest<HTMLElement>('[data-modal-root]') ?? node
  const backgroundStates = new Map<HTMLElement, BackgroundState>()
  const focusExtensions = new Set<HTMLElement>()
  let active = false
  let destroyed = false
  let controller: ModalTrapController

  function makeBackgroundInert(element: HTMLElement): void {
    if (element === modalRoot || focusExtensions.has(element) || backgroundStates.has(element)) return
    backgroundStates.set(element, {
      ariaHidden: element.getAttribute('aria-hidden'),
      inert: element.inert,
    })
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
  }

  function registerFocusExtensions(records: MutationRecord[]): void {
    if (!node.contains(document.activeElement)) return
    for (const record of records) {
      for (const addedNode of record.addedNodes) {
        if (!(addedNode instanceof HTMLElement)) continue
        if (addedNode.hasAttribute('data-modal-focus-extension')) focusExtensions.add(addedNode)
        for (const extension of addedNode.querySelectorAll<HTMLElement>('[data-modal-focus-extension]')) {
          focusExtensions.add(extension)
        }
      }
    }
  }

  function trapContains(target: Node | null): boolean {
    if (!target) return false
    return node.contains(target) || Array.from(focusExtensions).some((extension) => extension.contains(target))
  }

  function getTrapFocusableElements(): HTMLElement[] {
    return [node, ...focusExtensions].filter((root) => root.isConnected).flatMap((root) => getFocusableElements(root))
  }

  function inertBackgroundBranches(observeParents: boolean): void {
    let activeBranch: HTMLElement = modalRoot
    while (activeBranch.parentElement) {
      const parent = activeBranch.parentElement
      for (const child of parent.children) {
        if (child instanceof HTMLElement && child !== activeBranch) makeBackgroundInert(child)
      }
      if (observeParents) observer.observe(parent, { childList: true })
      if (parent === document.body) break
      activeBranch = parent
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return

    const focusable = getTrapFocusableElements()
    if (focusable.length === 0) {
      event.preventDefault()
      node.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const activeElement = document.activeElement
    if (event.shiftKey && (activeElement === first || !node.contains(activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (activeElement === last || !node.contains(activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleFocusin(event: FocusEvent): void {
    if (!active || modalTrapStack.at(-1) !== controller || trapContains(event.target as Node)) return
    focusInitialElement(node)
  }

  const observer = new MutationObserver((records) => {
    if (active && modalTrapStack.at(-1) === controller) {
      registerFocusExtensions(records)
      inertBackgroundBranches(true)
    }
  })

  function activate(): void {
    if (destroyed || active) return
    active = true
    inertBackgroundBranches(true)
    document.addEventListener('keydown', handleKeydown, true)
    document.addEventListener('focusin', handleFocusin, true)
    queueMicrotask(() => {
      if (active && modalTrapStack.at(-1) === controller) focusInitialElement(node)
    })
  }

  function deactivate(): void {
    if (!active) return
    active = false
    observer.disconnect()
    document.removeEventListener('keydown', handleKeydown, true)
    document.removeEventListener('focusin', handleFocusin, true)

    for (const [element, state] of backgroundStates) {
      element.inert = state.inert
      if (state.ariaHidden === null) {
        element.removeAttribute('aria-hidden')
      } else {
        element.setAttribute('aria-hidden', state.ariaHidden)
      }
    }
    backgroundStates.clear()
  }

  controller = {
    node,
    activate,
    deactivate,
    focusInitial: () => focusInitialElement(node),
  }

  const previousTrap = modalTrapStack.at(-1)
  if (modalTrapStack.length === 0) {
    bodyOverflowBeforeFirstModal = document.body.style.overflow
  }
  previousTrap?.deactivate()
  modalTrapStack.push(controller)
  document.body.style.overflow = 'hidden'
  controller.activate()

  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      const index = modalTrapStack.indexOf(controller)
      const wasTop = index === modalTrapStack.length - 1
      controller.deactivate()
      focusExtensions.clear()
      if (index >= 0) modalTrapStack.splice(index, 1)

      const nextTrap = modalTrapStack.at(-1)
      if (wasTop) nextTrap?.activate()
      if (modalTrapStack.length === 0) {
        document.body.style.overflow = bodyOverflowBeforeFirstModal ?? ''
        bodyOverflowBeforeFirstModal = null
      }

      queueMicrotask(() => {
        if (!wasTop) return
        if (previousFocus?.isConnected && (!nextTrap || nextTrap.node.contains(previousFocus))) {
          previousFocus.focus()
        } else {
          nextTrap?.focusInitial()
        }
      })
    },
  }
}
