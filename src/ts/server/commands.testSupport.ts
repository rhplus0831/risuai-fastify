// Import this module before command runtime imports so its transport mocks are installed first.
// Shared lifecycle and transport fixtures only; domain snapshots and expected receipts stay in their suites.
import { afterEach, beforeEach, vi } from 'vitest'
import { installConnectedWriterSessionId, resetWriterAccessLostForTests } from './activeWriterSession'
import { recordStartupMilestone, resetStartupReadinessForTests } from '../startupReadiness'
import {
  clearAppliedServerResourceRevision,
  clearCachedServerCommandRevision,
  setServerCommandConflictGapHandler,
  setServerCommandSuccessReconciler,
} from './commands'

vi.mock('../platform', () => ({ isFastifyServer: true }))

vi.mock('../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: async () => 'test-auth-token',
}))

export interface CapturedFetch {
  url: string
  method: string
  authHeader: string | null
  writerSessionHeader: string | null
  contentType: string | null
  body: unknown
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

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function makeCommandFetch(bodyForUrl: (url: string, init: RequestInit) => unknown): {
  calls: CapturedFetch[]
  fetch: typeof fetch
} {
  const calls: CapturedFetch[] = []
  return {
    calls,
    fetch: vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      const rawBody = typeof init.body === 'string' ? JSON.parse(init.body) : null
      const url = String(input)
      calls.push({
        url,
        method: init.method ?? 'GET',
        authHeader: headers.get('risu-auth'),
        writerSessionHeader: headers.get('risu-writer-session'),
        contentType: headers.get('content-type'),
        body: rawBody,
      })
      const body = bodyForUrl(url, init)
      return body instanceof Response ? body : jsonResponse(body)
    }) as unknown as typeof fetch,
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

beforeEach(() => {
  installConnectedWriterSessionId('command-test-writer')
  resetStartupReadinessForTests()
  for (const milestone of ['entry', 'shell-mounted', 'reader-ready', 'writer-ready'] as const) {
    recordStartupMilestone(milestone)
  }
  resetWriterAccessLostForTests()
  clearAppliedServerResourceRevision()
  clearCachedServerCommandRevision()
  setServerCommandConflictGapHandler(null)
  setServerCommandSuccessReconciler(null)
})

afterEach(() => {
  resetStartupReadinessForTests()
  resetWriterAccessLostForTests()
  vi.unstubAllGlobals()
})
