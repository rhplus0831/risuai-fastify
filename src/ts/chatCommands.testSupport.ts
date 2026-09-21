// Import this support module first so Vitest installs the command mocks before runtime imports.
// Keep stores.svelte before resourceState/database imports to avoid their reactive initialization cycle.
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
} from './server/commands'
import { resetWriterAccessLostForTests } from './server/activeWriterSession'
import { resetClientSessionForTests } from './clientSession'
import { selectedCharID } from './stores.svelte'
import { replaceResourceDatabase as setDatabaseLite } from './server/resourceState.svelte'
import {
  clearPendingMutationOutbox,
  preparePendingMutationOutbox,
  resetPendingMutationOutboxForTests,
} from './server/pendingMutationOutbox'
import { resetChatHydration } from './server/chatMessageHydration.svelte'

const writerAccessMocks = vi.hoisted(() => ({
  lost: false,
  report: vi.fn(() => writerAccessMocks.lost),
}))

export { writerAccessMocks }

vi.mock('./platform', async (importActual) => {
  const actual = await importActual<typeof import('./platform')>()
  return {
    ...actual,
    isFastifyServer: true,
  }
})

vi.mock('./storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'chat-command-token',
}))

vi.mock('./server/activeWriterSession', async (importActual) => {
  const actual = await importActual<typeof import('./server/activeWriterSession')>()
  return { ...actual, reportWriterAccessLostMutation: writerAccessMocks.report }
})

export interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  body: unknown
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

export function stubCommandFetch(): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (url === '/api/v1/commands/characters/char-a/chats') {
        return jsonResponse({
          revision: 11,
          event: { type: 'chat.created', revision: 11, resource: 'chat' },
          selectedChatId: 'chat-b',
        })
      }
      if (url === '/api/v1/commands/characters/char-a/chat-folders') {
        return jsonResponse({
          revision: 12,
          event: { type: 'chatFolder.created', revision: 12, resource: 'chatFolder' },
          folderId: 'folder-a',
        })
      }
      if (url === '/api/v1/commands/chats/chat-a') {
        if (init.method === 'DELETE') {
          return jsonResponse({
            revision: 18,
            event: { type: 'chat.deleted', revision: 18, resource: 'chat', id: 'chat-a' },
            chatId: 'chat-a',
            selectedChatId: 'chat-b',
          })
        }
        return jsonResponse({
          revision: 13,
          event: { type: 'chat.updated', revision: 13, resource: 'chat' },
          selectedChatId: 'chat-a',
        })
      }
      if (url === '/api/v1/commands/chats/chat-b') {
        return jsonResponse({
          revision: 13,
          event: { type: 'chat.updated', revision: 13, resource: 'characterRow' },
          selectedChatId: 'chat-b',
        })
      }
      if (url === '/api/v1/commands/characters/char-a/chats/reorder') {
        return jsonResponse({
          revision: 14,
          event: { type: 'chat.reordered', revision: 14, resource: 'chat' },
          selectedChatId: 'chat-a',
        })
      }
      if (url === '/api/v1/commands/characters/char-a/chat-folders/reorder') {
        return jsonResponse({
          revision: 15,
          event: { type: 'chatFolder.reordered', revision: 15, resource: 'chatFolder' },
          selectedChatId: 'chat-a',
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/scriptstate') {
        return jsonResponse({
          revision: 16,
          event: {
            type: 'chat.scriptstate.updated',
            revision: 16,
            resource: 'chat',
            id: 'chat-a',
          },
          chatId: 'chat-a',
        })
      }
      if (url === '/api/v1/commands/chats/chat-b/scriptstate') {
        return jsonResponse({
          revision: 16,
          event: {
            type: 'chat.scriptstate.updated',
            revision: 16,
            resource: 'chat',
            id: 'chat-b',
          },
          chatId: 'chat-b',
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/generation-settings') {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
        return jsonResponse({
          revision: 19,
          event: {
            type: 'chat.updated',
            revision: 19,
            resource: 'characterRow',
            id: 'chat-a',
            parentId: 'char-a',
          },
          chatId: 'chat-a',
          characterId: 'char-a',
          certificate: 'chat-generation-settings-sparse-v1',
          patchedKeys: Object.keys(body.patch ?? {}).sort(),
          deletedKeys: [...(body.deleteKeys ?? [])].sort(),
          sidebarTogglePatchedKeys: Object.keys(body.patch?.sidebarToggles ?? {}).sort(),
          sidebarToggleDeletedKeys: [...(body.sidebarToggleDeleteKeys ?? [])].sort(),
          prunedSidebarToggleKeys: [],
        })
      }
      if (url === '/api/v1/commands/chats/chat-a/messages') {
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
        return jsonResponse({
          revision: 17,
          event: {
            type: 'message.appended',
            revision: 17,
            resource: 'message',
            id: body.message?.chatId,
            parentId: 'chat-a',
          },
          chatId: 'chat-a',
          messageId: body.message?.chatId,
        })
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

export function stubFailingCommandFetch(input: {
  matches: (url: string, init: RequestInit) => boolean
  onCommand?: (url: string, init: RequestInit) => void
}): CapturedFetch[] {
  const calls: CapturedFetch[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (requestInput: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string> | undefined
      const url = String(requestInput)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers?.['risu-auth'] ?? null,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      })

      if (url === '/api/v1/bootstrap') return jsonResponse({ revision: 10 })
      if (input.matches(url, init)) {
        input.onCommand?.(url, init)
        return jsonResponse({ error: 'nope' }, 500)
      }
      return jsonResponse({ error: `unexpected ${url}` }, 404)
    }) as unknown as typeof fetch,
  )
  return calls
}

export async function waitForCallCount(calls: CapturedFetch[], expected: number): Promise<void> {
  await vi.waitFor(() => expect(calls).toHaveLength(expected), { interval: 1 })
}

export function jsonClone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

export async function prepareDurableOutbox(suffix: string, managed = false): Promise<void> {
  vi.stubGlobal('indexedDB', new IDBFactory())
  resetPendingMutationOutboxForTests()
  await preparePendingMutationOutbox({
    writerSessionId: managed ? 'draft-test-session' : `writer-chat-structure-${suffix}`,
    writerEpoch: managed ? 1 : 51,
    databaseLineage: managed ? 'draft-test-lineage' : `lineage-chat-structure-${suffix}`,
    requestedWriterWasActive: true,
  })
  setCachedServerCommandRevision(10)
}

export async function clearDurableOutbox(): Promise<void> {
  await clearPendingMutationOutbox()
  resetPendingMutationOutboxForTests()
}

export function setupChatCommandTests(): void {
  beforeEach(() => {
    resetClientSessionForTests()
    resetWriterAccessLostForTests()
    writerAccessMocks.lost = false
    writerAccessMocks.report.mockClear()
    clearAppliedServerResourceRevision()
    clearCachedServerCommandRevision()
    resetChatHydration()
    selectedCharID.set(0)
    setDatabaseLite({
      enabledModules: [],
      moduleIntergration: '',
      modules: [],
      currentChar: 0,
      characters: [
        {
          chaId: 'char-a',
          name: 'Character',
          chatPage: 0,
          chats: [
            {
              id: 'chat-a',
              name: 'Chat A',
              folderId: null,
              message: [],
              scriptstate: { $score: '1', $old: 'gone' },
            },
            { id: 'chat-b', name: 'Chat B', folderId: 'folder-a', message: [] },
          ],
          chatFolders: [{ id: 'folder-a', name: 'Folder', folded: false }],
        },
      ],
    } as any)
  })

  afterEach(() => {
    resetClientSessionForTests()
    clearAppliedServerResourceRevision()
    setServerCommandSuccessReconciler(null)
    vi.unstubAllGlobals()
    resetChatHydration()
  })
}
