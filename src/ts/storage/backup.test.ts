import { resetClientSessionForTests } from '../clientSession'
import { setManagedWriterForTest, demoteAndRepromoteForTest } from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serverBackupState = vi.hoisted(() => ({
  createServerBackup: vi.fn(async () => ({ status: 'ok' as const, backup: { id: 'backup-a' } })),
  importServerBundle: vi.fn(),
}))
const alertState = vi.hoisted(() => ({
  alertError: vi.fn(),
  alertNormal: vi.fn(),
  alertWait: vi.fn(),
}))
vi.mock('../alert', () => ({
  alertError: alertState.alertError,
  alertNormal: alertState.alertNormal,
  alertWait: alertState.alertWait,
}))

vi.mock('../server/backups', () => ({
  createServerBackup: serverBackupState.createServerBackup,
  importServerBundle: serverBackupState.importServerBundle,
}))

import { language } from '../../lang'
import { loadBackupFromDevice, SaveServerBackup } from './backup'

const cleanAssetReport = { referencedCount: 2, missingCount: 0, orphanedCount: 0 }

function selectBackupFile() {
  const file = new File(['backup'], 'database.risu.zip', { type: 'application/zip' })
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
    Object.defineProperty(this, 'files', { configurable: true, value: [file] })
    this.onchange?.(new Event('change'))
  })
}

beforeEach(() => {
  resetClientSessionForTests()
  serverBackupState.createServerBackup.mockClear()
  serverBackupState.importServerBundle.mockReset()
  alertState.alertError.mockClear()
  alertState.alertNormal.mockClear()
  alertState.alertWait.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Fastify backup storage gates', () => {
  it('routes manual backup creation through the server backup API', async () => {
    await SaveServerBackup()

    expect(serverBackupState.createServerBackup).toHaveBeenCalledWith({ label: 'Manual backup' })
    expect(alertState.alertWait).toHaveBeenCalledWith('Saving server backup...')
    expect(alertState.alertNormal).toHaveBeenCalledWith('Server backup saved')
  })

  it.each(['ok', 'error'] as const)('does not publish a late %s alert after writer replacement', async (status) => {
    setManagedWriterForTest()
    selectBackupFile()
    let release!: (value: unknown) => void
    serverBackupState.importServerBundle.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const pending = loadBackupFromDevice()
    await vi.waitFor(() => expect(serverBackupState.importServerBundle).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release({
      status,
      error: 'old error',
      revision: 2,
      discardedPendingMutations: 0,
      assetReport: cleanAssetReport,
      skippedBlocks: [],
    })
    await pending
    expect(alertState.alertNormal).not.toHaveBeenCalled()
    expect(alertState.alertError).not.toHaveBeenCalled()
  })

  it('shows a localized success result for a clean import', async () => {
    selectBackupFile()
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'ok',
      revision: 2,
      discardedPendingMutations: 0,
      assetReport: cleanAssetReport,
      skippedBlocks: [],
    })

    await expect(loadBackupFromDevice()).resolves.toBe('ok')

    expect(alertState.alertNormal).toHaveBeenCalledOnce()
    expect(alertState.alertNormal).toHaveBeenCalledWith(language.backupImportSuccess)
    expect(alertState.alertError).not.toHaveBeenCalled()
  })

  it('qualifies a successful import when referenced assets are missing', async () => {
    selectBackupFile()
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'ok',
      revision: 2,
      discardedPendingMutations: 0,
      assetReport: { referencedCount: 2, missingCount: 1, orphanedCount: 0 },
      skippedBlocks: [],
    })

    await expect(loadBackupFromDevice()).resolves.toBe('ok')

    expect(alertState.alertNormal).toHaveBeenCalledOnce()
    expect(alertState.alertNormal).toHaveBeenCalledWith(language.backupImportSuccessWithAssetCaveats(1, 0))
    expect(alertState.alertError).not.toHaveBeenCalled()
  })

  it('qualifies a successful import when stored assets are orphaned', async () => {
    selectBackupFile()
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'ok',
      revision: 2,
      discardedPendingMutations: 0,
      assetReport: { referencedCount: 2, missingCount: 0, orphanedCount: 1 },
      skippedBlocks: [],
    })

    await expect(loadBackupFromDevice()).resolves.toBe('ok')

    expect(alertState.alertNormal).toHaveBeenCalledOnce()
    expect(alertState.alertNormal).toHaveBeenCalledWith(language.backupImportSuccessWithAssetCaveats(0, 1))
    expect(alertState.alertError).not.toHaveBeenCalled()
  })

  it('names every skipped standalone CHAT block after salvaging supported backup content', async () => {
    selectBackupFile()
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'ok',
      revision: 2,
      discardedPendingMutations: 0,
      assetReport: cleanAssetReport,
      skippedBlocks: [
        { name: 'chat/alice', type: 'CHAT' },
        { name: 'chat/bob', type: 'CHAT' },
      ],
    })

    await expect(loadBackupFromDevice()).resolves.toBe('ok')

    expect(alertState.alertNormal).toHaveBeenCalledWith(
      `${language.backupImportSuccess}\n\n${language.backupImportSkippedBlocks([
        'chat/alice (CHAT)',
        'chat/bob (CHAT)',
      ])}`,
    )
    expect(alertState.alertError).not.toHaveBeenCalled()
  })

  it('shows one restore warning when database replacement discards queued changes', async () => {
    selectBackupFile()
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'ok',
      revision: 2,
      discardedPendingMutations: 1,
      assetReport: cleanAssetReport,
      skippedBlocks: [],
    })

    await expect(loadBackupFromDevice()).resolves.toBe('ok')

    expect(alertState.alertError).toHaveBeenCalledOnce()
    expect(alertState.alertError).toHaveBeenCalledWith(language.backupQueuedChangesDiscarded)
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('shows the localized standalone-chat compatibility diagnostic', async () => {
    const file = new File(['backup'], 'database.risu.zip', { type: 'application/zip' })
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function () {
      Object.defineProperty(this, 'files', { configurable: true, value: [file] })
      this.onchange?.(new Event('change'))
    })
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'unsupported-chat-blocks',
      error: 'raw server fallback that the UI must not display',
    })

    await expect(loadBackupFromDevice()).resolves.toBe('error')

    expect(alertState.alertError).toHaveBeenCalledOnce()
    expect(alertState.alertError).toHaveBeenCalledWith(language.backupUnsupportedStandaloneChatBlocks)
    expect(alertState.alertError).not.toHaveBeenCalledWith('raw server fallback that the UI must not display')
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })

  it('keeps asset caveats in the warning when queued changes were also discarded', async () => {
    selectBackupFile()
    serverBackupState.importServerBundle.mockResolvedValue({
      status: 'ok',
      revision: 2,
      discardedPendingMutations: 1,
      assetReport: { referencedCount: 2, missingCount: 1, orphanedCount: 1 },
      skippedBlocks: [],
    })

    await expect(loadBackupFromDevice()).resolves.toBe('ok')

    expect(alertState.alertError).toHaveBeenCalledOnce()
    expect(alertState.alertError).toHaveBeenCalledWith(
      `${language.backupImportSuccessWithAssetCaveats(1, 1)}\n\n${language.backupQueuedChangesDiscarded}`,
    )
    expect(alertState.alertNormal).not.toHaveBeenCalled()
  })
})
