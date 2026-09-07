import { resetClientSessionForTests, demoteClientSession } from 'src/ts/clientSession'
import { setManagedReaderForTest, setManagedWriterForTest } from 'src/ts/__tests__/managedClientSession'
import { mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notificationMocks = vi.hoisted(() => ({
  applyServerBackedSetting: vi.fn(),
  initialize: vi.fn(),
  reconcile: vi.fn(),
  retryCleanup: vi.fn(),
  retrySetup: vi.fn(),
  retryStorage: vi.fn(),
}))

vi.mock('src/ts/server/settingsOwner.svelte', () => ({
  applyServerBackedSetting: notificationMocks.applyServerBackedSetting,
}))

vi.mock('src/ts/storage/database.svelte', async () => {
  const { getResourceDatabase } = await import('src/ts/__tests__/resourceDatabaseState')
  return { getDatabase: getResourceDatabase }
})

vi.mock('src/ts/server/pushNotificationSetting', async () => {
  const { notificationCoordinatorState } = await import('./NotificationToggle.testState')
  return {
    isRetryablePushNotificationFailure: (failure: { status: string; reason?: string }) =>
      failure.status === 'fallback' &&
      ['service-worker-failed', 'vapid-unavailable', 'subscription-failed', 'server-registration-failed'].includes(
        failure.reason ?? '',
      ),
    initializePushNotificationCoordinator: notificationMocks.initialize,
    pushNotificationCoordinatorState: notificationCoordinatorState,
    reconcileChatCompletionPushNotificationSetting: notificationMocks.reconcile,
    retryChatCompletionPushNotificationCleanup: notificationMocks.retryCleanup,
    retryChatCompletionPushNotificationSetup: notificationMocks.retrySetup,
    retryChatCompletionPushNotificationStorage: notificationMocks.retryStorage,
  }
})

import { language } from 'src/lang'
import {
  PUSH_NOTIFICATION_WARNING_DISMISSED_KEY,
  setPushNotificationWarningDismissed,
} from 'src/ts/gui/pushNotificationWarningPreference'
import NotificationToggle from './NotificationToggle.svelte'
import { initialNotificationCoordinatorState, notificationCoordinatorState } from './NotificationToggle.testState'
import { replaceResourceDatabase as setDatabaseLite, settingsResourceState } from 'src/ts/server/resourceState.svelte'
import type { EnablePushNotificationsResult } from 'src/ts/server/pushNotifications'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

type MountedComponent = Parameters<typeof unmount>[0]

let component: MountedComponent | undefined
let target: HTMLElement

function checkbox(): HTMLInputElement {
  const input = target.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!input) throw new Error('notification checkbox not found')
  return input
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(target.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === name,
  )
  if (!button) throw new Error(`button not found: ${name}`)
  return button
}

beforeEach(() => {
  setPushNotificationWarningDismissed(false)
  target = document.createElement('div')
  document.body.appendChild(target)
  setDatabaseLite({ notification: false } as any)
  notificationCoordinatorState.set(initialNotificationCoordinatorState())
  notificationMocks.applyServerBackedSetting.mockReset()
  notificationMocks.initialize.mockReset()
  notificationMocks.initialize.mockResolvedValue(undefined)
  notificationMocks.reconcile.mockReset()
  notificationMocks.retryCleanup.mockReset()
  notificationMocks.retrySetup.mockReset()
  notificationMocks.retryStorage.mockReset()
  notificationMocks.applyServerBackedSetting.mockImplementation((key: string, value: unknown) => {
    if (key !== 'notification') return
    withTestDatabaseWrite((database) => {
      database.notification = value as boolean
    })
  })
})

afterEach(() => {
  if (component) {
    unmount(component)
    component = undefined
  }
  target.remove()
  setPushNotificationWarningDismissed(false)
  setDatabaseLite({} as any)
  notificationCoordinatorState.set(initialNotificationCoordinatorState())
})

describe('NotificationToggle shared push acknowledgement', () => {
  const failedEnablements: Array<{
    name: string
    result: EnablePushNotificationsResult
    message: string
  }> = [
    {
      name: 'permission denial',
      result: { status: 'permission-denied' },
      message: language.permissionDenied,
    },
    {
      name: 'missing Notification API',
      result: { status: 'fallback', reason: 'notification-unavailable' },
      message: language.pushNotifications.setupFailures.notificationUnavailable,
    },
    {
      name: 'undecided permission',
      result: { status: 'fallback', reason: 'permission-default' },
      message: language.pushNotifications.setupFailures.permissionDefault,
    },
    {
      name: 'missing service worker',
      result: { status: 'fallback', reason: 'service-worker-unavailable' },
      message: language.pushNotifications.setupFailures.serviceWorkerUnavailable,
    },
    {
      name: 'missing Push API',
      result: { status: 'fallback', reason: 'push-unavailable' },
      message: language.pushNotifications.setupFailures.pushUnavailable,
    },
    {
      name: 'missing VAPID key',
      result: { status: 'fallback', reason: 'vapid-unavailable' },
      message: language.pushNotifications.setupFailures.vapidUnavailable,
    },
    {
      name: 'browser subscription failure',
      result: { status: 'fallback', reason: 'subscription-failed' },
      message: language.pushNotifications.setupFailures.subscriptionFailed,
    },
    {
      name: 'server registration failure',
      result: {
        status: 'fallback',
        reason: 'server-registration-failed',
        endpoint: 'https://push.example.test/unregistered',
      },
      message: language.pushNotifications.setupFailures.serverRegistrationFailed,
    },
  ]

  it.each(failedEnablements)('keeps the preference checked and explains $name', async ({ result, message }) => {
    notificationMocks.reconcile.mockImplementationOnce(async () => {
      notificationCoordinatorState.set({
        ...initialNotificationCoordinatorState(),
        desiredEnabled: true,
        setupFailure: result as Exclude<EnablePushNotificationsResult, { status: 'enabled' }>,
      })
      return { status: 'applied', enabled: true, result }
    })
    component = mount(NotificationToggle, { target })
    checkbox().click()
    await vi.waitFor(() =>
      expect(target.querySelector('[data-push-notification-warning]')?.textContent).toContain(message),
    )
    expect(target.textContent).toContain(language.pushNotifications.preferenceEnabled)
    expect(notificationMocks.applyServerBackedSetting.mock.calls).toEqual([['notification', true]])
    expect(notificationMocks.reconcile).toHaveBeenCalledWith(true, { requestPermission: true })
    expect(getDatabase().notification).toBe(true)
    expect(checkbox().checked).toBe(true)
    buttonNamed(language.pushNotifications.retrySetup).click()
    expect(notificationMocks.retrySetup).toHaveBeenCalledOnce()
  })

  it('keeps the explanation visible while retrying and clears it after success', async () => {
    notificationCoordinatorState.set({
      ...initialNotificationCoordinatorState(),
      desiredEnabled: true,
      setupFailure: { status: 'fallback', reason: 'vapid-unavailable' },
    })
    component = mount(NotificationToggle, { target })
    await tick()
    notificationCoordinatorState.update((state) => ({ ...state, phase: 'enabling' }))
    await tick()
    expect(target.textContent).toContain(language.pushNotifications.setupFailures.vapidUnavailable)
    expect(buttonNamed(language.pushNotifications.retryingSetup).disabled).toBe(true)
    notificationCoordinatorState.update((state) => ({ ...state, phase: 'idle', setupFailure: null }))
    await tick()
    expect(target.querySelector('[data-push-notification-warning]')).toBeNull()
  })

  it('lets the user intentionally switch notifications off while setup is unavailable', async () => {
    withTestDatabaseWrite((database) => {
      database.notification = true
    })
    notificationCoordinatorState.set({
      ...initialNotificationCoordinatorState(),
      desiredEnabled: true,
      setupFailure: { status: 'permission-denied' },
    })
    component = mount(NotificationToggle, { target })
    await tick()
    expect(target.textContent).toContain(language.pushNotifications.permissionBlockedHelp)
    checkbox().click()
    expect(notificationMocks.applyServerBackedSetting).toHaveBeenCalledWith('notification', false)
    expect(notificationMocks.reconcile).toHaveBeenCalledWith(false, { requestPermission: false })
  })

  it('restores dismissed banners locally while retaining notification diagnostics and the shared preference', async () => {
    setPushNotificationWarningDismissed(true)
    withTestDatabaseWrite((database) => {
      database.notification = true
    })
    notificationCoordinatorState.set({
      ...initialNotificationCoordinatorState(),
      desiredEnabled: true,
      setupFailure: { status: 'permission-denied' },
    })
    component = mount(NotificationToggle, { target })
    await tick()
    expect(target.querySelector('[data-push-notification-warning]')).not.toBeNull()
    const bannerCheckbox = Array.from(target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      (input) => input.getAttribute('aria-label') === language.pushNotifications.showBannerOnBrowser,
    )!
    expect(bannerCheckbox.checked).toBe(false)
    bannerCheckbox.click()
    await tick()
    expect(localStorage.getItem(PUSH_NOTIFICATION_WARNING_DISMISSED_KEY)).toBeNull()
    expect(bannerCheckbox.checked).toBe(true)
    bannerCheckbox.click()
    await tick()
    expect(localStorage.getItem(PUSH_NOTIFICATION_WARNING_DISMISSED_KEY)).toBe('true')
    expect(settingsResourceState.value?.notification).toBe(true)
    expect(checkbox().checked).toBe(true)
    expect(notificationMocks.applyServerBackedSetting).not.toHaveBeenCalled()
    expect(notificationMocks.reconcile).not.toHaveBeenCalled()
    buttonNamed(language.pushNotifications.retrySetup).click()
    expect(notificationMocks.retrySetup).toHaveBeenCalledOnce()
  })

  it('keeps partial cleanup visible and retryable across unmount and remount', async () => {
    const endpoint = 'https://push.example.test/stale'
    notificationCoordinatorState.set({
      ...initialNotificationCoordinatorState(),
      cleanup: {
        status: 'partial',
        subscriptionFound: true,
        localUnsubscribed: false,
        serverDeleted: false,
        pendingEndpoints: [endpoint],
        localInspectionPending: true,
        failures: [{ step: 'local-unsubscribe' }, { step: 'server-deletion', endpoint }],
      },
      pendingEndpoints: [endpoint],
      localInspectionPending: true,
    })
    notificationMocks.retryCleanup.mockImplementationOnce(async () => {
      notificationCoordinatorState.set({
        ...initialNotificationCoordinatorState(),
        cleanup: {
          status: 'disabled',
          subscriptionFound: false,
          localUnsubscribed: null,
          serverDeleted: true,
          pendingEndpoints: [],
          localInspectionPending: false,
          failures: [],
        },
      })
      return { status: 'applied', enabled: false }
    })

    component = mount(NotificationToggle, { target })
    await tick()
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      language.pushNotifications.cleanupFailures.localUnsubscribe,
    )
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.pushNotifications.pendingCleanup(1))
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      language.pushNotifications.localInspectionPending,
    )

    unmount(component)
    component = undefined
    target.replaceChildren()
    component = mount(NotificationToggle, { target })
    await tick()

    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      language.pushNotifications.cleanupFailures.serverDeletion,
    )
    buttonNamed(language.pushNotifications.retryCleanup).click()
    await vi.waitFor(() => expect(notificationMocks.retryCleanup).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(target.querySelector('[role="alert"]')).toBeNull())
  })

  it('retries a device-ledger failure without requiring notifications to be off', async () => {
    withTestDatabaseWrite((database) => {
      database.notification = true
    })
    notificationCoordinatorState.set({
      ...initialNotificationCoordinatorState(),
      retryStorageError: new Error('storage unavailable'),
    })
    component = mount(NotificationToggle, { target })
    await tick()

    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      language.pushNotifications.cleanupRetryStorageFailed,
    )
    buttonNamed(language.pushNotifications.retryStorage).click()
    await vi.waitFor(() => expect(notificationMocks.retryStorage).toHaveBeenCalledOnce())
  })

  it('shows an unexpected operation failure with a working retry action', async () => {
    notificationCoordinatorState.set({
      ...initialNotificationCoordinatorState(),
      operationError: new Error('unexpected failure'),
    })
    component = mount(NotificationToggle, { target })
    await tick()

    expect(target.querySelector('[role="alert"]')?.textContent).toContain(language.pushNotifications.operationFailed)
    buttonNamed(language.pushNotifications.retryOperation).click()
    await vi.waitFor(() => expect(notificationMocks.retryCleanup).toHaveBeenCalledOnce())
  })
})

beforeEach(() => resetClientSessionForTests())

it('disables the notification setting for a managed reader without changing the saved preference', async () => {
  setManagedReaderForTest()
  component = mount(NotificationToggle, { target })
  await tick()
  expect(checkbox().disabled).toBe(true)
  checkbox().click()
  await tick()
  expect(notificationMocks.applyServerBackedSetting).not.toHaveBeenCalled()
  expect(notificationMocks.reconcile).not.toHaveBeenCalled()
})

it('revokes a mounted notification setting immediately on demotion', async () => {
  setManagedWriterForTest()
  component = mount(NotificationToggle, { target })
  await tick()
  expect(checkbox().disabled).toBe(false)
  demoteClientSession()
  await tick()
  expect(checkbox().disabled).toBe(true)
  checkbox().click()
  expect(notificationMocks.applyServerBackedSetting).not.toHaveBeenCalled()
  expect(notificationMocks.reconcile).not.toHaveBeenCalled()
})
