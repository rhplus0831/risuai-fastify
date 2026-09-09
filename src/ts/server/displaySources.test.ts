import { get } from 'svelte/store'
import {
  beginClientSession,
  settleClientReader,
  setClientConnectionState,
  setClientProjectionReady,
  authorizeClientWriterRecovery,
  completeClientWriterRecovery,
  demoteClientSession,
  resetClientSessionForTests,
} from '../clientSession'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../sha256Fallback'
import { pluginV2 } from '../plugins/plugins.svelte'
import {
  clearCachedServerCommandRevision,
  peekCachedServerCommandRevision,
  runServerCommand,
  runExternalServerRevisionOperation,
  selectCharacterCommand,
  setCachedServerCommandRevision,
} from './commands'
import { resetWriterAccessLostForTests } from './activeWriterSession'
import { displaySourceNamespaceJson } from '@risuai/protocol/display-source'
import { reloadRegexDisplay, resetRegexDisplayReloadForTests } from '../process/regexDisplayReload'
import { charactersResourceState, resetServerResourceState } from './resourceState.svelte'
import {
  activateDisplaySourceChat,
  setNearestDisplaySourceMessages,
  captureDisplaySourceRenderEpoch,
  markReaderDisplayLimited,
  readerDisplayLimitedStore,
  configureDisplaySourceProtocol,
  requestServerDisplaySource,
  resetDisplaySourceClientForTests,
} from './displaySources'

const pluginRuntime = vi.hoisted(() => ({ ready: true }))

vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: vi.fn(async () => 'display-auth') }))
vi.mock('../plugins/plugins.svelte', () => ({
  isPluginRuntimeReady: () => pluginRuntime.ready,
  pluginV2: { editdisplay: new Set() },
}))

interface DisplayRequestBody {
  baseRevision: number
  context: { pageSessionId: string; browserLanguage?: string; screenWidth?: number; screenHeight?: number }
  targets: Array<{ requestKey: string; source: string; sourceHash: string }>
  priorityKeys?: string[]
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function successfulDisplayResponse(body: DisplayRequestBody, revision: number): Promise<Response> {
  const contextFingerprint = await sha256Hex(
    displaySourceNamespaceJson({ databaseLineage: 'lineage-a', activeWriterEpoch: 3, context: body.context }),
  )
  return jsonResponse({
    protocolVersion: 1,
    revision,
    contextFingerprint,
    entries: body.targets.map((target) => ({
      requestKey: target.requestKey,
      status: 'ok',
      sourceHash: target.sourceHash,
      dependencyFingerprint: `dep:${target.source}`,
      displaySource: target.source.toUpperCase(),
    })),
  })
}

describe('browser display source batching client', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    pluginRuntime.ready = true
    resetServerResourceState()
    resetWriterAccessLostForTests()
    resetDisplaySourceClientForTests()
    clearCachedServerCommandRevision()
    pluginV2.editdisplay.clear()
    resetRegexDisplayReloadForTests()
    setCachedServerCommandRevision(7)
    configureDisplaySourceProtocol({ version: 1 }, 'lineage-a', 3)
  })

  afterEach(() => {
    resetClientSessionForTests()
    vi.unstubAllGlobals()
    pluginV2.editdisplay.clear()
    resetDisplaySourceClientForTests()
    clearCachedServerCommandRevision()
    resetRegexDisplayReloadForTests()
    resetServerResourceState()
  })

  it('batches same-chat transforms and validates the exact namespace/source response', async () => {
    const requests: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as DisplayRequestBody
      requests.push(body as unknown as Record<string, unknown>)
      return successfulDisplayResponse(body, 7)
    })

    const character = { chaId: 'char-a', name: 'Tess' }
    const [first, second] = await Promise.all([
      requestServerDisplaySource({
        chatId: 'chat-a',
        character,
        messageId: 'message-a',
        index: 0,
        role: 'char',
        firstMessage: false,
        layer: 'original',
        source: 'first',
      }),
      requestServerDisplaySource({
        chatId: 'chat-a',
        character,
        messageId: 'message-b',
        index: 1,
        role: 'char',
        firstMessage: false,
        layer: 'translation',
        source: 'second',
      }),
    ])

    expect(requests).toHaveLength(1)
    expect(requests[0].targets as unknown[]).toHaveLength(2)
    expect(requests[0].context).toMatchObject({ screenWidth: window.innerWidth, screenHeight: window.innerHeight })
    expect(first).toMatchObject({ status: 'ok', displaySource: 'FIRST' })
    expect(second).toMatchObject({ status: 'ok', displaySource: 'SECOND' })
  })

  it('deduplicates identical in-flight and completed targets until their regex owner activates', async () => {
    charactersResourceState.characters = [
      {
        chaId: 'char-a',
        name: 'Tess',
        type: 'character',
        chatPage: 0,
        chats: [],
      } as (typeof charactersResourceState.characters)[number],
    ]
    charactersResourceState.currentChar = 0
    charactersResourceState.status = 'ready'

    const requests: DisplayRequestBody[] = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as DisplayRequestBody
      requests.push(body)
      return successfulDisplayResponse(body, 7)
    })

    const input = {
      chatId: 'chat-a',
      character: { chaId: 'char-a', name: 'Tess' },
      messageId: 'message-a',
      index: 0,
      role: 'char',
      firstMessage: false,
      layer: 'original' as const,
      source: 'same source',
    }
    const [first, duplicate] = await Promise.all([requestServerDisplaySource(input), requestServerDisplaySource(input)])

    expect(requests).toHaveLength(1)
    expect(requests[0].targets).toHaveLength(1)
    expect(first).toEqual(duplicate)

    await expect(requestServerDisplaySource(input)).resolves.toEqual(first)
    expect(requests).toHaveLength(1)

    reloadRegexDisplay('char-b')
    await expect(requestServerDisplaySource(input)).resolves.toEqual(first)
    expect(requests).toHaveLength(1)

    reloadRegexDisplay('char-a')
    await expect(requestServerDisplaySource(input)).resolves.toMatchObject({
      status: 'ok',
      displaySource: 'SAME SOURCE',
    })
    expect(requests).toHaveLength(2)
  })

  it('streams three priority results from one mixed batch while background remains pending', async () => {
    activateDisplaySourceChat('chat-a')
    const requests: DisplayRequestBody[] = []
    let stream!: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('accept')).toContain('text/event-stream')
      requests.push(JSON.parse(String(init.body)))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const request = (source: string, index: number, priority: 'critical' | 'background') =>
      requestServerDisplaySource({
        chatId: 'chat-a',
        character: { chaId: 'char-a' },
        messageId: `message-${index}`,
        index,
        role: 'char',
        firstMessage: false,
        layer: 'original',
        source,
        priority,
      })
    let backgroundSettled = false
    const background = request('old', 0, 'background').then((result) => {
      backgroundSettled = true
      return result
    })
    const critical = [
      request('latest-a', 7, 'critical'),
      request('latest-b', 8, 'critical'),
      request('latest-c', 9, 'critical'),
    ]
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    const body = requests[0]
    expect(body.targets.map((target) => target.source)).toEqual(['latest-c', 'latest-b', 'latest-a', 'old'])
    expect(body.priorityKeys).toEqual(body.targets.slice(0, 3).map((target) => target.requestKey))
    const contextFingerprint = await sha256Hex(
      displaySourceNamespaceJson({ databaseLineage: 'lineage-a', activeWriterEpoch: 3, context: body.context }),
    )
    const context = { protocolVersion: 1, revision: 7, contextFingerprint }
    const send = (event: string, data: unknown) =>
      stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    const result = (target: DisplayRequestBody['targets'][number]) =>
      send('result', {
        ...context,
        entry: {
          requestKey: target.requestKey,
          sourceHash: target.sourceHash,
          status: 'ok',
          displaySource: target.source.toUpperCase(),
          dependencyFingerprint: `dep:${target.source}`,
        },
      })
    for (const target of body.targets.slice(0, 3)) result(target)
    await expect(Promise.all(critical)).resolves.toEqual([
      expect.objectContaining({ displaySource: 'LATEST-A' }),
      expect.objectContaining({ displaySource: 'LATEST-B' }),
      expect.objectContaining({ displaySource: 'LATEST-C' }),
    ])
    expect(backgroundSettled).toBe(false)
    expect(requests).toHaveLength(1)
    result(body.targets[3])
    send('done', { ...context, targetCount: 4 })
    stream.close()
    await expect(background).resolves.toMatchObject({ status: 'ok', displaySource: 'OLD' })
  })

  it('selects the current nearest three coalesced rows at dispatch and includes every layer', async () => {
    activateDisplaySourceChat('chat-a')
    setNearestDisplaySourceMessages('chat-a', [9, 8, 7, 6, 5])
    const entered = createDeferred<void>()
    const release = createDeferred<void>()
    const lane = runExternalServerRevisionOperation(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const requests: DisplayRequestBody[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as DisplayRequestBody
      requests.push(body)
      return successfulDisplayResponse(body, 7)
    })
    const results = [5, 6, 7, 8, 9].flatMap((index) =>
      (['original', 'translation'] as const).map((layer) =>
        requestServerDisplaySource({
          chatId: 'chat-a',
          character: { chaId: 'char-a' },
          messageId: `message-${index}`,
          index,
          role: 'char',
          firstMessage: false,
          layer,
          source: `${index}:${layer}`,
          priority: 'critical',
        }),
      ),
    )
    // Mounted waves have all marked themselves critical; scrolling reverses
    // while their common request is waiting behind a command.
    setNearestDisplaySourceMessages('chat-a', [5, 6, 7, 8, 9])
    release.resolve()
    await lane
    await Promise.all(results)
    expect(requests).toHaveLength(1)
    const body = requests[0]
    expect(body.targets).toHaveLength(10)
    expect(
      body.targets.filter((target) => body.priorityKeys?.includes(target.requestKey)).map((target) => target.source),
    ).toEqual(['5:original', '5:translation', '6:original', '6:translation', '7:original', '7:translation'])
    activateDisplaySourceChat('chat-b')
    setNearestDisplaySourceMessages('chat-a', [9])
    activateDisplaySourceChat('chat-a')
    const next = [0, 1, 2, 3].map((index) =>
      requestServerDisplaySource({
        chatId: 'chat-a',
        character: { chaId: 'char-a' },
        messageId: `other-${index}`,
        index,
        role: 'char',
        firstMessage: false,
        layer: 'original',
        source: `other-${index}`,
        priority: 'critical',
      }),
    )
    await Promise.all(next)
    const latest = requests[1]
    expect(
      latest.targets
        .filter((target) => latest.priorityKeys?.includes(target.requestKey))
        .map((target) => target.source),
    ).toEqual(['other-3', 'other-2', 'other-1'])
  })

  it.each(['eof', 'duplicate', 'invalidated', 'namespace', 'malformed'] as const)(
    'settles unfinished stream targets after %s and keeps cancellation through body consumption',
    async (failure) => {
      activateDisplaySourceChat('chat-a')
      let body!: DisplayRequestBody
      let stream!: ReadableStreamDefaultController<Uint8Array>
      const cancel = vi.fn()
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const input = {
        chatId: 'chat-a',
        character: { chaId: 'char-a' },
        role: 'char',
        firstMessage: false,
        layer: 'original' as const,
        priority: 'critical' as const,
      }
      const first = requestServerDisplaySource({ ...input, index: 1, messageId: 'one', source: 'one' })
      const second = requestServerDisplaySource({ ...input, index: 0, messageId: 'two', source: 'two' })
      await vi.waitFor(() => expect(body).toBeDefined())
      const contextFingerprint = await sha256Hex(
        displaySourceNamespaceJson({ databaseLineage: 'lineage-a', activeWriterEpoch: 3, context: body.context }),
      )
      const context = { protocolVersion: 1, revision: 7, contextFingerprint }
      const send = (event: string, data: unknown) =>
        stream.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      const entry = {
        requestKey: body.targets[0].requestKey,
        sourceHash: body.targets[0].sourceHash,
        status: 'ok',
        displaySource: 'ONE',
        dependencyFingerprint: 'dep',
      }
      send('result', { ...context, entry })
      await expect(first).resolves.toMatchObject({ status: 'ok', displaySource: 'ONE' })
      const renderEpoch = captureDisplaySourceRenderEpoch()
      if (failure === 'eof') stream.close()
      if (failure === 'duplicate') send('result', { ...context, entry })
      if (failure === 'invalidated') send('invalidated', { revision: 8, reason: 'revision_changed_during_transform' })
      if (failure === 'namespace') configureDisplaySourceProtocol({ version: 1 }, 'lineage-b', 4)
      if (failure === 'malformed') send('result', { ...context, entry: { status: 'ok' } })
      await expect(second).resolves.toMatchObject({ status: 'fallback' })
      if (failure !== 'eof') await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
      expect(peekCachedServerCommandRevision()).toBe(failure === 'invalidated' ? 8 : 7)
      if (failure !== 'eof') expect(captureDisplaySourceRenderEpoch()).not.toBe(renderEpoch)
      await runExternalServerRevisionOperation(async () => undefined)
    },
  )

  it('packs by aggregate UTF-8 source bytes as well as target count', async () => {
    const sizes: number[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as DisplayRequestBody
      sizes.push(body.targets.reduce((bytes, target) => bytes + new TextEncoder().encode(target.source).byteLength, 0))
      return successfulDisplayResponse(body, 7)
    })
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        requestServerDisplaySource({
          chatId: 'chat-a',
          character: { chaId: 'char-a' },
          index,
          messageId: `large-${index}`,
          role: 'char',
          firstMessage: false,
          layer: 'original',
          source: 'a'.repeat(512 * 1024),
        }),
      ),
    )
    expect(sizes).toEqual([4 * 1024 * 1024, 1024 * 1024])
  })

  it('aborts obsolete visible-chat work so navigation can use the revision lane', async () => {
    activateDisplaySourceChat('chat-a')
    const requests: DisplayRequestBody[] = []
    let firstRequestAborted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as DisplayRequestBody
        requests.push(body)
        if (requests.length > 1) return successfulDisplayResponse(body, 8)
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              firstRequestAborted = true
              reject(init.signal?.reason)
            },
            { once: true },
          )
        })
      }) as unknown as typeof fetch,
    )

    const obsolete = requestServerDisplaySource({
      chatId: 'chat-a',
      character: { chaId: 'char-a' },
      messageId: 'message-a',
      index: 0,
      role: 'char',
      firstMessage: false,
      layer: 'original',
      source: 'obsolete',
      priority: 'critical',
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    activateDisplaySourceChat('chat-b')
    await expect(obsolete).resolves.toEqual({ status: 'fallback', reason: 'display_scope_changed' })
    expect(firstRequestAborted).toBe(true)

    const current = requestServerDisplaySource({
      chatId: 'chat-b',
      character: { chaId: 'char-b' },
      messageId: 'message-b',
      index: 0,
      role: 'char',
      firstMessage: false,
      layer: 'original',
      source: 'current',
      priority: 'critical',
    })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    await expect(current).resolves.toMatchObject({ status: 'ok', displaySource: 'CURRENT' })
  })

  it('holds the shared revision lane until a display response advances the cursor', async () => {
    const deferredDisplayResponse = createDeferred<Response>()
    const displayRequests: DisplayRequestBody[] = []
    const selectionRequests: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const body = JSON.parse(String(init.body)) as DisplayRequestBody
        if (url.endsWith('/display-sources')) {
          displayRequests.push(body)
          return deferredDisplayResponse.promise
        }
        if (url === '/api/v1/commands/characters/select') {
          selectionRequests.push(body as unknown as Record<string, unknown>)
          return jsonResponse({
            revision: 9,
            event: { type: 'character.selected', revision: 9, resource: 'characterSelection', id: 'char-b' },
            characterId: 'char-b',
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }) as unknown as typeof fetch,
    )

    const display = requestServerDisplaySource({
      chatId: 'chat-a',
      character: { chaId: 'char-a' },
      messageId: 'message-a',
      index: 0,
      role: 'char',
      firstMessage: false,
      layer: 'original',
      source: 'first',
    })
    await vi.waitFor(() => expect(displayRequests).toHaveLength(1))

    const selection = runServerCommand({
      command: (baseRevision) =>
        selectCharacterCommand({
          baseRevision,
          characterId: 'char-b',
          lastInteraction: 1234,
        }),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(selectionRequests).toHaveLength(0)

    deferredDisplayResponse.resolve(await successfulDisplayResponse(displayRequests[0], 8))
    await expect(display).resolves.toMatchObject({ status: 'ok', displaySource: 'FIRST' })
    await vi.waitFor(() => expect(selectionRequests).toHaveLength(1))
    expect(selectionRequests[0]).toMatchObject({
      baseRevision: 8,
      characterId: 'char-b',
      lastInteraction: 1234,
    })
    await expect(selection).resolves.toMatchObject({ status: 'ok', revision: 9 })
    expect(peekCachedServerCommandRevision()).toBe(9)
  })

  it('serializes display batches that are scheduled while an earlier batch is in flight', async () => {
    const deferredFirstResponse = createDeferred<Response>()
    const requests: DisplayRequestBody[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as DisplayRequestBody
        requests.push(body)
        if (requests.length === 1) return deferredFirstResponse.promise
        return successfulDisplayResponse(body, 9)
      }) as unknown as typeof fetch,
    )

    const first = requestServerDisplaySource({
      chatId: 'chat-a',
      character: { chaId: 'char-a' },
      messageId: 'message-a',
      index: 0,
      role: 'char',
      firstMessage: false,
      layer: 'original',
      source: 'first',
    })
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    const second = requestServerDisplaySource({
      chatId: 'chat-a',
      character: { chaId: 'char-a' },
      messageId: 'message-b',
      index: 1,
      role: 'char',
      firstMessage: false,
      layer: 'original',
      source: 'second',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toHaveLength(1)

    deferredFirstResponse.resolve(await successfulDisplayResponse(requests[0], 8))
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.map((request) => request.baseRevision)).toEqual([7, 8])
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'ok', displaySource: 'FIRST' }),
      expect.objectContaining({ status: 'ok', displaySource: 'SECOND' }),
    ])
    expect(peekCachedServerCommandRevision()).toBe(9)
  })

  it('selects the whole client path without a request when an editdisplay plugin is registered', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    pluginV2.editdisplay.add(async (source) => source)

    await expect(
      requestServerDisplaySource({
        chatId: 'chat-a',
        character: { chaId: 'char-a' },
        index: 0,
        role: 'char',
        firstMessage: false,
        layer: 'original',
        source: 'body',
      }),
    ).resolves.toEqual({ status: 'fallback', reason: 'browser_editdisplay_plugin' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('ignores a partial editdisplay registration while plugin runtime is not ready', async () => {
    pluginRuntime.ready = false
    pluginV2.editdisplay.add(async (source) => source)
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as DisplayRequestBody
      return successfulDisplayResponse(body, 8)
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    await expect(
      requestServerDisplaySource({
        chatId: 'chat-a',
        character: { chaId: 'char-a' },
        index: 0,
        role: 'assistant',
        firstMessage: false,
        layer: 'original',
        source: 'body',
      }),
    ).resolves.toMatchObject({ status: 'ok', displaySource: 'BODY' })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})

describe('connected reader isolated display', () => {
  beforeEach(() => {
    resetClientSessionForTests()
    resetDisplaySourceClientForTests()
    resetWriterAccessLostForTests()
    setCachedServerCommandRevision(7)
    configureDisplaySourceProtocol({ version: 1 }, 'lineage-a', 3)
  })
  afterEach(() => {
    resetClientSessionForTests()
    resetDisplaySourceClientForTests()
    vi.unstubAllGlobals()
  })
  const target = {
    chatId: 'chat-a',
    character: { chaId: 'char-a' },
    index: 0,
    role: 'char',
    firstMessage: false,
    layer: 'original' as const,
    source: 'readable',
  }
  function enterReader() {
    const operation = beginClientSession('reader')
    settleClientReader(operation, { databaseLineage: 'lineage-a', writer: { sessionId: 'other', epoch: 3 } })
  }
  it('runs an authenticated display POST while the ordinary writer queue is occupied', async () => {
    const held = createDeferred<void>()
    const entered = createDeferred<void>()
    const writerQueue = runExternalServerRevisionOperation(async () => {
      entered.resolve()
      await held.promise
    })
    await entered.promise
    enterReader()
    pluginRuntime.ready = false
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('risu-auth')).toBe('display-auth')
      expect(new Headers(init?.headers).get('risu-database-lineage')).toBe('lineage-a')
      return successfulDisplayResponse(JSON.parse(String(init?.body)), 7)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(requestServerDisplaySource(target)).resolves.toMatchObject({
        status: 'ok',
        displaySource: 'READABLE',
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      held.resolve()
      await writerQueue
    }
  })
  it('rejects responses after an auth/session or namespace change without advancing revision', async () => {
    enterReader()
    const response = createDeferred<Response>()
    let body: DisplayRequestBody | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return response.promise
    })
    const request = requestServerDisplaySource(target)
    await vi.waitFor(() => expect(body).toBeDefined())
    beginClientSession('new-reader')
    response.resolve(await successfulDisplayResponse(body!, 99))
    await expect(request).resolves.toEqual({ status: 'fallback', reason: 'display_namespace_changed' })
    expect(peekCachedServerCommandRevision()).toBe(7)
  })
  it('rejects changed source fingerprints and keeps the limited-display notice within its chat', async () => {
    enterReader()
    activateDisplaySourceChat('chat-a')
    markReaderDisplayLimited()
    expect(get(readerDisplayLimitedStore)).toBe(true)
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      body.targets[0].sourceHash = 'stale'
      return successfulDisplayResponse(body, 7)
    })
    await expect(requestServerDisplaySource(target)).resolves.toEqual({ status: 'fallback', reason: 'stale_response' })
    expect(get(readerDisplayLimitedStore)).toBe(true)
    activateDisplaySourceChat('chat-b')
    expect(get(readerDisplayLimitedStore)).toBe(false)
    markReaderDisplayLimited()
    configureDisplaySourceProtocol({ version: 1 }, 'lineage-b', 4)
    expect(get(readerDisplayLimitedStore)).toBe(false)
  })
})
