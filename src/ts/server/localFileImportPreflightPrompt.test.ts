import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ inspect: vi.fn(), confirm: vi.fn(), input: vi.fn(), error: vi.fn(), current: true }))
vi.mock('./localFilePreflight', async (original) => ({
  ...(await original<typeof import('./localFilePreflight')>()),
  inspectLocalImport: state.inspect,
}))
vi.mock('../clientWriteOperation', () => ({ isClientWriteOperationCurrent: () => state.current }))
vi.mock('../alert', () => ({
  alertClear: vi.fn(),
  alertConfirm: state.confirm,
  alertInput: state.input,
  alertError: state.error,
}))
vi.mock('src/lang', () => ({
  language: {
    inputCardPassword: 'password',
    lowLevelAccessConfirm: 'low level',
    errors: { wrongPassword: 'wrong password' },
  },
}))
import { ImportPasswordRequired, ImportPasswordInvalid } from './localFilePreflight'
import { prepareLocalFileImport } from './localFileImportPreflightPrompt'
beforeEach(() => {
  vi.resetAllMocks()
  state.current = true
})
describe('pre-upload import prompts', () => {
  it('obtains a password, inspects the decrypted permissions, then confirms before returning upload options', async () => {
    state.inspect.mockRejectedValueOnce(new ImportPasswordRequired()).mockResolvedValueOnce({ lowLevelAccess: true })
    state.input.mockResolvedValue('secret')
    state.confirm.mockResolvedValue(true)
    const file = new Blob()
    await expect(prepareLocalFileImport(file, 'bot.png', 'character', 1)).resolves.toEqual({
      stream: true,
      password: 'secret',
      allowLowLevelAccess: true,
    })
    expect(state.inspect).toHaveBeenLastCalledWith(file, 'bot.png', 'character', 'secret')
    expect(state.input.mock.invocationCallOrder[0]).toBeLessThan(state.confirm.mock.invocationCallOrder[0])
  })
  it('cancels without upload options when consent is declined', async () => {
    state.inspect.mockResolvedValue({ lowLevelAccess: true })
    state.confirm.mockResolvedValue(false)
    await expect(prepareLocalFileImport(new Blob(), 'bot.json', 'character', 1)).resolves.toBeNull()
  })
  it('does not prompt or upload after writer loss during inspection', async () => {
    state.inspect.mockImplementation(async () => {
      state.current = false
      return { lowLevelAccess: true }
    })
    await expect(prepareLocalFileImport(new Blob(), 'bot.json', 'character', 1)).resolves.toBeNull()
    expect(state.confirm).not.toHaveBeenCalled()
  })
  it('rejects a wrong password before returning upload options', async () => {
    state.inspect.mockRejectedValueOnce(new ImportPasswordRequired()).mockRejectedValueOnce(new ImportPasswordInvalid())
    state.input.mockResolvedValue('wrong')
    await expect(prepareLocalFileImport(new Blob(), 'bot.png', 'character', 1)).resolves.toBeNull()
    expect(state.error).toHaveBeenCalledWith('wrong password')
  })
})
