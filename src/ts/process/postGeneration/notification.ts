import { canUseClientWriteAccess, captureClientSessionGeneration } from '../../clientSession'
import { isClientWriteOperationCurrent } from '../../clientWriteOperation'
import type { character } from '../../storage/database.svelte'
const RISU_NOTIFICATION_ICON = '/logo_192.png'
const MAX_NOTIFICATION_BODY_BYTES = 1024
const NOTIFICATION_BODY_TRUNCATION_MARKER = '...'
const SERVER_ASSET_ID_RE = /^[0-9a-fA-F]{64}$/
const LOCAL_ASSET_PATH_RE = /^assets\/([0-9a-fA-F]{64})\.[a-z0-9]+$/i

export interface DesktopNotificationInput {
  body: string
  icon?: string | null
}

export function chatCompletionNotificationInput(
  currentChar: Pick<character, 'customNotificationMessage' | 'notificationImage' | 'image'>,
  defaultBody: string,
): DesktopNotificationInput {
  const customBody = currentChar.customNotificationMessage?.trim()
  const customIcon = currentChar.notificationImage?.trim()
  return {
    body: customBody || defaultBody,
    ...(customIcon || currentChar.image ? { icon: customIcon || currentChar.image } : {}),
  }
}

export async function fireDesktopNotification(input: string | DesktopNotificationInput): Promise<void> {
  if (!canUseClientWriteAccess()) return
  const operation = captureClientSessionGeneration()
  try {
    const permission = await Notification.requestPermission()
    if (!isClientWriteOperationCurrent(operation)) return
    if (permission !== 'granted') return
    const { body, icon } = normalizeNotificationInput(input)
    const noti = new Notification('Risuai', {
      body,
      icon,
      badge: RISU_NOTIFICATION_ICON,
    })
    noti.onclick = () => {
      window.focus()
    }
  } catch {}
}

function normalizeNotificationInput(input: string | DesktopNotificationInput): { body: string; icon: string } {
  if (typeof input === 'string') {
    return { body: truncateNotificationBody(input), icon: RISU_NOTIFICATION_ICON }
  }
  return {
    body: truncateNotificationBody(input.body),
    icon: notificationIconUrl(input.icon ?? '') ?? RISU_NOTIFICATION_ICON,
  }
}

function notificationIconUrl(reference: string): string | undefined {
  const trimmed = reference.trim()
  if (!trimmed) return undefined
  if (
    trimmed.startsWith('/api/v1/assets/') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('/')
  ) {
    return trimmed
  }
  if (SERVER_ASSET_ID_RE.test(trimmed)) return `/api/v1/assets/${encodeURIComponent(trimmed)}`
  const localAssetMatch = LOCAL_ASSET_PATH_RE.exec(trimmed)
  if (localAssetMatch) return `/api/v1/assets/${encodeURIComponent(localAssetMatch[1])}`
  return undefined
}

function truncateNotificationBody(body: string): string {
  if (notificationBodyBytes(body) <= MAX_NOTIFICATION_BODY_BYTES) return body

  let truncated = ''
  for (const char of body) {
    const candidate = `${truncated}${char}${NOTIFICATION_BODY_TRUNCATION_MARKER}`
    if (notificationBodyBytes(candidate) > MAX_NOTIFICATION_BODY_BYTES) break
    truncated += char
  }
  return `${truncated.trimEnd()}${NOTIFICATION_BODY_TRUNCATION_MARKER}`
}

function notificationBodyBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength
}
