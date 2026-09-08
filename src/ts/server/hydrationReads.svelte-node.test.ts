import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'

const browserEvidence = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[], generation: 0 }))
vi.mock('./browserDiagnostics', () => ({
  recordBrowserDiagnostic: (entry: Record<string, unknown>) => browserEvidence.entries.push(entry),
  resetBrowserDiagnosticsSession: () => {
    browserEvidence.generation++
    browserEvidence.entries = []
  },
  captureBrowserDiagnosticsGeneration: () => browserEvidence.generation,
  isBrowserDiagnosticsGenerationCurrent: (generation: number) => generation === browserEvidence.generation,
}))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'resource-auth-token',
}))

import {
  fetchServerBulkCharacterLorebooks,
  fetchServerBulkChatMessages,
  fetchServerCharacterLorebook,
  fetchServerChatMessages,
  fetchServerGenerationChatMessages,
  fetchServerLegacyPreset,
  fetchServerPromptPresetTemplate,
} from './hydrationReads'
import { clearResourceCache, flushResourceCacheMaintenanceForTests, sha256JsonValue } from './resourceCache'

interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  contentType: string | null
  body: unknown
  signal: AbortSignal | null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeResourceFetch(bodyForRequest: (url: string, init: RequestInit) => unknown): {
  calls: CapturedFetch[]
  fetch: typeof fetch
} {
  const calls: CapturedFetch[] = []

  return {
    calls,
    fetch: vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const rawBody = typeof init.body === 'string' ? JSON.parse(init.body) : null
      const url = String(input)

      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        contentType: headers?.['content-type'] ?? null,
        body: rawBody,
        signal: init.signal ?? null,
      })

      const body = bodyForRequest(url, init)
      return body instanceof Response ? body : jsonResponse(body)
    }) as unknown as typeof fetch,
  }
}

function parsedCallUrl(call: CapturedFetch): URL {
  return new URL(call.url, 'http://localhost')
}

afterEach(() => {
  browserEvidence.entries = []
  vi.unstubAllGlobals()
})

describe('server hydration read clients', () => {
  it('discards a late cache result from the previous browser diagnostics session', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await clearResourceCache()
    let resolve!: (response: Response) => void
    const response = new Promise<Response>((done) => {
      resolve = done
    })
    const fetch = vi.fn(() => response)
    vi.stubGlobal('fetch', fetch)
    const request = fetchServerLegacyPreset('private-preset-canary')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    browserEvidence.generation++
    browserEvidence.entries = []
    resolve(
      jsonResponse({
        revision: 1,
        cache: { version: 2, algorithm: 'sha256' },
        preset: { id: 'private-preset-canary', name: 'Private preset', prompt: 'PRIVATE_PROMPT_CANARY' },
      }),
    )
    await expect(request).resolves.toMatchObject({ status: 'ok' })
    await flushResourceCacheMaintenanceForTests()
    expect(browserEvidence.entries).toEqual([])
  })

  it('fetches legacy preset detail through the resource endpoint', async () => {
    const controller = new AbortController()
    const responses = [
      {
        revision: 6,
        preset: { id: 'preset-a', name: 'Preset A' },
      },
      {
        revision: 7,
        preset: null,
      },
    ]
    const resourceFetch = makeResourceFetch(() => responses.shift())
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerLegacyPreset('preset/a', { signal: controller.signal })).resolves.toEqual({
      status: 'ok',
      revision: 6,
      presetId: 'preset-a',
      preset: { id: 'preset-a', name: 'Preset A' },
    })
    expect(parsedCallUrl(resourceFetch.calls[0]).pathname).toBe('/api/v1/legacy-presets/preset%2Fa')
    expect(resourceFetch.calls[0]).toMatchObject({
      method: 'GET',
      authHeader: 'resource-auth-token',
      contentType: null,
      body: null,
      signal: controller.signal,
    })

    await expect(fetchServerLegacyPreset('preset-b')).resolves.toEqual({
      status: 'error',
      error: 'Invalid preset response',
    })
  })

  it('fetches a prompt preset template by encoded stable id', async () => {
    const controller = new AbortController()
    const resourceFetch = makeResourceFetch(() => ({
      revision: 8,
      promptPresetId: 'preset/one',
      promptTemplate: [{ id: 'prompt-1', text: 'hello' }],
    }))
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerPromptPresetTemplate('preset/one', { signal: controller.signal })).resolves.toEqual({
      status: 'ok',
      revision: 8,
      promptPresetId: 'preset/one',
      promptTemplate: [{ id: 'prompt-1', text: 'hello' }],
    })
    expect(parsedCallUrl(resourceFetch.calls[0]).pathname).toBe('/api/v1/prompt-presets/preset%2Fone/template')
    expect(resourceFetch.calls[0]).toMatchObject({
      method: 'GET',
      authHeader: 'resource-auth-token',
      signal: controller.signal,
    })
  })

  it('reconstructs cached prompt, legacy preset, and character lorebook bodies from IndexedDB', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await clearResourceCache()

    const legacyPreset = { id: 'legacy-a', name: 'Legacy A', prompt: 'large legacy prompt' }
    const promptTemplate = [{ id: 'prompt-a', text: 'large prompt template' }]
    const globalLore = [{ key: 'Ada', content: 'large lorebook entry' }]
    const legacyHash = await sha256JsonValue(legacyPreset)
    const promptHash = await sha256JsonValue(promptTemplate[0])
    const loreHash = await sha256JsonValue(globalLore[0])
    const requestCounts = new Map<string, number>()
    const resourceFetch = makeResourceFetch((url) => {
      const count = (requestCounts.get(url) ?? 0) + 1
      requestCounts.set(url, count)
      if (url.includes('/legacy-presets/')) {
        return {
          revision: count,
          cache: { version: 2, algorithm: 'sha256' },
          preset: count === 1 ? legacyPreset : legacyHash,
        }
      }
      if (url.includes('/prompt-presets/')) {
        return {
          revision: count,
          cache: { version: 2, algorithm: 'sha256' },
          promptPresetId: 'prompt-a',
          promptTemplate: count === 1 ? promptTemplate.map((value) => ({ value })) : [{ hash: promptHash }],
        }
      }
      return {
        revision: count,
        cache: { version: 2, algorithm: 'sha256' },
        characterId: 'char-a',
        globalLore: count === 1 ? globalLore.map((value) => ({ value })) : [{ hash: loreHash }],
      }
    })
    vi.stubGlobal('fetch', resourceFetch.fetch)

    try {
      await expect(fetchServerLegacyPreset('legacy-a')).resolves.toMatchObject({
        status: 'ok',
        preset: legacyPreset,
      })
      await expect(fetchServerPromptPresetTemplate('prompt-a')).resolves.toMatchObject({
        status: 'ok',
        promptTemplate,
      })
      await expect(fetchServerCharacterLorebook('char-a')).resolves.toMatchObject({
        status: 'ok',
        globalLore,
      })
      await flushResourceCacheMaintenanceForTests()
      await expect(fetchServerLegacyPreset('legacy-a')).resolves.toMatchObject({
        status: 'ok',
        preset: legacyPreset,
      })
      await expect(fetchServerPromptPresetTemplate('prompt-a')).resolves.toMatchObject({
        status: 'ok',
        promptTemplate,
      })
      await expect(fetchServerCharacterLorebook('char-a')).resolves.toMatchObject({
        status: 'ok',
        globalLore,
      })

      expect(resourceFetch.calls.every((call) => call.method === 'POST')).toBe(true)
      expect(resourceFetch.calls.every((call) => call.authHeader === 'resource-auth-token')).toBe(true)
      expect(resourceFetch.calls.every((call) => call.contentType === 'application/json')).toBe(true)
      expect(resourceFetch.calls[0]?.body).toEqual({ cache: { version: 2, hashes: { preset: [] } } })
      expect(resourceFetch.calls[1]?.body).toEqual({
        cache: {
          version: 2,
          hashes: { promptTemplate: [], selectedFallbackPromptTemplate: [] },
        },
      })
      expect(resourceFetch.calls[2]?.body).toEqual({ cache: { version: 2, hashes: { globalLore: [] } } })
      expect(resourceFetch.calls[3]?.body).toEqual({ cache: { version: 2, hashes: { preset: [legacyHash] } } })
      expect(resourceFetch.calls[4]?.body).toEqual({
        cache: {
          version: 2,
          hashes: { promptTemplate: [promptHash], selectedFallbackPromptTemplate: [] },
        },
      })
      expect(resourceFetch.calls[5]?.body).toEqual({
        cache: { version: 2, hashes: { globalLore: [loreHash] } },
      })
    } finally {
      await clearResourceCache()
    }
  })

  it('falls back to the legacy GET hydration route when cache POST is unsupported', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await clearResourceCache()
    const resourceFetch = makeResourceFetch((_url, init) =>
      init.method === 'POST'
        ? jsonResponse({ error: 'not_found' }, 404)
        : { revision: 6, preset: { id: 'legacy-a', name: 'Legacy A' } },
    )
    vi.stubGlobal('fetch', resourceFetch.fetch)

    try {
      await expect(fetchServerLegacyPreset('legacy-a')).resolves.toMatchObject({
        status: 'ok',
        preset: { id: 'legacy-a', name: 'Legacy A' },
      })
      expect(resourceFetch.calls.map((call) => call.method)).toEqual(['POST', 'GET'])
    } finally {
      await clearResourceCache()
    }
  })

  it('caches a selected default prompt fallback separately from its null owner body', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    await clearResourceCache()
    const fallback = [{ id: 'root-prompt', text: 'fallback prompt' }]
    const nullHash = await sha256JsonValue(null)
    const fallbackHash = await sha256JsonValue(fallback[0])
    let requestCount = 0
    const resourceFetch = makeResourceFetch(() => {
      requestCount += 1
      return {
        revision: requestCount,
        cache: { version: 2, algorithm: 'sha256' },
        promptPresetId: 'default-prompt-preset',
        promptTemplate: requestCount === 1 ? null : nullHash,
        selectedFallbackPromptTemplate:
          requestCount === 1 ? fallback.map((value) => ({ value })) : [{ hash: fallbackHash }],
      }
    })
    vi.stubGlobal('fetch', resourceFetch.fetch)

    try {
      await expect(fetchServerPromptPresetTemplate('default-prompt-preset')).resolves.toMatchObject({
        status: 'ok',
        promptTemplate: null,
        selectedFallbackPromptTemplate: fallback,
      })
      await flushResourceCacheMaintenanceForTests()
      await expect(fetchServerPromptPresetTemplate('default-prompt-preset')).resolves.toMatchObject({
        status: 'ok',
        promptTemplate: null,
        selectedFallbackPromptTemplate: fallback,
      })
      expect(resourceFetch.calls[1]?.body).toEqual({
        cache: {
          version: 2,
          hashes: {
            promptTemplate: [nullHash],
            selectedFallbackPromptTemplate: [fallbackHash],
          },
        },
      })
    } finally {
      await clearResourceCache()
    }
  })

  it('parses the selected default-scaffold fallback separately from the preset-owned body', async () => {
    const resourceFetch = makeResourceFetch(() => ({
      revision: 9,
      promptPresetId: 'default-prompt-preset',
      promptTemplate: null,
      selectedFallbackPromptTemplate: [{ id: 'root-prompt', text: 'fallback' }],
    }))
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerPromptPresetTemplate('default-prompt-preset')).resolves.toEqual({
      status: 'ok',
      revision: 9,
      promptPresetId: 'default-prompt-preset',
      promptTemplate: null,
      selectedFallbackPromptTemplate: [{ id: 'root-prompt', text: 'fallback' }],
    })
  })

  it('fetches chat messages with tail or range query params and parses optional ranges', async () => {
    const responses = [
      {
        revision: 10,
        chatId: 'chat/server',
        message: [{ role: 'user', data: 'tail' }],
        hypaV3Data: { summary: 'tail' },
        messageStart: 8,
        messageTotal: 10,
        alternates: [{ index: 1 }],
      },
      {
        revision: 11,
        message: [{ role: 'char', data: 'range' }],
      },
    ]
    const resourceFetch = makeResourceFetch(() => responses.shift())
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerChatMessages('chat/request', { tail: 2, start: 4, limit: 99 })).resolves.toEqual({
      status: 'ok',
      revision: 10,
      chatId: 'chat/server',
      message: [{ role: 'user', data: 'tail' }],
      hypaV3Data: { summary: 'tail' },
      hypaV3DataIncluded: true,
      messageStart: 8,
      messageTotal: 10,
      alternates: [{ index: 1 }],
    })
    await expect(fetchServerChatMessages('chat/request', { start: 4, limit: 8 })).resolves.toEqual({
      status: 'ok',
      revision: 11,
      chatId: 'chat/request',
      message: [{ role: 'char', data: 'range' }],
      hypaV3Data: undefined,
      hypaV3DataIncluded: true,
      alternates: [],
    })

    const tailUrl = parsedCallUrl(resourceFetch.calls[0])
    expect(tailUrl.pathname).toBe('/api/v1/chats/chat%2Frequest/messages')
    expect(tailUrl.searchParams.get('tail')).toBe('2')
    expect(tailUrl.searchParams.has('start')).toBe(false)
    expect(tailUrl.searchParams.has('limit')).toBe(false)
    expect(resourceFetch.calls[0].authHeader).toBe('resource-auth-token')

    const rangeUrl = parsedCallUrl(resourceFetch.calls[1])
    expect(rangeUrl.pathname).toBe('/api/v1/chats/chat%2Frequest/messages')
    expect(rangeUrl.searchParams.has('id')).toBe(false)
    expect(rangeUrl.searchParams.get('start')).toBe('4')
    expect(rangeUrl.searchParams.get('limit')).toBe('8')
  })

  it('fetches a bounded generation suffix by encoded active message id', async () => {
    const controller = new AbortController()
    const resourceFetch = makeResourceFetch(() => ({
      revision: 12,
      chatId: 'chat/request',
      message: [{ role: 'char', data: 'generated' }],
      messageStart: 9,
      messageTotal: 10,
      alternates: [{ role: 'char', data: 'alternate' }],
    }))
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(
      fetchServerGenerationChatMessages('chat/request', 'message/generated', { signal: controller.signal }),
    ).resolves.toEqual({
      status: 'ok',
      revision: 12,
      chatId: 'chat/request',
      message: [{ role: 'char', data: 'generated' }],
      hypaV3Data: undefined,
      hypaV3DataIncluded: false,
      messageStart: 9,
      messageTotal: 10,
      alternates: [{ role: 'char', data: 'alternate' }],
    })

    const url = parsedCallUrl(resourceFetch.calls[0])
    expect(url.pathname).toBe('/api/v1/chats/chat%2Frequest/messages')
    expect(url.searchParams.get('generationMessageId')).toBe('message/generated')
    expect(resourceFetch.calls[0]).toMatchObject({
      method: 'GET',
      authHeader: 'resource-auth-token',
      signal: controller.signal,
    })

    await expect(fetchServerGenerationChatMessages('chat-a', '')).resolves.toEqual({
      status: 'error',
      error: 'Generation message id is required',
    })
    expect(resourceFetch.calls).toHaveLength(1)
  })

  it('posts bulk chat hydration with JSON body and filters malformed missing ids', async () => {
    const resourceFetch = makeResourceFetch(() => ({
      revision: 12,
      chats: [
        {
          chatId: 'chat-a',
          message: [{ data: 'A' }],
          hypaV3Data: { a: true },
          alternates: [{ data: 'alternate A' }],
        },
        { chatId: 'chat-b', message: [] },
      ],
      missing: ['chat-c', 42, null],
    }))
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerBulkChatMessages(['chat-a', 'chat-b', 'chat-c'])).resolves.toEqual({
      status: 'ok',
      revision: 12,
      chats: [
        {
          chatId: 'chat-a',
          message: [{ data: 'A' }],
          hypaV3Data: { a: true },
          alternates: [{ data: 'alternate A' }],
        },
        { chatId: 'chat-b', message: [], hypaV3Data: undefined, alternates: [] },
      ],
      missing: ['chat-c'],
    })

    expect(resourceFetch.calls).toEqual([
      {
        url: '/api/v1/chats/messages/bulk',
        method: 'POST',
        authHeader: 'resource-auth-token',
        contentType: 'application/json',
        body: { ids: ['chat-a', 'chat-b', 'chat-c'] },
        signal: null,
      },
    ])
  })

  it('fetches character lorebooks with encoded ids and response-id fallback', async () => {
    const responses = [
      {
        revision: 13,
        characterId: 'char/request one',
        globalLore: [{ key: 'server' }],
      },
      {
        revision: 14,
        globalLore: [{ key: 'fallback' }],
      },
    ]
    const resourceFetch = makeResourceFetch(() => responses.shift())
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerCharacterLorebook('char/request one')).resolves.toEqual({
      status: 'ok',
      revision: 13,
      characterId: 'char/request one',
      globalLore: [{ key: 'server' }],
    })
    await expect(fetchServerCharacterLorebook('char/request two')).resolves.toEqual({
      status: 'ok',
      revision: 14,
      characterId: 'char/request two',
      globalLore: [{ key: 'fallback' }],
    })

    expect(resourceFetch.calls[0].url).toBe('/api/v1/characters/char%2Frequest%20one/lorebook')
    expect(resourceFetch.calls[1].url).toBe('/api/v1/characters/char%2Frequest%20two/lorebook')
  })

  it('rejects a single-character lorebook response for a different character', async () => {
    const resourceFetch = makeResourceFetch(() => ({
      revision: 15,
      characterId: 'char-b',
      globalLore: [{ key: 'wrong resident character' }],
    }))
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerCharacterLorebook('char-a')).resolves.toEqual({
      status: 'error',
      error: 'Invalid character-lorebook identity',
    })
  })

  it('posts bulk character lorebook hydration with JSON body and filters malformed missing ids', async () => {
    const resourceFetch = makeResourceFetch(() => ({
      revision: 15,
      characters: [
        { characterId: 'char-a', globalLore: [{ key: 'A' }] },
        { characterId: 'char-b', globalLore: [] },
      ],
      missing: ['char-c', false],
    }))
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerBulkCharacterLorebooks(['char-a', 'char-b', 'char-c'])).resolves.toEqual({
      status: 'ok',
      revision: 15,
      characters: [
        { characterId: 'char-a', globalLore: [{ key: 'A' }] },
        { characterId: 'char-b', globalLore: [] },
      ],
      missing: ['char-c'],
    })

    expect(resourceFetch.calls).toEqual([
      {
        url: '/api/v1/characters/lorebooks/bulk',
        method: 'POST',
        authHeader: 'resource-auth-token',
        contentType: 'application/json',
        body: { ids: ['char-a', 'char-b', 'char-c'] },
        signal: null,
      },
    ])
  })

  it('returns status errors for server, network, and malformed responses', async () => {
    const responses = [
      jsonResponse({ reason: 'active_writer_stale' }, 423),
      { revision: 'bad', promptPresetId: 'preset-a', promptTemplate: [] },
      { revision: 1, promptPresetId: 'preset-a', promptTemplate: {} },
      {
        revision: 1,
        promptPresetId: 'preset-a',
        promptTemplate: null,
        selectedFallbackPromptTemplate: {},
      },
      {
        revision: 1,
        chatId: 'chat-a',
        message: [],
        messageStart: 3,
        messageTotal: 2,
      },
      {
        revision: 1,
        chats: [{ chatId: 'chat-a' }],
      },
      {
        revision: 1,
        characters: [{ characterId: 'char-a' }],
      },
    ]
    const resourceFetch = makeResourceFetch(() => responses.shift())
    vi.stubGlobal('fetch', resourceFetch.fetch)

    await expect(fetchServerLegacyPreset('preset-a')).resolves.toEqual({
      status: 'error',
      error: 'active_writer_stale',
    })
    await expect(fetchServerPromptPresetTemplate('preset-a')).resolves.toEqual({
      status: 'error',
      error: 'Invalid resource revision',
    })
    await expect(fetchServerPromptPresetTemplate('preset-a')).resolves.toEqual({
      status: 'error',
      error: 'Invalid prompt preset template response',
    })
    await expect(fetchServerPromptPresetTemplate('preset-a')).resolves.toEqual({
      status: 'error',
      error: 'Invalid prompt preset template response',
    })
    await expect(fetchServerChatMessages('chat-a')).resolves.toEqual({
      status: 'error',
      error: 'Invalid chat-messages range',
    })
    await expect(fetchServerBulkChatMessages(['chat-a'])).resolves.toEqual({
      status: 'error',
      error: 'Invalid bulk chat-messages entry',
    })
    await expect(fetchServerBulkCharacterLorebooks(['char-a'])).resolves.toEqual({
      status: 'error',
      error: 'Invalid bulk character-lorebook entry',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
    )

    await expect(fetchServerCharacterLorebook('char-a')).resolves.toEqual({
      status: 'error',
      error: 'Network error: offline',
    })
  })
})
