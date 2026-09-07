import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

vi.mock('./pushNotifications', () => ({
  disableChatCompletionPushNotifications: vi.fn(async () => ({
    status: 'disabled',
    subscriptionFound: false,
    localUnsubscribed: null,
    serverDeleted: null,
    pendingEndpoints: [],
    localInspectionPending: false,
    failures: [],
  })),
  requestChatCompletionNotificationPermission: vi.fn(async () => 'granted'),
  enableChatCompletionPushNotifications: vi.fn(async () => ({ status: 'enabled', endpoint: 'test' })),
}))

vi.mock('./settingsOwner.svelte', () => ({
  persistServerBackedSettingsPatchWithSettlement: vi.fn(async () => ({ status: 'accepted' })),
}))

vi.mock('./activeWriterSession', () => ({ isWriterAccessLost: () => false }))

import {
  createPushNotificationCoordinator,
  createPushNotificationSettingApplyDesiredState,
  createPushNotificationSettingReconciler,
} from './pushNotificationSetting'
import type { PushNotificationRetryStorage } from './pushNotificationRetryStorage'
import { persistServerBackedSettingsPatchWithSettlement } from './settingsOwner.svelte'
import type { CreatePushNotificationCoordinatorDependencies } from './pushNotificationSetting'
import type { BrowserLifecycleRecoveryTrigger } from './lifecycleRecovery'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function memoryRetryStorage(initialEndpoints: string[] = [], initialInspectionPending = false) {
  let persisted = {
    pendingEndpoints: [...initialEndpoints],
    localInspectionPending: initialInspectionPending,
  }
  const storage: PushNotificationRetryStorage = {
    loadPendingCleanup: vi.fn(async () => ({
      pendingEndpoints: [...persisted.pendingEndpoints],
      localInspectionPending: persisted.localInspectionPending,
    })),
    savePendingCleanup: vi.fn(async (state) => {
      persisted = {
        pendingEndpoints: [...state.pendingEndpoints],
        localInspectionPending: state.localInspectionPending,
      }
    }),
  }
  return {
    storage,
    persisted: () => [...persisted.pendingEndpoints],
    inspectionPending: () => persisted.localInspectionPending,
  }
}

function disabledResult() {
  return {
    status: 'disabled' as const,
    subscriptionFound: false,
    localUnsubscribed: null,
    serverDeleted: null,
    pendingEndpoints: [],
    localInspectionPending: false,
    failures: [],
  }
}

const coordinators: ReturnType<typeof createPushNotificationCoordinator>[] = []

function makeCoordinator(dependencies: CreatePushNotificationCoordinatorDependencies = {}) {
  const coordinator = createPushNotificationCoordinator({
    retryStorage: memoryRetryStorage().storage,
    subscribeRecovery: () => () => {},
    ...dependencies,
  })
  coordinators.push(coordinator)
  return coordinator
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('push notification setting reconciliation', () => {
  it('coalesces duplicate requests and applies the latest state after an in-flight operation', async () => {
    const enable = deferred<string>()
    const disable = deferred<string>()
    const applyDesiredState = vi.fn((enabled: boolean) => (enabled ? enable.promise : disable.promise))
    const reconciler = createPushNotificationSettingReconciler(applyDesiredState)

    const firstEnable = reconciler.reconcile(true)
    const duplicateEnable = reconciler.reconcile(true)
    expect(duplicateEnable).toBe(firstEnable)
    await vi.waitFor(() => expect(applyDesiredState).toHaveBeenCalledTimes(1))

    const latestDisable = reconciler.reconcile(false)
    enable.resolve('enabled')
    await expect(firstEnable).resolves.toEqual({ status: 'applied', enabled: true, result: 'enabled' })
    await vi.waitFor(() => expect(applyDesiredState).toHaveBeenCalledTimes(2))
    expect(applyDesiredState).toHaveBeenLastCalledWith(false)

    disable.resolve('disabled')
    await expect(latestDisable).resolves.toEqual({ status: 'applied', enabled: false, result: 'disabled' })
  })

  it('skips queued states superseded before transport starts', async () => {
    const applyDesiredState = vi.fn(async (enabled: boolean) => enabled)
    const reconciler = createPushNotificationSettingReconciler(applyDesiredState)

    const enable = reconciler.reconcile(true)
    const disable = reconciler.reconcile(false)

    await expect(enable).resolves.toEqual({ status: 'superseded', enabled: true })
    await expect(disable).resolves.toEqual({ status: 'applied', enabled: false, result: false })
    expect(applyDesiredState).toHaveBeenCalledOnce()
    expect(applyDesiredState).toHaveBeenCalledWith(false)
  })

  it('allows the same desired state to retry after an unexpected failure', async () => {
    const applyDesiredState = vi
      .fn<(enabled: boolean) => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('enabled')
    const reconciler = createPushNotificationSettingReconciler(applyDesiredState)

    await expect(reconciler.reconcile(true)).resolves.toMatchObject({
      status: 'error',
      enabled: true,
      error: expect.any(Error),
    })
    await expect(reconciler.reconcile(true)).resolves.toEqual({
      status: 'applied',
      enabled: true,
      result: 'enabled',
    })
    expect(applyDesiredState).toHaveBeenCalledTimes(2)
  })

  it('forces an explicit cleanup retry after a resolved partial result', async () => {
    const applyDesiredState = vi.fn(async () => 'partial')
    const reconciler = createPushNotificationSettingReconciler(applyDesiredState)

    await expect(reconciler.reconcile(false)).resolves.toEqual({
      status: 'applied',
      enabled: false,
      result: 'partial',
    })
    await expect(reconciler.reconcile(false, { force: true })).resolves.toEqual({
      status: 'applied',
      enabled: false,
      result: 'partial',
    })
    expect(applyDesiredState).toHaveBeenCalledTimes(2)
  })

  it('carries an unresolved registration endpoint through disable retries', async () => {
    const endpoint = 'https://push.example.test/pending-registration'
    const enable = vi.fn(async () => ({
      status: 'fallback' as const,
      reason: 'server-registration-failed' as const,
      endpoint,
    }))
    const disable = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'partial' as const,
        subscriptionFound: false,
        localUnsubscribed: null,
        serverDeleted: false,
        pendingEndpoints: [endpoint],
        localInspectionPending: false,
        failures: [{ step: 'server-deletion' as const, endpoint }],
      })
      .mockResolvedValueOnce({
        status: 'disabled' as const,
        subscriptionFound: false,
        localUnsubscribed: null,
        serverDeleted: true,
        pendingEndpoints: [],
        localInspectionPending: false,
        failures: [],
      })
    const retryStorage = memoryRetryStorage()
    const applyDesiredState = createPushNotificationSettingApplyDesiredState(enable, disable, retryStorage.storage)

    await applyDesiredState.apply(true)
    await applyDesiredState.apply(false)
    await applyDesiredState.apply(false)

    expect(disable.mock.calls).toEqual([
      [[], false],
      [[endpoint], false],
    ])
  })

  const setupFailures = [
    { status: 'permission-denied' as const },
    ...(
      [
        'notification-unavailable',
        'permission-default',
        'service-worker-unavailable',
        'service-worker-failed',
        'push-unavailable',
        'vapid-unavailable',
        'subscription-failed',
        'server-registration-failed',
      ] as const
    ).map((reason) => ({ status: 'fallback' as const, reason })),
  ]

  it.each(setupFailures)('preserves enabled preference and subscriptions after $status $reason', async (failure) => {
    const disablePushNotifications = vi.fn(async () => disabledResult())
    const coordinator = makeCoordinator({
      enablePushNotifications: vi.fn(async () => failure),
      disablePushNotifications,
    })
    await coordinator.reconcile(true)
    expect(persistServerBackedSettingsPatchWithSettlement).not.toHaveBeenCalled()
    expect(disablePushNotifications).not.toHaveBeenCalled()
    expect(get(coordinator.state)).toMatchObject({ desiredEnabled: true, setupFailure: failure })
  })

  it('backs off temporary failures and clears the warning only after recovery', async () => {
    const recovered = deferred<{ status: 'enabled'; endpoint: string }>()
    const failure = { status: 'fallback' as const, reason: 'vapid-unavailable' as const }
    const enable = vi
      .fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockReturnValueOnce(recovered.promise)
    const permission = vi.fn()
    const coordinator = makeCoordinator({ enablePushNotifications: enable, requestPermission: permission })
    await coordinator.reconcile(true)
    expect(get(coordinator.state).nextRetryAt).toBe(Date.now() + 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(enable).toHaveBeenCalledTimes(2)
    expect(get(coordinator.state).nextRetryAt).toBe(Date.now() + 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(get(coordinator.state)).toMatchObject({ phase: 'enabling', setupFailure: failure, desiredEnabled: true })
    recovered.resolve({ status: 'enabled', endpoint: 'recovered' })
    await vi.advanceTimersByTimeAsync(0)
    expect(get(coordinator.state)).toMatchObject({
      phase: 'idle',
      setupFailure: null,
      nextRetryAt: null,
      desiredEnabled: true,
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enable).toHaveBeenCalledTimes(3)
    expect(permission).not.toHaveBeenCalled()
  })

  it('caps repeated retries at one minute', async () => {
    const coordinator = makeCoordinator({
      enablePushNotifications: vi.fn(async () => ({
        status: 'fallback' as const,
        reason: 'subscription-failed' as const,
      })),
    })
    await coordinator.reconcile(true)
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      expect(get(coordinator.state).nextRetryAt).toBe(Date.now() + delay)
      await vi.advanceTimersByTimeAsync(delay)
    }
  })

  it.each([
    'permission-default',
    'notification-unavailable',
    'push-unavailable',
    'service-worker-unavailable',
  ] as const)('waits for user action or a lifecycle check for %s', async (reason) => {
    const enable = vi.fn(async () => ({ status: 'fallback' as const, reason }))
    const permission = vi.fn()
    const coordinator = makeCoordinator({ enablePushNotifications: enable, requestPermission: permission })
    await coordinator.reconcile(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enable).toHaveBeenCalledOnce()
    expect(permission).not.toHaveBeenCalled()
    expect(get(coordinator.state).nextRetryAt).toBeNull()
  })

  it('requests permission immediately on user retry, coalesces projections and forces fresh setup', async () => {
    const permission = deferred<void>()
    const requestPermission = vi.fn(() => permission.promise)
    const enable = vi
      .fn()
      .mockResolvedValueOnce({ status: 'permission-denied' })
      .mockResolvedValueOnce({ status: 'enabled', endpoint: 'restored' })
    const coordinator = makeCoordinator({ enablePushNotifications: enable, requestPermission })
    await coordinator.reconcile(true)
    const retry = coordinator.retrySetup()
    expect(requestPermission).toHaveBeenCalledOnce()
    expect(get(coordinator.state).phase).toBe('enabling')
    expect(coordinator.reconcile(true)).toBe(retry)
    expect(get(coordinator.state).setupFailure).toEqual({ status: 'permission-denied' })
    permission.resolve()
    await retry
    expect(enable).toHaveBeenCalledTimes(2)
    expect(get(coordinator.state).setupFailure).toBeNull()
  })

  it('opens an explicit permission request before startup hydration finishes', async () => {
    const hydration = deferred<{ pendingEndpoints: string[]; localInspectionPending: boolean }>()
    const requestPermission = vi.fn(async () => 'granted')
    const coordinator = makeCoordinator({
      requestPermission,
      retryStorage: {
        loadPendingCleanup: () => hydration.promise,
        savePendingCleanup: vi.fn(async () => {}),
      },
    })
    const enabling = coordinator.reconcile(true, { requestPermission: true })
    expect(requestPermission).toHaveBeenCalledOnce()
    hydration.resolve({ pendingEndpoints: [], localInspectionPending: false })
    await enabling
  })

  it('recovers on online and foreground signals without permission prompts', async () => {
    let onRecovery!: (trigger: BrowserLifecycleRecoveryTrigger) => void
    let online = false
    const enable = vi
      .fn()
      .mockResolvedValueOnce({ status: 'fallback', reason: 'vapid-unavailable' })
      .mockResolvedValueOnce({ status: 'permission-denied' })
      .mockResolvedValue({ status: 'enabled', endpoint: 'restored' })
    const requestPermission = vi.fn()
    const coordinator = makeCoordinator({
      enablePushNotifications: enable,
      requestPermission,
      isOnline: () => online,
      subscribeRecovery: (listener) => {
        onRecovery = listener
        return () => {}
      },
    })
    await coordinator.reconcile(true)
    expect(get(coordinator.state).nextRetryAt).toBeNull()
    online = true
    onRecovery('online')
    await vi.advanceTimersByTimeAsync(0)
    expect(get(coordinator.state).setupFailure).toEqual({ status: 'permission-denied' })
    await vi.advanceTimersByTimeAsync(1_000)
    onRecovery('visibility')
    onRecovery('focus')
    onRecovery('pageshow')
    await vi.advanceTimersByTimeAsync(0)
    expect(enable).toHaveBeenCalledTimes(3)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(get(coordinator.state).setupFailure).toBeNull()
  })

  it('cancels retry and warning on intentional disable', async () => {
    const enable = vi.fn(async () => ({ status: 'fallback' as const, reason: 'server-registration-failed' as const }))
    const disable = vi.fn(async () => disabledResult())
    const coordinator = makeCoordinator({ enablePushNotifications: enable, disablePushNotifications: disable })
    await coordinator.reconcile(true)
    await coordinator.reconcile(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enable).toHaveBeenCalledOnce()
    expect(disable).toHaveBeenCalledOnce()
    expect(get(coordinator.state)).toMatchObject({ desiredEnabled: false, setupFailure: null, nextRetryAt: null })
    await expect(coordinator.retrySetup()).resolves.toMatchObject({ status: 'superseded' })
  })

  it('does not let a late failed retry override a newer disable', async () => {
    const pending = deferred<{ status: 'fallback'; reason: 'subscription-failed' }>()
    const enable = vi
      .fn()
      .mockResolvedValueOnce({ status: 'fallback', reason: 'subscription-failed' })
      .mockReturnValueOnce(pending.promise)
    const disable = vi.fn(async () => disabledResult())
    const coordinator = makeCoordinator({ enablePushNotifications: enable, disablePushNotifications: disable })
    await coordinator.reconcile(true)
    await vi.advanceTimersByTimeAsync(5_000)
    const disabling = coordinator.reconcile(false)
    pending.resolve({ status: 'fallback', reason: 'subscription-failed' })
    await disabling
    expect(get(coordinator.state)).toMatchObject({ desiredEnabled: false, setupFailure: null, nextRetryAt: null })
    expect(disable).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(enable).toHaveBeenCalledTimes(2)
  })

  it('stops automatic retry after writer access is lost', async () => {
    let canRetry = true
    const enable = vi.fn(async () => ({ status: 'fallback' as const, reason: 'vapid-unavailable' as const }))
    const coordinator = makeCoordinator({ enablePushNotifications: enable, canRetry: () => canRetry })
    await coordinator.reconcile(true)
    canRetry = false
    await vi.advanceTimersByTimeAsync(120_000)
    expect(enable).toHaveBeenCalledOnce()
    expect(get(coordinator.state).nextRetryAt).toBeNull()
  })

  it('disposes retries and listeners, ignores late results, and revalidates on remount', async () => {
    const pending = deferred<{ status: 'fallback'; reason: 'subscription-failed' }>()
    const enable = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ status: 'enabled', endpoint: 'remount' })
    const stopRecovery = vi.fn()
    const coordinator = makeCoordinator({ enablePushNotifications: enable, subscribeRecovery: () => stopRecovery })
    const enabling = coordinator.reconcile(true)
    await vi.advanceTimersByTimeAsync(0)
    coordinator.dispose()
    coordinator.dispose()
    pending.resolve({ status: 'fallback', reason: 'subscription-failed' })
    await expect(enabling).resolves.toMatchObject({ status: 'superseded' })
    expect(stopRecovery).toHaveBeenCalledOnce()
    expect(get(coordinator.state)).toMatchObject({
      phase: 'idle',
      desiredEnabled: false,
      setupFailure: null,
      nextRetryAt: null,
    })
    await coordinator.reconcile(true)
    expect(enable).toHaveBeenCalledTimes(2)
    expect(get(coordinator.state)).toMatchObject({ desiredEnabled: true, setupFailure: null })
  })

  it('fences reconciliation waiting on initialization when disposed', async () => {
    const hydration = deferred<{ pendingEndpoints: string[]; localInspectionPending: boolean }>()
    const enable = vi.fn()
    const disable = vi.fn()
    const coordinator = makeCoordinator({
      enablePushNotifications: enable,
      disablePushNotifications: disable,
      retryStorage: {
        loadPendingCleanup: () => hydration.promise,
        savePendingCleanup: vi.fn(async () => {}),
      },
    })
    const enabling = coordinator.reconcile(true)
    coordinator.dispose()
    hydration.resolve({ pendingEndpoints: ['https://push.example/stale'], localInspectionPending: true })
    await enabling
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(get(coordinator.state)).toMatchObject({ phase: 'idle', desiredEnabled: false, pendingEndpoints: [] })
  })

  it('shows and automatically retries unexpected setup errors', async () => {
    const failure = new Error('temporary browser failure')
    const enable = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ status: 'enabled', endpoint: 'restored' })
    const coordinator = makeCoordinator({ enablePushNotifications: enable })
    await coordinator.reconcile(true)
    expect(get(coordinator.state)).toMatchObject({ desiredEnabled: true, operationError: failure })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(get(coordinator.state)).toMatchObject({ desiredEnabled: true, operationError: null, nextRetryAt: null })
  })

  it('retains intentional disable cleanup across reload and retries it', async () => {
    const endpoint = 'https://push.example/cleanup'
    const storage = memoryRetryStorage()
    const first = makeCoordinator({
      retryStorage: storage.storage,
      disablePushNotifications: vi.fn(async () => ({
        ...disabledResult(),
        status: 'partial' as const,
        pendingEndpoints: [endpoint],
        localInspectionPending: true,
        failures: [{ step: 'server-deletion' as const, endpoint }],
      })),
    })
    await first.reconcile(false)
    first.dispose()
    const disable = vi.fn(async () => disabledResult())
    const reloaded = makeCoordinator({ retryStorage: storage.storage, disablePushNotifications: disable })
    await reloaded.initialize()
    expect(disable).toHaveBeenCalledWith([endpoint], true)
    expect(storage.persisted()).toEqual([])
    expect(storage.inspectionPending()).toBe(false)
  })

  it('recreates the warning on reload when the enabled preference still cannot be applied', async () => {
    const failure = { status: 'permission-denied' as const }
    const first = makeCoordinator({ enablePushNotifications: vi.fn(async () => failure) })
    await first.reconcile(true)
    first.dispose()
    const reloaded = makeCoordinator({ enablePushNotifications: vi.fn(async () => failure) })
    await reloaded.reconcile(true)
    expect(get(reloaded.state)).toMatchObject({ desiredEnabled: true, setupFailure: failure })
    expect(persistServerBackedSettingsPatchWithSettlement).not.toHaveBeenCalled()
  })

  it('retries device-ledger storage without changing notification state', async () => {
    const storageFailure = new Error('storage unavailable')
    const enable = vi.fn()
    const disable = vi.fn()
    const coordinator = makeCoordinator({
      enablePushNotifications: enable,
      disablePushNotifications: disable,
      retryStorage: {
        loadPendingCleanup: vi
          .fn()
          .mockRejectedValueOnce(storageFailure)
          .mockResolvedValue({ pendingEndpoints: [], localInspectionPending: false }),
        savePendingCleanup: vi.fn(async () => {}),
      },
    })
    await coordinator.initialize()
    expect(get(coordinator.state).retryStorageError).toBe(storageFailure)
    await coordinator.retryStorage()
    expect(get(coordinator.state).retryStorageError).toBeNull()
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })
})

beforeEach(() => resetClientSessionForTests())

describe('push coordinator managed-session admission', () => {
  it('hydrates reader retry metadata without permission, subscription or cleanup effects', async () => {
    setManagedReaderForTest()
    const enable = vi.fn()
    const disable = vi.fn()
    const permission = vi.fn()
    const retry = memoryRetryStorage(['https://push.example.test/old'], true)
    const coordinator = makeCoordinator({
      enablePushNotifications: enable,
      disablePushNotifications: disable,
      requestPermission: permission,
      retryStorage: retry.storage,
    })
    await coordinator.initialize()
    await expect(coordinator.reconcile(true, { requestPermission: true })).resolves.toEqual({
      status: 'superseded',
      enabled: true,
    })
    await expect(coordinator.retryCleanup()).resolves.toMatchObject({ status: 'superseded' })
    expect(get(coordinator.state).pendingEndpoints).toEqual(['https://push.example.test/old'])
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
    expect(permission).not.toHaveBeenCalled()
  })

  it('does not enable or publish a fallback after pending permission crosses repromotion', async () => {
    setManagedWriterForTest()
    const permission = deferred<void>()
    const enable = vi.fn(async () => ({ status: 'fallback' as const, reason: 'server-registration-failed' as const }))
    const coordinator = makeCoordinator({
      enablePushNotifications: enable,
      requestPermission: () => permission.promise,
    })
    const pending = coordinator.reconcile(true, { requestPermission: true })
    demoteAndRepromoteForTest()
    permission.resolve(undefined)
    await expect(pending).resolves.toEqual({ status: 'superseded', enabled: true })
    expect(enable).not.toHaveBeenCalled()
    expect(get(coordinator.state).setupFailure).toBeNull()
    expect(get(coordinator.state).nextRetryAt).toBeNull()
  })

  it('does not execute a reconciliation queued before demotion and repromotion', async () => {
    setManagedWriterForTest()
    const apply = vi.fn(async () => 'enabled')
    const reconciler = createPushNotificationSettingReconciler(apply)
    const pending = reconciler.reconcile(true)
    demoteAndRepromoteForTest()
    await expect(pending).resolves.toEqual({ status: 'superseded', enabled: true })
    expect(apply).not.toHaveBeenCalled()
    await expect(reconciler.reconcile(true)).resolves.toEqual({ status: 'applied', enabled: true, result: 'enabled' })
  })

  it('fences pending cleanup hydration before invoking a device adapter', async () => {
    setManagedWriterForTest()
    const hydration = deferred<{ pendingEndpoints: string[]; localInspectionPending: boolean }>()
    const enable = vi.fn()
    const disable = vi.fn()
    const applier = createPushNotificationSettingApplyDesiredState(enable, disable, {
      loadPendingCleanup: () => hydration.promise,
      savePendingCleanup: vi.fn(),
    })
    const pending = applier.apply(false)
    demoteAndRepromoteForTest()
    hydration.resolve({ pendingEndpoints: ['old'], localInspectionPending: true })
    await expect(pending).rejects.toThrow('client_write_operation_stale')
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })
})
