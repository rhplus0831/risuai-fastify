import { resetClientSessionForTests } from '../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../__tests__/managedClientSession'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => vi.fn(async () => 'auth-token'))
const getBaseRevision = vi.hoisted(() => vi.fn(async () => 7))
const setRevision = vi.hoisted(() => vi.fn())
const reconcileEvent = vi.hoisted(() => vi.fn(async () => {}))
const handleStaleWriter = vi.hoisted(() => vi.fn(() => false))

vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: auth }))

vi.mock('./activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-a' }),
  handleActiveWriterStaleResponse: handleStaleWriter,
}))

vi.mock('./commands', () => ({
  getServerCommandBaseRevision: getBaseRevision,
  setCachedServerCommandRevision: setRevision,
  withDirectServerCommandEventReconciliation: async (
    _matches: (event: unknown) => boolean,
    operation: (reconcile: typeof reconcileEvent) => Promise<unknown>,
  ) => operation(reconcileEvent),
}))

import { importLocalCharacterFileFromServer, importLocalModuleFileFromServer } from './localFileImport'

beforeEach(() => {
  resetClientSessionForTests()
  auth.mockClear()
  getBaseRevision.mockClear()
  setRevision.mockClear()
  reconcileEvent.mockClear()
  handleStaleWriter.mockClear()
  vi.unstubAllGlobals()
})

describe('local file import client', () => {
  it('reports upload bytes and split server frames before reconciling the terminal result', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeImportXhr)
    const onProgress = vi.fn()
    const importing = importLocalCharacterFileFromServer({
      file: new Blob(['card']),
      fileName: 'bot.charx',
      onProgress,
    })
    await vi.waitFor(() => expect(FakeImportXhr.latest).toBeDefined())
    const xhr = FakeImportXhr.latest!
    expect(xhr.headers).toMatchObject({
      accept: 'text/event-stream',
      'risu-auth': 'auth-token',
      'risu-writer-session': 'writer-a',
    })
    expect(xhr.body).toBeInstanceOf(FormData)
    xhr.upload.onprogress!({ loaded: 50, total: 100, lengthComputable: true })
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'upload', completedBytes: 50, totalBytes: 100 })
    xhr.upload.onload!()
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'processing' })
    xhr.receive('event: progress\ndata: {"phase":"rea')
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'processing' })
    xhr.receive('d"}\n\nevent: progress\ndata: {"phase":"assets","completedAssets":2}\n\n')
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'assets', completedAssets: 2 })
    expect(reconcileEvent).not.toHaveBeenCalled()
    const event = { type: 'character.created', resource: 'character', revision: 8, id: 'character-a' }
    xhr.receive(
      `event: result\ndata: ${JSON.stringify({ statusCode: 200, body: { revision: 8, event, characterId: 'character-a' } })}\n\n`,
    )
    xhr.onload!()
    await expect(importing).resolves.toMatchObject({ status: 'ok', characterId: 'character-a' })
    expect(onProgress).toHaveBeenLastCalledWith({ phase: 'refresh' })
    expect(reconcileEvent).toHaveBeenCalledWith(event)
  })

  it('keeps streamed challenges as challenges and sends confirmation as JSON', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeImportXhr)
    const importing = importLocalCharacterFileFromServer({
      pendingImportToken: 'pending',
      allowLowLevelAccess: true,
      onProgress: vi.fn(),
    })
    await vi.waitFor(() => expect(FakeImportXhr.latest).toBeDefined())
    const xhr = FakeImportXhr.latest!
    expect(JSON.parse(xhr.body as string)).toMatchObject({ pendingImportToken: 'pending', allowLowLevelAccess: true })
    expect(xhr.upload.onprogress).toBeUndefined()
    xhr.receive(
      'event: result\ndata: {"statusCode":409,"body":{"code":"character_password_required","pendingImportToken":"pending"}}\n\n',
    )
    xhr.onload!()
    await expect(importing).resolves.toEqual({ status: 'password-required', pendingImportToken: 'pending' })
    expect(reconcileEvent).not.toHaveBeenCalled()
  })

  it.each(['truncated', 'aborted', 'invalid'])('does not report success for a %s stream', async (failure) => {
    vi.stubGlobal('XMLHttpRequest', FakeImportXhr)
    const controller = new AbortController()
    const importing = importLocalCharacterFileFromServer({
      file: new Blob(['card']),
      signal: controller.signal,
      onProgress: vi.fn(),
    })
    await vi.waitFor(() => expect(FakeImportXhr.latest).toBeDefined())
    const xhr = FakeImportXhr.latest!
    if (failure === 'aborted') controller.abort()
    else {
      xhr.receive(
        failure === 'invalid'
          ? 'event: progress\ndata: {"phase":"invented"}\n\n'
          : 'event: progress\ndata: {"phase":"read"}\n\n',
      )
      xhr.onload!()
    }
    await expect(importing).resolves.toMatchObject({ status: 'error' })
    expect(reconcileEvent).not.toHaveBeenCalled()
  })

  it('preserves early JSON errors even when progress was requested', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeImportXhr)
    const importing = importLocalCharacterFileFromServer({ file: new Blob(['card']), onProgress: vi.fn() })
    await vi.waitFor(() => expect(FakeImportXhr.latest).toBeDefined())
    const xhr = FakeImportXhr.latest!
    xhr.contentType = 'application/json'
    xhr.status = 409
    xhr.responseText = JSON.stringify({ currentRevision: 12 })
    xhr.onload!()
    await expect(importing).resolves.toEqual({ status: 'conflict', currentRevision: 12 })
    expect(setRevision).toHaveBeenCalledWith(12)
  })

  it('sends one multipart character file and reconciles the server-created event', async () => {
    const event = { type: 'character.created', resource: 'character', revision: 8, id: 'character-a' }
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            revision: 8,
            event,
            characterId: 'character-a',
            importReport: { droppedArchiveEntries: [], droppedInlineAssets: [] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })

    await expect(importLocalCharacterFileFromServer({ file, fileName: 'bot.charx' })).resolves.toMatchObject({
      status: 'ok',
      characterId: 'character-a',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/import/character-card?baseRevision=7')
    expect(init.headers).toMatchObject({ 'risu-auth': 'auth-token', 'risu-writer-session': 'writer-a' })
    expect(init.headers).not.toHaveProperty('content-type')
    const form = init.body as FormData
    const uploaded = form.get('file') as File
    expect(uploaded.name).toBe('bot.charx')
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(setRevision).toHaveBeenCalledWith(8)
    expect(reconcileEvent).toHaveBeenCalledWith(event)
  })

  it('retries a challenged module with JSON metadata and no second file upload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 'low_level_access_confirmation_required',
            pendingImportToken: 'pending-token',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            revision: 8,
            event: { type: 'module.created', resource: 'moduleCreated', revision: 8, id: 'module-a' },
            moduleId: 'module-a',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const challenged = await importLocalModuleFileFromServer({
      file: new Blob([new Uint8Array([4, 5, 6])]),
      fileName: 'module.risum',
    })
    expect(challenged).toEqual({ status: 'low-level-access', pendingImportToken: 'pending-token' })

    await expect(
      importLocalModuleFileFromServer({ pendingImportToken: 'pending-token', allowLowLevelAccess: true }),
    ).resolves.toMatchObject({ status: 'ok', moduleId: 'module-a' })

    const [retryUrl, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(retryUrl).toBe('/api/v1/import/module')
    expect(retryInit.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(JSON.parse(String(retryInit.body))).toEqual({
      baseRevision: 7,
      pendingImportToken: 'pending-token',
      allowLowLevelAccess: true,
    })
  })
})

class FakeImportXhr {
  static latest: FakeImportXhr | undefined
  upload: {
    onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void
    onload?: () => void
  } = {}
  headers: Record<string, string> = {}
  body?: FormData | string
  responseText = ''
  status = 200
  contentType = 'text/event-stream'
  onprogress?: () => void
  onload?: () => void
  onabort?: () => void
  onerror?: () => void
  constructor() {
    FakeImportXhr.latest = this
  }
  open() {}
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value
  }
  getResponseHeader() {
    return this.contentType
  }
  getAllResponseHeaders() {
    return `content-type: ${this.contentType}`
  }
  send(body: FormData | string) {
    this.body = body
  }
  abort() {
    this.onabort?.()
  }
  receive(text: string) {
    this.responseText += text
    this.onprogress?.()
  }
}

beforeEach(() => {
  FakeImportXhr.latest = undefined
})

describe('local import writer lifecycle', () => {
  it('rejects Reader import before auth or transport', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(importLocalCharacterFileFromServer({ file: new Blob(['card']) })).resolves.toMatchObject({
      status: 'unavailable',
    })
    expect(auth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not resume import after authentication in a newer writer session', async () => {
    setManagedWriterForTest()
    let release!: (value: string) => void
    auth.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const pending = importLocalCharacterFileFromServer({ file: new Blob(['card']) })
    await vi.waitFor(() => expect(auth).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release('auth')
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns exact accepted import without stale progress, revision, or reconciliation', async () => {
    setManagedWriterForTest()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = importLocalCharacterFileFromServer({ file: new Blob(['card']) })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    release(
      new Response(
        JSON.stringify({
          revision: 8,
          event: { type: 'character.created', resource: 'character', revision: 8, id: 'character-a' },
          characterId: 'character-a',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    await expect(pending).resolves.toMatchObject({ status: 'ok', characterId: 'character-a' })
    expect(setRevision).not.toHaveBeenCalled()
    expect(reconcileEvent).not.toHaveBeenCalled()
  })
})
