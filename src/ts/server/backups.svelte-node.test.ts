import { resetClientSessionForTests, canUseClientWriteAccess } from '../clientSession'
import {
  setManagedReaderForTest,
  setManagedWriterForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resourceRefreshSpies = vi.hoisted(() => ({
  forceServerDatabaseReplacementRefresh: vi.fn(),
}))
const ownershipSpies = vi.hoisted(() => ({
  preparePendingMutationOutbox: vi.fn(),
  markReplacementDatabaseOwnershipRefreshed: vi.fn(),
}))
const ownerResetSpies = vi.hoisted(() => ({
  resetRegisteredOwnerState: vi.fn(),
}))
const settlementSpies = vi.hoisted(() => ({
  countRegisteredDurableMutationSettlements: vi.fn(() => 0),
  discardRegisteredDurableMutationSettlements: vi.fn(),
}))

vi.mock('./resourceRefresh', () => ({
  forceServerDatabaseReplacementRefresh: resourceRefreshSpies.forceServerDatabaseReplacementRefresh,
}))

vi.mock('./pendingMutationOutbox', () => ({
  preparePendingMutationOutbox: ownershipSpies.preparePendingMutationOutbox,
}))

vi.mock('./replacementDatabaseOwnership', async (importActual) => {
  const actual = await importActual<typeof import('./replacementDatabaseOwnership')>()
  return {
    ...actual,
    markReplacementDatabaseOwnershipRefreshed: ownershipSpies.markReplacementDatabaseOwnershipRefreshed,
  }
})

vi.mock('./pendingOwnerMutationRegistry', () => ({
  resetRegisteredOwnerState: ownerResetSpies.resetRegisteredOwnerState,
}))

vi.mock('../process/legacyMemoryMigrationNotice', () => ({
  showLegacyMemoryMigrationNoticeIfNeeded: vi.fn(),
}))

vi.mock('./durableMutationDispatch', () => ({
  countRegisteredDurableMutationSettlements: settlementSpies.countRegisteredDurableMutationSettlements,
  discardRegisteredDurableMutationSettlements: settlementSpies.discardRegisteredDurableMutationSettlements,
}))

vi.mock('../platform', () => ({ isFastifyServer: true }))

const backupAuthMocks = vi.hoisted(() => ({ auth: vi.fn(async () => 'backup-auth-token') }))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: backupAuthMocks.auth }))

vi.mock('../process/modules', () => ({
  getModuleLorebooks: vi.fn(() => []),
  getModules: vi.fn(() => []),
  moduleUpdate: vi.fn(),
}))

import {
  createServerBackup,
  deleteServerBackup,
  exportServerBundle,
  exportServerLocalBackup,
  importServerBundle,
  listServerBackups,
  restoreServerBackup,
  type ServerBackupProgress,
} from './backups'
import { clearCachedServerCommandRevision, peekCachedServerCommandRevision } from './commands'

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  contentType: string | null
  body: unknown
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function makeBackupFetch(bodyForUrl: (url: string, init: RequestInit) => unknown): {
  calls: CapturedFetch[]
  fetch: typeof fetch
} {
  const calls: CapturedFetch[] = []
  return {
    calls,
    fetch: vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        contentType: headers?.['content-type'] ?? null,
        body,
      })
      const responseBody = bodyForUrl(url, init)
      return responseBody instanceof Response ? responseBody : jsonResponse(responseBody)
    }) as unknown as typeof fetch,
  }
}

const backupManifest = {
  _version: 1,
  id: '2026-05-26-01-02-03-abcdef',
  label: 'manual',
  createdAt: '2026-05-26T01:02:03.000Z',
  revision: 7,
  assetCount: 2,
}
const replacementOwnership = { databaseLineage: 'database-restored', writerEpoch: 4 }
const cleanAssetReport = { referencedCount: 1, missingCount: 0, orphanedCount: 0 }

beforeEach(() => {
  clearCachedServerCommandRevision()
  resourceRefreshSpies.forceServerDatabaseReplacementRefresh.mockReset()
  resourceRefreshSpies.forceServerDatabaseReplacementRefresh.mockResolvedValue({ status: 'ok', revision: 12 })
  ownershipSpies.preparePendingMutationOutbox.mockReset()
  ownershipSpies.preparePendingMutationOutbox.mockImplementation(async (input) => {
    input.onOwnershipChange?.()
    return { discarded: 0 }
  })
  ownershipSpies.markReplacementDatabaseOwnershipRefreshed.mockReset()
  ownerResetSpies.resetRegisteredOwnerState.mockReset()
  settlementSpies.countRegisteredDurableMutationSettlements.mockClear()
  settlementSpies.discardRegisteredDurableMutationSettlements.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server backup helpers', () => {
  it('creates and lists backups with auth headers', async () => {
    const backupFetch = makeBackupFetch((url, init) => {
      if (url === '/api/v1/backups' && init.method === 'GET') return { backups: [backupManifest] }
      return backupManifest
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(createServerBackup({ label: 'manual' })).resolves.toEqual({
      status: 'ok',
      backup: backupManifest,
    })
    await expect(listServerBackups()).resolves.toEqual({
      status: 'ok',
      backups: [backupManifest],
    })

    expect(backupFetch.calls).toEqual([
      {
        url: '/api/v1/backups',
        method: 'POST',
        authHeader: 'backup-auth-token',
        contentType: 'application/json',
        body: { label: 'manual' },
      },
      {
        url: '/api/v1/backups',
        method: 'GET',
        authHeader: 'backup-auth-token',
        contentType: null,
        body: null,
      },
    ])
  })

  it('restores backups and refreshes API-backed resources', async () => {
    ownershipSpies.preparePendingMutationOutbox.mockImplementationOnce(async (input) => {
      input.onOwnershipChange?.()
      return { discarded: 2 }
    })
    const event = { type: 'state.restored', resource: 'state', revision: 12 }
    const backupFetch = makeBackupFetch((url) => {
      if (url === '/api/v1/backups/2026-05-26-01-02-03-abcdef/restore') {
        return { revision: 12, event, ...replacementOwnership }
      }
      return { revision: 13, database: { characters: [], modules: [], personas: [] } }
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(restoreServerBackup({ id: backupManifest.id })).resolves.toEqual({
      status: 'ok',
      revision: 12,
      discardedPendingMutations: 2,
      event,
    })
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).toHaveBeenCalledWith('backup-restore')
    expect(ownershipSpies.preparePendingMutationOutbox).toHaveBeenCalledWith({
      writerSessionId: expect.any(String),
      requestedWriterWasActive: true,
      onOwnershipChange: expect.any(Function),
      ...replacementOwnership,
    })
    expect(ownerResetSpies.resetRegisteredOwnerState).toHaveBeenCalledOnce()
    expect(ownershipSpies.markReplacementDatabaseOwnershipRefreshed).not.toHaveBeenCalled()
    expect(backupFetch.calls).toHaveLength(1)
    expect(backupFetch.calls[0]).toMatchObject({
      url: '/api/v1/backups/2026-05-26-01-02-03-abcdef/restore',
      method: 'POST',
      authHeader: 'backup-auth-token',
    })
  })

  it('retires old owner state before asynchronous ownership preparation finishes', async () => {
    const preparation = deferred<{ discarded: number }>()
    const order: string[] = []
    ownerResetSpies.resetRegisteredOwnerState.mockImplementationOnce(() => {
      order.push('reset')
    })
    ownershipSpies.preparePendingMutationOutbox.mockImplementationOnce((input) => {
      order.push('prepare')
      input.onOwnershipChange?.()
      return preparation.promise
    })
    const backupFetch = makeBackupFetch(() => ({
      revision: 12,
      event: { type: 'state.restored', resource: 'state', revision: 12 },
      ...replacementOwnership,
    }))
    vi.stubGlobal('fetch', backupFetch.fetch)

    const restoring = restoreServerBackup({ id: backupManifest.id })
    await vi.waitFor(() => expect(order).toEqual(['prepare', 'reset']))
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).not.toHaveBeenCalled()

    preparation.resolve({ discarded: 0 })
    await expect(restoring).resolves.toMatchObject({ status: 'ok', revision: 12 })
  })

  it('reports a failed resource refresh after the server restore succeeds', async () => {
    resourceRefreshSpies.forceServerDatabaseReplacementRefresh.mockResolvedValueOnce({
      status: 'error',
      error: 'settings failed',
    })
    const backupFetch = makeBackupFetch((url) => {
      if (url === '/api/v1/backups/2026-05-26-01-02-03-abcdef/restore') {
        return {
          revision: 12,
          event: { type: 'state.restored', resource: 'state', revision: 12 },
          ...replacementOwnership,
        }
      }
      return { revision: 13 }
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(restoreServerBackup({ id: backupManifest.id })).resolves.toEqual({
      status: 'error',
      error: 'Backup restored, but resource refresh failed: settings failed',
    })
    expect(peekCachedServerCommandRevision()).toBeNull()
  })

  it('deletes backups and reports server errors', async () => {
    const backupFetch = makeBackupFetch((url) => {
      if (url.endsWith('/missing')) return jsonResponse({ error: 'Backup not found' }, 404)
      return { id: backupManifest.id }
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(deleteServerBackup({ id: backupManifest.id })).resolves.toEqual({
      status: 'ok',
      id: backupManifest.id,
    })
    await expect(deleteServerBackup({ id: 'missing' })).resolves.toEqual({
      status: 'error',
      error: 'Backup not found',
    })
  })
})

describe('device backup helpers (Save/Load Backup Locally)', () => {
  const BUNDLE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])
  const LOCAL_BACKUP_BYTES = new Uint8Array([1, 0, 0, 0, 120, 0, 0, 0, 0])

  it('downloads the original Risu local backup bytes with an auth header', async () => {
    const backupFetch = makeBackupFetch(
      () =>
        new Response(LOCAL_BACKUP_BYTES, {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="database.bin"' },
        }),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)

    const result = await exportServerLocalBackup()
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filename).toBe('database.bin')
      expect(result.blob).toBeInstanceOf(Blob)
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(LOCAL_BACKUP_BYTES)
    }
    expect(backupFetch.calls).toEqual([
      {
        url: '/api/v1/export/local-backup',
        method: 'GET',
        authHeader: 'backup-auth-token',
        contentType: null,
        body: null,
      },
    ])
  })

  it('downloads the bundle bytes with an auth header and content-disposition filename', async () => {
    const backupFetch = makeBackupFetch(
      () =>
        new Response(BUNDLE_BYTES, {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="database.risu.zip"' },
        }),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)

    const result = await exportServerBundle()
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.filename).toBe('database.risu.zip')
      expect(result.blob).toBeInstanceOf(Blob)
      expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(BUNDLE_BYTES)
    }
    expect(backupFetch.calls).toEqual([
      {
        url: '/api/v1/export/bundle',
        method: 'GET',
        authHeader: 'backup-auth-token',
        contentType: null,
        body: null,
      },
    ])
  })

  it('reports streamed download progress for local backup exports', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BUNDLE_BYTES.slice(0, 4))
        controller.enqueue(BUNDLE_BYTES.slice(4))
        controller.close()
      },
    })
    const backupFetch = makeBackupFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="database.risu.zip"',
            'content-length': String(BUNDLE_BYTES.byteLength),
          },
        }),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)
    const progress: ServerBackupProgress[] = []

    const result = await exportServerBundle({ onProgress: (frame) => progress.push(frame) })

    expect(result.status).toBe('ok')
    expect(progress[0]).toMatchObject({
      phase: 'request',
      message: 'Requesting backup export',
      percent: 5,
    })
    expect(
      progress.some(
        (frame) =>
          frame.phase === 'download' &&
          frame.loadedBytes === 4 &&
          frame.totalBytes === BUNDLE_BYTES.byteLength &&
          frame.percent === 52.5,
      ),
    ).toBe(true)
    expect(progress.at(-1)).toMatchObject({
      phase: 'complete',
      percent: 100,
      loadedBytes: BUNDLE_BYTES.byteLength,
      totalBytes: BUNDLE_BYTES.byteLength,
    })
  })

  it('uses the server-estimated backup size for streamed download progress without content-length', async () => {
    const estimatedBackupBytes = BUNDLE_BYTES.byteLength * 2
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BUNDLE_BYTES.slice(0, 4))
        controller.enqueue(BUNDLE_BYTES.slice(4))
        controller.close()
      },
    })
    const backupFetch = makeBackupFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: {
            'content-disposition': 'attachment; filename="database.risu.zip"',
            'x-risu-estimated-backup-bytes': String(estimatedBackupBytes),
          },
        }),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)
    const progress: ServerBackupProgress[] = []

    const result = await exportServerBundle({ onProgress: (frame) => progress.push(frame) })

    expect(result.status).toBe('ok')
    expect(
      progress.filter((frame) => frame.phase === 'download').every((frame) => typeof frame.percent === 'number'),
    ).toBe(true)
    expect(
      progress.some(
        (frame) =>
          frame.phase === 'download' &&
          frame.loadedBytes === 4 &&
          frame.totalBytes === estimatedBackupBytes &&
          frame.estimatedTotalBytes === true &&
          frame.percent === 31.25,
      ),
    ).toBe(true)
    expect(progress.at(-1)).toMatchObject({
      phase: 'complete',
      percent: 100,
      loadedBytes: BUNDLE_BYTES.byteLength,
      totalBytes: BUNDLE_BYTES.byteLength,
    })
  })

  it('reports server errors when the bundle export fails', async () => {
    const backupFetch = makeBackupFetch(() => jsonResponse({ error: 'database payload missing' }, 400))
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(exportServerBundle()).resolves.toEqual({
      status: 'error',
      error: 'database payload missing',
    })
  })

  it('returns a structured error when a successful backup response breaks while streaming', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection interrupted'))
      },
    })
    const backupFetch = makeBackupFetch(
      () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-length': String(BUNDLE_BYTES.byteLength) },
        }),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(exportServerBundle({ onProgress: vi.fn() })).resolves.toEqual({
      status: 'error',
      error: expect.stringContaining('connection interrupted'),
    })
  })

  it('uploads a bundle file, restores it, and refreshes API-backed resources', async () => {
    const event = { type: 'state.imported', resource: 'state', revision: 21 }
    const backupFetch = makeBackupFetch((url) => {
      if (url === '/api/v1/import/bundle') {
        return {
          revision: 21,
          event,
          assetReport: cleanAssetReport,
          importReport: { skippedBlocks: [{ name: 'standalone-chat', type: 'CHAT' }] },
          ...replacementOwnership,
        }
      }
      return { revision: 22 }
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    const file = new Blob([BUNDLE_BYTES], { type: 'application/zip' })
    await expect(importServerBundle({ file, filename: 'database.risu.zip' })).resolves.toEqual({
      status: 'ok',
      revision: 21,
      discardedPendingMutations: 0,
      event,
      assetReport: cleanAssetReport,
      skippedBlocks: [{ name: 'standalone-chat', type: 'CHAT' }],
    })
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).toHaveBeenCalledWith('bundle-restore')
    expect(ownershipSpies.preparePendingMutationOutbox).toHaveBeenCalledWith({
      writerSessionId: expect.any(String),
      requestedWriterWasActive: true,
      onOwnershipChange: expect.any(Function),
      ...replacementOwnership,
    })
    expect(ownerResetSpies.resetRegisteredOwnerState).toHaveBeenCalledOnce()
    expect(ownershipSpies.markReplacementDatabaseOwnershipRefreshed).not.toHaveBeenCalled()
    expect(backupFetch.calls).toHaveLength(1)
    // The upload carries auth but no explicit content-type (the browser sets the
    // multipart boundary for the FormData body).
    expect(backupFetch.calls[0]).toMatchObject({
      url: '/api/v1/import/bundle',
      method: 'POST',
      authHeader: 'backup-auth-token',
      contentType: null,
    })
  })

  it('preserves missing-reference and orphaned-asset counts from the import response', async () => {
    const assetReport = { referencedCount: 3, missingCount: 1, orphanedCount: 2 }
    const backupFetch = makeBackupFetch((url) => {
      if (url === '/api/v1/import/bundle') {
        return { revision: 21, assetReport, ...replacementOwnership }
      }
      return { revision: 22 }
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(importServerBundle({ file: new Blob([BUNDLE_BYTES]) })).resolves.toEqual({
      status: 'ok',
      revision: 21,
      discardedPendingMutations: 0,
      assetReport,
      skippedBlocks: [],
    })
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).toHaveBeenCalledWith('bundle-restore')
  })

  it('returns the structured unsupported-group report without adopting or refreshing', async () => {
    const backupFetch = makeBackupFetch(() =>
      jsonResponse(
        {
          code: 'unsupported-group-characters',
          error: 'This backup contains 1 unsupported group character. The active database was not changed.',
          unsupportedGroupCount: 1,
          unsupportedGroups: [{ id: 'legacy-group-a', name: 'Legacy Party' }],
        },
        422,
      ),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(importServerBundle({ file: new Blob([BUNDLE_BYTES]) })).resolves.toEqual({
      status: 'unsupported-groups',
      count: 1,
      groups: [{ id: 'legacy-group-a', name: 'Legacy Party' }],
      error: 'This backup contains 1 unsupported group character. The active database was not changed.',
    })
    expect(ownershipSpies.preparePendingMutationOutbox).not.toHaveBeenCalled()
    expect(ownerResetSpies.resetRegisteredOwnerState).not.toHaveBeenCalled()
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).not.toHaveBeenCalled()
  })

  it('returns the standalone-chat compatibility error without adopting or refreshing', async () => {
    const backupFetch = makeBackupFetch(() =>
      jsonResponse(
        {
          code: 'unsupported-standalone-chat-blocks',
          error: 'raw server fallback that the UI must not display',
        },
        422,
      ),
    )
    vi.stubGlobal('fetch', backupFetch.fetch)

    await expect(importServerBundle({ file: new Blob([BUNDLE_BYTES]) })).resolves.toEqual({
      status: 'unsupported-chat-blocks',
      error: 'raw server fallback that the UI must not display',
    })
    expect(ownershipSpies.preparePendingMutationOutbox).not.toHaveBeenCalled()
    expect(ownerResetSpies.resetRegisteredOwnerState).not.toHaveBeenCalled()
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).not.toHaveBeenCalled()
  })

  it('reports upload progress when restoring a device backup with progress enabled', async () => {
    const event = { type: 'state.imported', resource: 'state', revision: 21 }
    class FakeXMLHttpRequest {
      static instances: FakeXMLHttpRequest[] = []

      upload = {
        onprogress: null as ((event: ProgressEvent) => void) | null,
      }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      method = ''
      url = ''
      headers: Record<string, string> = {}
      body: unknown = null
      status = 200
      statusText = 'OK'
      responseText = JSON.stringify({ revision: 21, event, assetReport: cleanAssetReport, ...replacementOwnership })

      constructor() {
        FakeXMLHttpRequest.instances.push(this)
      }

      open(method: string, url: string) {
        this.method = method
        this.url = url
      }

      setRequestHeader(key: string, value: string) {
        this.headers[key] = value
      }

      getAllResponseHeaders() {
        return 'content-type: application/json\r\n'
      }

      send(body: unknown) {
        this.body = body
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 1,
          total: 4,
        } as ProgressEvent)
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 4,
          total: 4,
        } as ProgressEvent)
        this.onload?.()
      }

      abort() {
        this.onabort?.()
      }
    }
    const backupFetch = makeBackupFetch(() => ({ revision: 22 }))
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
    vi.stubGlobal('fetch', backupFetch.fetch)
    const file = new Blob([BUNDLE_BYTES], { type: 'application/zip' })
    const progress: ServerBackupProgress[] = []

    await expect(
      importServerBundle({
        file,
        filename: 'database.risu.zip',
        onProgress: (frame) => progress.push(frame),
      }),
    ).resolves.toEqual({
      status: 'ok',
      revision: 21,
      discardedPendingMutations: 0,
      event,
      assetReport: cleanAssetReport,
      skippedBlocks: [],
    })

    expect(FakeXMLHttpRequest.instances).toHaveLength(1)
    expect(FakeXMLHttpRequest.instances[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/import/bundle',
      headers: expect.objectContaining({ 'risu-auth': 'backup-auth-token' }),
    })
    expect(
      progress.some(
        (frame) =>
          frame.phase === 'upload' && frame.loadedBytes === 1 && frame.totalBytes === 4 && frame.percent === 22.5,
      ),
    ).toBe(true)
    expect(progress.some((frame) => frame.phase === 'process' && frame.percent === 80)).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'complete', percent: 100 })
    expect(backupFetch.calls).toHaveLength(0)
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).toHaveBeenCalledWith('bundle-restore')
  })

  it('reports a failed resource refresh after the bundle import succeeds', async () => {
    resourceRefreshSpies.forceServerDatabaseReplacementRefresh.mockResolvedValueOnce({
      status: 'error',
      error: 'collections failed',
    })
    const backupFetch = makeBackupFetch((url) => {
      if (url === '/api/v1/import/bundle') {
        return {
          revision: 21,
          event: { type: 'state.imported', resource: 'state', revision: 21 },
          assetReport: cleanAssetReport,
          ...replacementOwnership,
        }
      }
      return { revision: 22 }
    })
    vi.stubGlobal('fetch', backupFetch.fetch)

    const file = new Blob([BUNDLE_BYTES], { type: 'application/zip' })
    await expect(importServerBundle({ file })).resolves.toEqual({
      status: 'error',
      error: 'Backup imported, but resource refresh failed: collections failed',
    })
    expect(peekCachedServerCommandRevision()).toBeNull()
  })
})

// Each case starts on the conservative path unless it explicitly manages a session.
beforeEach(() => resetClientSessionForTests())

describe('backup writer admission', () => {
  it('denies reader mutations while preserving list and both exports', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/v1/backups' ? Response.json({ backups: [] }) : new Response('backup'),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(createServerBackup()).resolves.toEqual({ status: 'unavailable' })
    await expect(deleteServerBackup({ id: 'backup' })).resolves.toEqual({ status: 'unavailable' })
    await expect(restoreServerBackup({ id: 'backup' })).resolves.toEqual({ status: 'unavailable' })
    await expect(importServerBundle({ file: new Blob(['backup']) })).resolves.toEqual({ status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(listServerBackups()).resolves.toEqual({ status: 'ok', backups: [] })
    expect((await exportServerBundle()).status).toBe('ok')
    expect((await exportServerLocalBackup()).status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps a backup held at authentication unsent across repromotion', async () => {
    setManagedWriterForTest()
    const auth = deferred<string>()
    backupAuthMocks.auth.mockReturnValueOnce(auth.promise)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const pending = createServerBackup()
    demoteAndRepromoteForTest()
    auth.resolve('old-auth')
    await expect(pending).resolves.toEqual({ status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retains confirmed restoration identity without adopting a stale response', async () => {
    setManagedWriterForTest()
    const result = deferred<Response>()
    const fetchMock = vi.fn(() => result.promise)
    vi.stubGlobal('fetch', fetchMock)
    const pending = restoreServerBackup({ id: 'backup' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    const event = { type: 'database.replaced', resource: 'database', revision: 20 }
    result.resolve(Response.json({ revision: 20, event, ...replacementOwnership }))
    await expect(pending).resolves.toEqual({ status: 'ok', revision: 20, event, discardedPendingMutations: 0 })
    expect(ownershipSpies.preparePendingMutationOutbox).not.toHaveBeenCalled()
    expect(resourceRefreshSpies.forceServerDatabaseReplacementRefresh).not.toHaveBeenCalled()
    expect(ownerResetSpies.resetRegisteredOwnerState).not.toHaveBeenCalled()
    expect(canUseClientWriteAccess()).toBe(true)
  })

  it('does not demote the new writer for an old backup stale response', async () => {
    setManagedWriterForTest()
    const result = deferred<Response>()
    const fetchMock = vi.fn(() => result.promise)
    vi.stubGlobal('fetch', fetchMock)
    const pending = createServerBackup()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    result.resolve(Response.json({ error: 'active_writer_stale' }, { status: 423 }))
    await expect(pending).resolves.toMatchObject({ status: 'error', error: 'active_writer_stale' })
    expect(canUseClientWriteAccess()).toBe(true)
  })
})
