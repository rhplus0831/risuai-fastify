<script lang="ts">
  import { get } from 'svelte/store'
  import { language } from 'src/lang'

  import { alertClear, alertConfirm, alertError, alertProgress } from 'src/ts/alert'
  import { alertStore } from 'src/ts/stores.svelte'
  import { loadInternalBackup } from 'src/ts/globalApi.svelte'
  import {
    SaveServerBackup,
    loadBackupFromDevice,
    saveBackupToDevice,
    saveZipBackupToDevice,
    type BackupProgressCallback,
  } from 'src/ts/storage/backup'
  import Button from 'src/lib/UI/GUI/Button.svelte'
  import { exportAsDataset } from 'src/ts/storage/exportAsDataset'
  import type { ServerBackupProgress } from 'src/ts/server/backups'
  import StorageUsage from './StorageUsage.svelte'

  type BackupProgressKind = 'serverSave' | 'serverRestore' | 'localSave' | 'localZipSave' | 'localRestore'
  type OperationStatus = 'ok' | 'error' | 'unavailable' | 'cancelled'

  let activeBackupOperation = $state<BackupProgressKind | null>(null)

  async function runBackupOperation(
    kind: BackupProgressKind,
    initialMessage: string,
    action: (onProgress: BackupProgressCallback) => Promise<OperationStatus>,
  ) {
    if (activeBackupOperation !== null) return
    activeBackupOperation = kind
    alertProgress(initialMessage, 0)

    try {
      const status = await action(setBackupProgress)
      finishBackupProgress(status)
    } catch (err) {
      alertError(err)
    } finally {
      activeBackupOperation = null
    }
  }

  function setBackupProgress(progress: ServerBackupProgress) {
    // Server restore now needs a selection response. Retire this operation's
    // passive progress before the result-bearing dialog can take its place.
    if (activeBackupOperation === 'serverRestore' && progress.phase === 'prepare') {
      if (get(alertStore).type === 'progress') alertClear()
      return
    }
    alertProgress(
      progress.message,
      progress.percent === null ? null : Math.max(0, Math.min(100, progress.percent)),
      formatProgressDetail(progress) || undefined,
    )
  }

  function finishBackupProgress(status: OperationStatus) {
    if ((status === 'cancelled' || status === 'unavailable') && get(alertStore).type === 'progress') {
      alertClear()
    }
  }

  function formatProgressDetail(progress: ServerBackupProgress): string {
    if (typeof progress.loadedBytes !== 'number') return ''
    const loaded = formatBytes(progress.loadedBytes)
    if (typeof progress.totalBytes === 'number' && progress.totalBytes > 0) {
      const prefix = progress.estimatedTotalBytes ? '~' : ''
      return `${loaded} / ${prefix}${formatBytes(progress.totalBytes)}`
    }
    return loaded
  }

  function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024
      unitIndex += 1
    }
    return `${value < 10 && unitIndex > 0 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`
  }
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.backupRestore}</h2>

<StorageUsage />

<Button
  onclick={async () => {
    if (await alertConfirm(language.backupConfirm)) {
      await runBackupOperation('serverSave', 'Creating server backup', (onProgress) => SaveServerBackup({ onProgress }))
    }
  }}
  className="mt-2"
  disabled={activeBackupOperation !== null}>
  {language.saveServerBackup}
</Button>

<Button
  onclick={async () => {
    if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
      await runBackupOperation('serverRestore', 'Loading server backups', (onProgress) =>
        loadInternalBackup({ onProgress }),
      )
    }
  }}
  className="mt-2"
  disabled={activeBackupOperation !== null}>
  {language.loadServerBackup}
</Button>

<Button
  onclick={async () => {
    if (await alertConfirm(language.backupConfirm)) {
      await runBackupOperation('localSave', 'Saving local backup', (onProgress) => saveBackupToDevice({ onProgress }))
    }
  }}
  className="mt-2"
  disabled={activeBackupOperation !== null}>
  {language.saveBackupLocal}
</Button>

<Button
  onclick={async () => {
    if (await alertConfirm(language.portableSaveSecretsWarning)) {
      await runBackupOperation('localZipSave', 'Saving ZIP-style local backup', (onProgress) =>
        saveZipBackupToDevice({ onProgress }),
      )
    }
  }}
  className="mt-2"
  disabled={activeBackupOperation !== null}>
  {language.saveBackupLocalZipStyle}
</Button>

<Button
  onclick={async () => {
    if ((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))) {
      await runBackupOperation('localRestore', 'Waiting for local backup file', (onProgress) =>
        loadBackupFromDevice({ onProgress }),
      )
    }
  }}
  className="mt-2"
  disabled={activeBackupOperation !== null}>
  {language.loadBackupLocal}
</Button>

<Button onclick={exportAsDataset} className="mt-2">
  {language.exportAsDataset}
</Button>
