import { captureClientSessionGeneration } from '../clientSession'
import { assertClientWriteOperation, isClientWriteOperationCurrent } from '../clientWriteOperation'
import { getNodeServerProxyAuth } from '../storage/fastifyStorage'
import { navigate } from '../router'

const SERVICE_WORKER_URL = '/service-worker.js'
const SERVICE_WORKER_SCOPE = '/'
const VAPID_PUBLIC_KEY_ENDPOINT = '/api/v1/push/vapid-public-key'
const PUSH_SUBSCRIPTIONS_ENDPOINT = '/api/v1/push/subscriptions'
const LOG_PREFIX = '[push notifications]'
const CHAT_COMPLETION_NOTIFICATION_TAG = 'risuai-chat-completion'
const NOTIFICATION_ROUTE_MESSAGE_TYPE = 'risuai:notification-route'
const NOTIFICATION_ROUTE_ACK_TYPE = 'risuai:notification-route-ack'

let serviceWorkerNavigationListenerTarget: ServiceWorkerContainer | null = null

export type PushNotificationFallbackReason =
  | 'notification-unavailable'
  | 'permission-default'
  | 'service-worker-unavailable'
  | 'service-worker-failed'
  | 'push-unavailable'
  | 'vapid-unavailable'
  | 'subscription-failed'
  | 'server-registration-failed'

export type EnablePushNotificationsResult =
  | { status: 'enabled'; endpoint: string }
  | {
      status: 'fallback'
      reason: PushNotificationFallbackReason
      endpoint?: string
    }
  | { status: 'permission-denied' }

export type DisablePushNotificationCleanupStep =
  | 'service-worker'
  | 'subscription-inspection'
  | 'local-unsubscribe'
  | 'server-deletion'

export interface DisablePushNotificationFailure {
  step: DisablePushNotificationCleanupStep
  error?: unknown
  endpoint?: string
}

export interface DisablePushNotificationsResult {
  status: 'disabled' | 'partial'
  subscriptionFound: boolean | null
  localUnsubscribed: boolean | null
  serverDeleted: boolean | null
  pendingEndpoints: string[]
  localInspectionPending: boolean
  failures: DisablePushNotificationFailure[]
}

type PushTransportResult = { ok: true } | { ok: false; error: unknown }

export function installPushNotificationNavigationListener(): void {
  if (!canUseServiceWorker() || navigator.serviceWorker === serviceWorkerNavigationListenerTarget) return

  navigator.serviceWorker.addEventListener('message', handleServiceWorkerNavigationMessage)
  serviceWorkerNavigationListenerTarget = navigator.serviceWorker
}

export function installPushNotificationForegroundCleanup(): () => void {
  if (!canUseServiceWorker() || typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {}
  }

  const handleForeground = () => {
    if (document.visibilityState === 'visible') void dismissChatCompletionNotifications()
  }

  document.addEventListener('visibilitychange', handleForeground)
  window.addEventListener('focus', handleForeground)
  window.addEventListener('pageshow', handleForeground)
  handleForeground()

  return () => {
    document.removeEventListener('visibilitychange', handleForeground)
    window.removeEventListener('focus', handleForeground)
    window.removeEventListener('pageshow', handleForeground)
  }
}

export async function dismissChatCompletionNotifications(): Promise<void> {
  if (!canUseServiceWorker()) return

  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE)
    if (!registration || typeof registration.getNotifications !== 'function') return

    const notifications = await registration.getNotifications({ tag: CHAT_COMPLETION_NOTIFICATION_TAG })
    for (const notification of notifications) notification.close()
  } catch (error) {
    warnPushError('Failed to dismiss local chat completion notifications.', error)
  }
}

function handleServiceWorkerNavigationMessage(event: MessageEvent<unknown>): void {
  const targetPath = readServiceWorkerNavigationPath(event.data)
  const acknowledgementPort = event.ports?.[0]
  if (!targetPath || !acknowledgementPort || typeof acknowledgementPort.postMessage !== 'function') return

  try {
    navigate(targetPath)
    acknowledgementPort.postMessage({ type: NOTIFICATION_ROUTE_ACK_TYPE })
  } catch (error) {
    warnPushError('Failed to apply a notification route in-app.', error)
  }
}

function readServiceWorkerNavigationPath(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null

  const message = data as { type?: unknown; url?: unknown }
  if (message.type !== NOTIFICATION_ROUTE_MESSAGE_TYPE || typeof message.url !== 'string') return null
  if (typeof window === 'undefined') return null

  try {
    const targetUrl = new URL(message.url)
    if (targetUrl.origin !== window.location.origin) return null
    return targetUrl.pathname
  } catch {
    return null
  }
}

export async function enableChatCompletionPushNotifications(): Promise<EnablePushNotificationsResult> {
  const operation = captureClientSessionGeneration()
  const denied = { status: 'fallback', reason: 'server-registration-failed' } as const
  if (!isClientWriteOperationCurrent(operation)) return denied
  const permission = typeof Notification === 'undefined' ? 'unavailable' : Notification.permission
  if (permission === 'denied') return { status: 'permission-denied' }
  if (permission === 'unavailable') return { status: 'fallback', reason: 'notification-unavailable' }
  if (permission !== 'granted') return { status: 'fallback', reason: 'permission-default' }

  if (!canUseServiceWorker()) {
    return { status: 'fallback', reason: 'service-worker-unavailable' }
  }

  const registration = await registerPushServiceWorker(operation)
  if (!isClientWriteOperationCurrent(operation)) return denied
  if (!registration) return { status: 'fallback', reason: 'service-worker-failed' }

  const pushManager = pushManagerForRegistration(registration)
  if (!pushManager) return { status: 'fallback', reason: 'push-unavailable' }

  const publicKey = await fetchVapidPublicKey()
  if (!isClientWriteOperationCurrent(operation)) return denied
  if (!publicKey) return { status: 'fallback', reason: 'vapid-unavailable' }

  const subscription = await getOrCreatePushSubscription(pushManager, publicKey, operation)
  if (!isClientWriteOperationCurrent(operation)) return denied
  if (!subscription) return { status: 'fallback', reason: 'subscription-failed' }

  const endpoint = subscription.endpoint
  const registered = await registerPushSubscription(subscription, operation)
  if (!registered.ok) {
    // A failed refresh must not destroy a subscription that may already be
    // registered on the server. Reuse it when connectivity recovers.
    return {
      status: 'fallback',
      reason: 'server-registration-failed',
      endpoint,
    }
  }

  if (!isClientWriteOperationCurrent(operation)) return denied
  return { status: 'enabled', endpoint }
}

export async function disableChatCompletionPushNotifications(
  pendingEndpoints: readonly string[] = [],
  requireLocalInspection = false,
): Promise<DisablePushNotificationsResult> {
  const operation = captureClientSessionGeneration()
  if (!isClientWriteOperationCurrent(operation)) {
    return {
      status: 'partial',
      subscriptionFound: null,
      localUnsubscribed: null,
      serverDeleted: null,
      pendingEndpoints: [...pendingEndpoints],
      localInspectionPending: requireLocalInspection,
      failures: [{ step: 'subscription-inspection', error: 'client_write_access_required' }],
    }
  }
  const failures: DisablePushNotificationFailure[] = []
  const endpoints = new Set(pendingEndpoints)
  let subscriptionFound: boolean | null = null
  let localUnsubscribed: boolean | null = null
  let localInspectionPending = requireLocalInspection

  if (!canUseServiceWorker()) {
    if (requireLocalInspection) {
      failures.push({ step: 'service-worker' })
      localInspectionPending = true
    } else {
      subscriptionFound = false
      localInspectionPending = false
    }
  } else {
    try {
      const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE)
      const pushManager = registration ? pushManagerForRegistration(registration) : null
      const subscription = pushManager ? await pushManager.getSubscription() : null
      subscriptionFound = !!subscription
      localInspectionPending = false

      if (subscription) {
        endpoints.add(subscription.endpoint)
        const unsubscribeResult = await unsubscribePushSubscription(subscription, operation)
        localUnsubscribed = unsubscribeResult.ok
        if (unsubscribeResult.ok === false) {
          localInspectionPending = true
          failures.push({
            step: 'local-unsubscribe',
            endpoint: subscription.endpoint,
            error: unsubscribeResult.error,
          })
        }
      }
    } catch (error) {
      warnPushError('Failed to inspect local push subscription.', error)
      localInspectionPending = true
      failures.push({ step: 'subscription-inspection', error })
    }
  }

  let serverDeleted: boolean | null = null
  const failedServerEndpoints: string[] = []
  if (endpoints.size > 0) {
    const deletionResults = await Promise.all(
      [...endpoints].map(async (endpoint) => ({ endpoint, result: await deletePushSubscription(endpoint, operation) })),
    )
    serverDeleted = deletionResults.every(({ result }) => result.ok)
    for (const { endpoint, result } of deletionResults) {
      if (result.ok === false) {
        failedServerEndpoints.push(endpoint)
        failures.push({ step: 'server-deletion', endpoint, error: result.error })
      }
    }
  }

  const localCleanupPending = subscriptionFound === true && localUnsubscribed !== true
  const unresolvedEndpoints = new Set(failedServerEndpoints)
  if (localCleanupPending) {
    for (const endpoint of endpoints) unresolvedEndpoints.add(endpoint)
  }

  return {
    status: failures.length === 0 ? 'disabled' : 'partial',
    subscriptionFound,
    localUnsubscribed,
    serverDeleted,
    pendingEndpoints: [...unresolvedEndpoints],
    localInspectionPending,
    failures,
  }
}

/** Call directly from a user action, before awaiting storage or network work. */
export async function requestChatCompletionNotificationPermission(): Promise<NotificationPermission | 'unavailable'> {
  const operation = captureClientSessionGeneration()
  if (!isClientWriteOperationCurrent(operation)) return 'unavailable'
  if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') {
    return 'unavailable'
  }

  if (Notification.permission !== 'default') return Notification.permission

  try {
    const permission = await Notification.requestPermission()
    return isClientWriteOperationCurrent(operation) ? permission : 'unavailable'
  } catch (error) {
    warnPushError('Failed to request notification permission.', error)
    return Notification.permission
  }
}

function canUseServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.serviceWorker
}

async function registerPushServiceWorker(operation: number): Promise<ServiceWorkerRegistration | null> {
  try {
    assertClientWriteOperation(operation)
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL)
  } catch (error) {
    warnPushError('Failed to register the notification service worker.', error)
    return null
  }
}

function pushManagerForRegistration(registration: ServiceWorkerRegistration): PushManager | null {
  const candidate = registration as ServiceWorkerRegistration & { pushManager?: PushManager }
  return candidate.pushManager ?? null
}

async function fetchVapidPublicKey(): Promise<string | null> {
  let response: Response
  try {
    response = await fetch(VAPID_PUBLIC_KEY_ENDPOINT, { method: 'GET' })
  } catch (error) {
    warnPushError('Failed to fetch the VAPID public key.', error)
    return null
  }

  if (!response.ok) {
    warnPushError(`Failed to fetch the VAPID public key: HTTP ${response.status}.`)
    return null
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    warnPushError('Failed to parse the VAPID public key response.', error)
    return null
  }

  if (!body || typeof body !== 'object') {
    warnPushError('Failed to parse the VAPID public key response.')
    return null
  }

  const publicKey = (body as { publicKey?: unknown }).publicKey
  if (publicKey === null) return null
  if (typeof publicKey === 'string' && publicKey.length > 0) return publicKey

  warnPushError('The VAPID public key response was invalid.')
  return null
}

async function getOrCreatePushSubscription(
  pushManager: PushManager,
  publicKey: string,
  operation: number,
): Promise<PushSubscription | null> {
  try {
    assertClientWriteOperation(operation)
    const existingSubscription = await pushManager.getSubscription()
    assertClientWriteOperation(operation)
    if (existingSubscription) return existingSubscription

    return await pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  } catch (error) {
    warnPushError('Failed to subscribe to browser push notifications.', error)
    return null
  }
}

async function registerPushSubscription(
  subscription: PushSubscription,
  operation: number,
): Promise<PushTransportResult> {
  try {
    assertClientWriteOperation(operation)
    const auth = await getNodeServerProxyAuth()
    assertClientWriteOperation(operation)
    const response = await fetch(PUSH_SUBSCRIPTIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'risu-auth': auth,
      },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return { ok: true }
  } catch (error) {
    warnPushError('Failed to register the push subscription with the server.', error)
    return { ok: false, error }
  }
}

async function deletePushSubscription(endpoint: string, operation: number): Promise<PushTransportResult> {
  try {
    assertClientWriteOperation(operation)
    const auth = await getNodeServerProxyAuth()
    assertClientWriteOperation(operation)
    const response = await fetch(PUSH_SUBSCRIPTIONS_ENDPOINT, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'risu-auth': auth,
      },
      body: JSON.stringify({ endpoint }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return { ok: true }
  } catch (error) {
    warnPushError('Failed to delete the push subscription from the server.', error)
    return { ok: false, error }
  }
}

async function unsubscribePushSubscription(
  subscription: PushSubscription,
  operation: number,
): Promise<PushTransportResult> {
  try {
    assertClientWriteOperation(operation)
    const unsubscribed = await subscription.unsubscribe()
    if (!unsubscribed) throw new Error('Browser push subscription unsubscribe returned false.')
    return { ok: true }
  } catch (error) {
    warnPushError('Failed to unsubscribe from local push notifications.', error)
    return { ok: false, error }
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length) as Uint8Array<ArrayBuffer>

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i)
  }

  return outputArray
}

function warnPushError(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`${LOG_PREFIX} ${message}`)
    return
  }
  console.warn(`${LOG_PREFIX} ${message}`, error)
}
