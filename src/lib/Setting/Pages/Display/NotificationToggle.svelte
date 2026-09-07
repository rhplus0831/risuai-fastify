<script lang="ts">
  import { onMount } from 'svelte'
  import { canUseClientWriteAccess, clientSessionStore } from 'src/ts/clientSession'
  import { language } from 'src/lang'
  import {
    pushNotificationWarningDismissed,
    setPushNotificationWarningDismissed,
  } from 'src/ts/gui/pushNotificationWarningPreference'
  import { settingsResourceState } from 'src/ts/server/resourceState.svelte'
  import Check from 'src/lib/UI/GUI/CheckInput.svelte'
  import { applyServerBackedSetting } from 'src/ts/server/settingsOwner.svelte'
  import {
    initializePushNotificationCoordinator,
    pushNotificationCoordinatorState,
    reconcileChatCompletionPushNotificationSetting,
    retryChatCompletionPushNotificationCleanup,
    retryChatCompletionPushNotificationSetup,
    retryChatCompletionPushNotificationStorage,
    type PushNotificationCoordinatorPhase,
  } from 'src/ts/server/pushNotificationSetting'
  import PushNotificationWarning from 'src/lib/Others/PushNotificationWarning.svelte'
  import type { DisablePushNotificationCleanupStep } from 'src/ts/server/pushNotifications'

  let displaySettings = $derived(
    settingsResourceState.groupStatuses.display === 'ready' ? settingsResourceState.value : undefined,
  )
  let notificationChecked = $state(false)
  let canWrite = $derived.by(() => {
    $clientSessionStore
    return canUseClientWriteAccess()
  })

  onMount(() => {
    void initializePushNotificationCoordinator()
  })

  $effect(() => {
    notificationChecked = displaySettings?.notification === true
  })

  function cleanupFailureMessage(step: DisablePushNotificationCleanupStep): string {
    switch (step) {
      case 'service-worker':
        return language.pushNotifications.cleanupFailures.serviceWorker
      case 'subscription-inspection':
        return language.pushNotifications.cleanupFailures.subscriptionInspection
      case 'local-unsubscribe':
        return language.pushNotifications.cleanupFailures.localUnsubscribe
      case 'server-deletion':
        return language.pushNotifications.cleanupFailures.serverDeletion
    }
  }

  function operationMessage(phase: PushNotificationCoordinatorPhase): string {
    switch (phase) {
      case 'hydrating':
        return language.pushNotifications.hydrating
      case 'startup-cleanup':
        return language.pushNotifications.startupCleanup
      case 'enabling':
        return language.pushNotifications.enabling
      case 'retrying-storage':
        return language.pushNotifications.retryingStorage
      case 'retrying-cleanup':
        return language.pushNotifications.retryingCleanup
      case 'disabling':
        return language.pushNotifications.disabling
      case 'idle':
        return ''
    }
  }

  function cleanupFailureMessages(): string[] {
    const cleanup = $pushNotificationCoordinatorState.cleanup
    if (cleanup?.status !== 'partial') return []
    return [
      ...new Set(
        cleanup.failures.length
          ? cleanup.failures.map(({ step }) => cleanupFailureMessage(step))
          : [language.pushNotifications.cleanupFailures.unexpected],
      ),
    ]
  }
</script>

<div class="mt-2">
  <Check
    bind:check={notificationChecked}
    disabled={!displaySettings || !canWrite}
    name={language.notification}
    onChange={(nextValue) => {
      if (!canUseClientWriteAccess()) return
      applyServerBackedSetting('notification', nextValue)
      void reconcileChatCompletionPushNotificationSetting(nextValue, { requestPermission: nextValue })
    }} />

  {#if notificationChecked || $pushNotificationWarningDismissed}
    <div class="mt-2">
      <Check
        check={!$pushNotificationWarningDismissed}
        name={language.pushNotifications.showBannerOnBrowser}
        onChange={(show) => setPushNotificationWarningDismissed(!show)} />
    </div>
  {/if}

  {#if $pushNotificationCoordinatorState.phase !== 'idle'}
    <p class="mt-1 text-sm text-textcolor2" role="status" aria-live="polite">
      {operationMessage($pushNotificationCoordinatorState.phase)}
    </p>
  {/if}

  <PushNotificationWarning />

  {#if $pushNotificationCoordinatorState.cleanup?.status === 'partial' || $pushNotificationCoordinatorState.pendingEndpoints.length > 0 || $pushNotificationCoordinatorState.localInspectionPending || $pushNotificationCoordinatorState.retryStorageError}
    <div class="mt-2 text-sm text-red-400" role="alert">
      {#each cleanupFailureMessages() as message}
        <p>{message}</p>
      {/each}
      {#if $pushNotificationCoordinatorState.pendingEndpoints.length > 0}
        <p>{language.pushNotifications.pendingCleanup($pushNotificationCoordinatorState.pendingEndpoints.length)}</p>
      {/if}
      {#if $pushNotificationCoordinatorState.localInspectionPending}
        <p>{language.pushNotifications.localInspectionPending}</p>
      {/if}
      {#if $pushNotificationCoordinatorState.retryStorageError}
        <p>{language.pushNotifications.cleanupRetryStorageFailed}</p>
        <button
          type="button"
          class="mt-1 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 text-textcolor disabled:opacity-60"
          disabled={!canWrite || $pushNotificationCoordinatorState.phase !== 'idle'}
          onclick={() => void retryChatCompletionPushNotificationStorage()}>
          {language.pushNotifications.retryStorage}
        </button>
      {/if}
      {#if $pushNotificationCoordinatorState.cleanup?.status === 'partial' || $pushNotificationCoordinatorState.pendingEndpoints.length > 0 || $pushNotificationCoordinatorState.localInspectionPending}
        <button
          type="button"
          class="mt-1 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 text-textcolor disabled:opacity-60"
          disabled={!canWrite || $pushNotificationCoordinatorState.phase !== 'idle' || notificationChecked}
          onclick={() => void retryChatCompletionPushNotificationCleanup()}>
          {language.pushNotifications.retryCleanup}
        </button>
      {/if}
    </div>
  {/if}

  {#if $pushNotificationCoordinatorState.operationError && !$pushNotificationCoordinatorState.desiredEnabled}
    <div class="mt-2 text-sm text-red-400" role="alert">
      <p>{language.pushNotifications.operationFailed}</p>
      <button
        type="button"
        class="mt-1 rounded-md border border-darkborderc bg-darkbutton px-2 py-1 text-textcolor disabled:opacity-60"
        disabled={!canWrite || $pushNotificationCoordinatorState.phase !== 'idle'}
        onclick={() =>
          void (notificationChecked
            ? retryChatCompletionPushNotificationSetup()
            : retryChatCompletionPushNotificationCleanup())}>
        {language.pushNotifications.retryOperation}
      </button>
    </div>
  {/if}
</div>
