import { captureClientSessionGeneration } from '../clientSession'
import { isClientWriteOperationCurrent } from '../clientWriteOperation'
import { alertError, alertNormal, alertWait } from '../alert'
import { language } from '../../lang'
import {
  createServerBackup,
  exportServerBundle,
  exportServerLocalBackup,
  importServerBundle,
  type ServerBackupProgressCallback,
} from '../server/backups'

export type BackupProgressCallback = ServerBackupProgressCallback

export type BackupOperationStatus = 'ok' | 'error' | 'unavailable' | 'cancelled'

export interface BackupOperationOptions {
  signal?: AbortSignal | null
  onProgress?: BackupProgressCallback
}

export async function SaveServerBackup(options: BackupOperationOptions = {}): Promise<BackupOperationStatus> {
  if (!options.onProgress) alertWait('Saving server backup...')
  const result = await createServerBackup({
    label: 'Manual backup',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  })
  if (result.status === 'ok') {
    alertNormal('Server backup saved')
    return 'ok'
  } else if (result.status === 'error') {
    alertError(result.error)
    return 'error'
  }
  return 'unavailable'
}

/**
 * Save a complete backup to the user's device in the original Risu local
 * backup format. The bytes come from the server, not browser-local storage.
 */
export async function saveBackupToDevice(options: BackupOperationOptions = {}): Promise<BackupOperationStatus> {
  if (!options.onProgress) alertWait('Saving local backup...')
  const result = await exportServerLocalBackup(options)
  if (result.status === 'ok') {
    triggerBlobDownload(result.blob, result.filename)
    alertNormal('Local backup saved')
    return 'ok'
  } else if (result.status === 'error') {
    alertError(result.error)
    return 'error'
  }
  return 'unavailable'
}

/**
 * Save a complete backup (database + all referenced assets) to the user's
 * device using the newer `.risu.zip` bundle export.
 */
export async function saveZipBackupToDevice(options: BackupOperationOptions = {}): Promise<BackupOperationStatus> {
  if (!options.onProgress) alertWait('Saving ZIP-style local backup...')
  const result = await exportServerBundle(options)
  if (result.status === 'ok') {
    triggerBlobDownload(result.blob, result.filename)
    alertNormal('Local backup saved')
    return 'ok'
  } else if (result.status === 'error') {
    alertError(result.error)
    return 'error'
  }
  return 'unavailable'
}

/**
 * Restore a complete backup the user picks from their device. Both the new
 * `.risu.zip` bundle and the original app's `.bin` local backup are accepted;
 * the file is uploaded to the server, which registers the bundled assets and
 * replaces the database, after which the local projection refreshes.
 */
export async function loadBackupFromDevice(options: BackupOperationOptions = {}): Promise<BackupOperationStatus> {
  const operation = captureClientSessionGeneration()
  if (!isClientWriteOperationCurrent(operation)) return 'unavailable'
  const file = await selectBackupFile()
  if (!isClientWriteOperationCurrent(operation)) return 'unavailable'
  if (!file) return 'cancelled'

  if (!options.onProgress) alertWait('Loading local backup...')
  const result = await importServerBundle({
    file,
    filename: file.name,
    signal: options.signal,
    onProgress: options.onProgress,
  })
  if (!isClientWriteOperationCurrent(operation)) return 'unavailable'
  if (result.status === 'ok') {
    const hasAssetCaveats = result.assetReport.missingCount > 0 || result.assetReport.orphanedCount > 0
    const assetResult = hasAssetCaveats
      ? language.backupImportSuccessWithAssetCaveats(result.assetReport.missingCount, result.assetReport.orphanedCount)
      : language.backupImportSuccess
    const importResult =
      result.skippedBlocks.length > 0
        ? `${assetResult}\n\n${language.backupImportSkippedBlocks(
            result.skippedBlocks.map((block) => `${block.name} (${block.type})`),
          )}`
        : assetResult
    if (result.discardedPendingMutations > 0) {
      alertError(
        hasAssetCaveats || result.skippedBlocks.length > 0
          ? `${importResult}\n\n${language.backupQueuedChangesDiscarded}`
          : language.backupQueuedChangesDiscarded,
      )
    } else {
      alertNormal(importResult)
    }
    return 'ok'
  } else if (result.status === 'unsupported-chat-blocks') {
    alertError(language.backupUnsupportedStandaloneChatBlocks)
    return 'error'
  } else if (result.status === 'unsupported-groups') {
    alertError(
      language.backupUnsupportedGroups(
        result.count,
        result.groups.map((group) => group.name || group.id).filter((value): value is string => !!value),
      ),
    )
    return 'error'
  } else if (result.status === 'error') {
    alertError(
      result.discardedPendingMutations ? `${result.error}\n\n${language.backupQueuedChangesDiscarded}` : result.error,
    )
    return 'error'
  }
  return 'unavailable'
}

function selectBackupFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    let settled = false
    const settle = (file: File | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', handleFocus)
      input.remove()
      resolve(file)
    }
    const handleFocus = () => {
      window.setTimeout(() => {
        if (!input.files?.length) settle(null)
      }, 500)
    }

    input.type = 'file'
    input.accept = '.zip,.bin,application/zip,application/octet-stream'
    input.onchange = () => {
      settle(input.files?.[0] ?? null)
    }
    input.oncancel = () => {
      settle(null)
    }
    window.addEventListener('focus', handleFocus)
    input.click()
  })
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
