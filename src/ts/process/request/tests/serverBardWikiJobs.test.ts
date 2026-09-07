import { resetClientSessionForTests, captureClientSessionGeneration } from '../../../clientSession'
import {
  setManagedWriterForTest,
  setManagedReaderForTest,
  demoteAndRepromoteForTest,
} from '../../../__tests__/managedClientSession'
import { getNodeServerProxyAuth } from '../../../storage/fastifyStorage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../storage/fastifyStorage', () => ({
  getNodeServerProxyAuth: vi.fn(async () => 'test-auth-token'),
}))

vi.mock('../../../server/activeWriterSession', () => ({
  activeWriterSessionHeader: () => ({ 'risu-writer-session': 'writer-session-1' }),
  handleActiveWriterStaleResponse: vi.fn(),
}))

import { cancelServerBardWikiJob, retryServerBardWikiJob } from '../serverBardWikiJobs'
import { handleActiveWriterStaleResponse } from '../../../server/activeWriterSession'

const job = {
  id: 'job/1',
  instanceId: 'instance-1',
  chatId: 'chat-a',
  receiptId: 'receipt-a',
  kind: 'apply_turn' as const,
  status: 'pending' as const,
  errorCode: null,
  errorSummary: null,
  attemptCount: 0,
  maxAttempts: 3,
  progressCurrent: null,
  progressTotal: null,
  nextRunAt: '2026-08-29T00:00:00.000Z',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  resetClientSessionForTests()
  vi.mocked(getNodeServerProxyAuth).mockClear()
  vi.mocked(handleActiveWriterStaleResponse).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server BardWiki operational job adapter', () => {
  it('retries and cancels encoded jobs with writer authority', async () => {
    const calls: Array<{ path: string; method: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push({
          path: String(input),
          method: init.method ?? 'GET',
          headers: init.headers as Record<string, string>,
        })
        return jsonResponse({ job })
      }),
    )

    await expect(retryServerBardWikiJob('job/1')).resolves.toEqual({ status: 'ok', job })
    await expect(cancelServerBardWikiJob('job/1')).resolves.toEqual({ status: 'ok', job })
    expect(calls).toEqual([
      {
        path: '/api/v1/bardwiki/jobs/job%2F1/retry',
        method: 'POST',
        headers: { 'risu-auth': 'test-auth-token', 'risu-writer-session': 'writer-session-1' },
      },
      {
        path: '/api/v1/bardwiki/jobs/job%2F1',
        method: 'DELETE',
        headers: { 'risu-auth': 'test-auth-token', 'risu-writer-session': 'writer-session-1' },
      },
    ])
  })

  it('surfaces server errors and passes stale-writer responses to the authority handler', async () => {
    const response = jsonResponse({ error: 'active_writer_stale' }, 423)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )

    await expect(cancelServerBardWikiJob('job-a')).resolves.toEqual({
      status: 'error',
      error: 'active_writer_stale',
    })
    expect(handleActiveWriterStaleResponse).toHaveBeenCalledWith(
      response,
      { error: 'active_writer_stale' },
      expect.any(Number),
    )
  })

  it('rejects malformed success envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ job: { id: 'partial' } })),
    )

    await expect(retryServerBardWikiJob('job-a')).resolves.toEqual({
      status: 'error',
      error: 'Invalid BardWiki job response',
    })
  })
})

describe('serverBardWikiJobs writer lifecycle', () => {
  it('does not dispatch a Reader mutation', async () => {
    setManagedReaderForTest()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(retryServerBardWikiJob('job-a')).resolves.toMatchObject({ status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not dispatch after auth resumes under a later writer session', async () => {
    setManagedWriterForTest()
    let release!: (auth: string) => void
    vi.mocked(getNodeServerProxyAuth).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const pending = retryServerBardWikiJob('job-a')
    demoteAndRepromoteForTest()
    release('auth')
    await expect(pending).resolves.toMatchObject({ status: 'unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('attributes a delayed 423 to the submitting session', async () => {
    setManagedWriterForTest()
    const sourceGeneration = captureClientSessionGeneration()
    let release!: (response: Response) => void
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const pending = retryServerBardWikiJob('job-a')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    demoteAndRepromoteForTest()
    const response = jsonResponse({ error: 'active_writer_stale' }, 423)
    release(response)
    await pending
    expect(handleActiveWriterStaleResponse).toHaveBeenCalledWith(
      response,
      { error: 'active_writer_stale' },
      sourceGeneration,
    )
  })
})
