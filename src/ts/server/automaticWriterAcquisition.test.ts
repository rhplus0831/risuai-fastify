import { beforeEach, expect, it, vi } from 'vitest'
import { shouldAutoAcquireDisconnectedWriter } from './automaticWriterAcquisition'
const api = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('./resourceReads', () => ({ fetchServerSettingsGroup: api.read }))
beforeEach(() => vi.resetAllMocks())
it.each([undefined, true, false])('uses the default-on preference (%s)', async (value) => {
  api.read.mockResolvedValue({ status: 'ok', settings: { autoAcquireDisconnectedWriter: value } })
  expect(await shouldAutoAcquireDisconnectedWriter()).toBe(value !== false)
  expect(api.read).toHaveBeenCalledExactlyOnceWith('sidebar', undefined)
})
it('does not acquire when the preference cannot be read', async () => {
  api.read.mockResolvedValue({ status: 'unavailable' })
  expect(await shouldAutoAcquireDisconnectedWriter()).toBe(false)
})
