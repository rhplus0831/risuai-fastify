import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetClientSessionForTests } from '../clientSession'
import {
  demoteAndRepromoteForTest,
  setManagedReaderForTest,
  setManagedWriterForTest,
} from '../__tests__/managedClientSession'
import { deleteRequestHistoryRecord, getRequestHistoryRecord, listRequestHistory } from './requestHistory'

const mocks = vi.hoisted(() => ({ auth: vi.fn(async () => 'history-auth') }))
vi.mock('../storage/fastifyStorage', () => ({ getNodeServerProxyAuth: mocks.auth }))

beforeEach(() => {
  resetClientSessionForTests()
  mocks.auth.mockReset().mockResolvedValue('history-auth')
})
afterEach(() => {
  resetClientSessionForTests()
  vi.unstubAllGlobals()
})

it('admits reader history list/detail but denies deletion before auth', async () => {
  setManagedReaderForTest()
  const record = {
    id: 'record',
    startedAt: 1,
    status: 'success',
    source: 'chat',
    responsePreview: 'hello',
    profile: { id: 'profile', role: 'main', sourceKind: 'model-profile', modelId: 'model', requestModel: 'model' },
    response: 'hello',
    prompt: [],
    metadata: {},
  }
  const fetchMock = vi.fn(async (url: string) =>
    Response.json(url.endsWith('/record') ? { record } : { limit: 10, records: [record] }),
  )
  vi.stubGlobal('fetch', fetchMock)
  await expect(deleteRequestHistoryRecord('record')).resolves.toEqual({
    status: 'error',
    error: 'client_write_access_required',
  })
  expect(mocks.auth).not.toHaveBeenCalled()
  expect((await listRequestHistory()).status).toBe('ok')
  expect((await getRequestHistoryRecord('record')).status).toBe('ok')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does not delete history after authentication crosses demotion and repromotion', async () => {
  setManagedWriterForTest()
  let release!: (auth: string) => void
  mocks.auth.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const pending = deleteRequestHistoryRecord('record')
  demoteAndRepromoteForTest()
  release('old-auth')
  await expect(pending).resolves.toEqual({ status: 'error', error: 'client_write_operation_stale' })
  expect(fetchMock).not.toHaveBeenCalled()
})
