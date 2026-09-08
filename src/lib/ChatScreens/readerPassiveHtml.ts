/** Preserve passive markup while making executable controls visibly unavailable. */
export function hasExecutableMarkupAction(element: Element): boolean {
  return (
    element.hasAttribute('risu-trigger') ||
    element.hasAttribute('risu-btn') ||
    [...element.attributes].some((attribute) => /^on/i.test(attribute.name))
  )
}

export function disableReaderScriptControls(html: string, reason: string): string {
  if (!/risu-(?:trigger|btn)|\son[a-z]+\s*=/i.test(html)) return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const element of template.content.querySelectorAll('*')) {
    if (!hasExecutableMarkupAction(element)) continue
    element.setAttribute('data-reader-script-control', '')
    element.setAttribute('aria-disabled', 'true')
    element.setAttribute('title', reason)
    element.setAttribute('aria-description', reason)
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) element.setAttribute('disabled', '')
    else element.setAttribute('tabindex', '-1')
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
    }
  }
  return template.innerHTML
}

export function denyReaderScriptActivation(event: Event, allowed: boolean): boolean {
  const target = event.target
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  if (allowed || !element?.closest('[risu-trigger], [risu-btn], [data-reader-script-control]')) return false
  event.preventDefault()
  event.stopImmediatePropagation()
  return true
}
