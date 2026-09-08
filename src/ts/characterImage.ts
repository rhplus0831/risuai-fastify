import { getFileSrc } from './fileSource'
import { isClientReadOnly } from './clientSession'
import { getReaderNavigationSettings } from './server/readerTranscriptProjection.svelte'
import { settingsResourceState } from './server/resourceState.svelte'

function shouldHideAllImages(): boolean {
  if (isClientReadOnly()) return getReaderNavigationSettings().hideAllImages === true
  const status = settingsResourceState.groupStatuses.display ?? 'idle'
  if (settingsResourceState.status === 'error' || status === 'error') return true
  return settingsResourceState.value.hideAllImages === true
}

export async function getCharImage(loc: string, type: 'plain' | 'css' | 'contain' | 'lgcss') {
  // Return placeholder when hideAllImages is enabled
  if (shouldHideAllImages()) {
    if (type === 'plain') {
      return '/none.webp'
    }
    return '' // For CSS types, return empty to show default ? icon
  }

  if (!loc || loc === '') {
    if (type === 'css') {
      return ''
    }
    return null
  }
  const filesrc = await getFileSrc(loc)
  if (type === 'plain') {
    return filesrc
  } else if (type === 'css') {
    return `background: url("${filesrc}");background-size: cover;`
  } else if (type === 'lgcss') {
    return `background: url("${filesrc}");background-size: cover;height: 10.66rem;`
  } else {
    return `background: url("${filesrc}");background-size: contain;background-repeat: no-repeat;background-position: center;`
  }
}
