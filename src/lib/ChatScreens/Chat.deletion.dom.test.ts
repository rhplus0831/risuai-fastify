import {
  setupChatTests,
  chatMocks,
  languageMocks,
  target,
  makeRows,
  deferred,
  seedDatabase,
  settle,
  mountHarness,
} from './Chat.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import { dispatchDeleteMessageScoped } from 'src/ts/chatCommands'

setupChatTests()

describe('Chat deletion', () => {
  it('deletes the confirmed message by stable id after the live transcript shifts', async () => {
    const rows = makeRows(3)
    const confirmation = deferred<boolean>()
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    chatMocks.alertConfirm.mockReturnValueOnce(confirmation.promise)
    withTestDatabaseWrite(() => {
      getResourceDatabase().askRemoval = true
    })
    mountHarness(rows)
    await settle()

    const removeButtons = target.querySelectorAll<HTMLButtonElement>('button[aria-label="remove"]')
    removeButtons[1]?.click()
    await settle()
    expect(chatMocks.alertConfirm).toHaveBeenCalledWith(languageMocks.language.removeChat)

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chats[0].message.unshift({
        chatId: 'newer-row',
        data: 'newer message',
        role: 'user',
      })
    })
    confirmation.resolve(true)
    await settle()

    expect(dispatchDeleteMessageScoped).toHaveBeenCalledWith('row-1', expect.anything())
    expect(dispatchDeleteMessageScoped).not.toHaveBeenCalledWith('row-0', expect.anything())
  })

  it('surfaces a failed transcript-row deletion', async () => {
    const rows = makeRows(1)
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    vi.mocked(dispatchDeleteMessageScoped).mockResolvedValueOnce({
      status: 'failed',
      error: 'delete rejected',
    })
    mountHarness(rows)
    await settle()

    target.querySelector<HTMLButtonElement>('button[aria-label="remove"]')?.click()
    await settle()

    expect(chatMocks.alertError).toHaveBeenCalledWith(languageMocks.language.messageMutationFailed)
    expect(target.textContent).toContain(languageMocks.language.messageMutationFailed)
  })

  it('surfaces a queued transcript-row deletion while its settlement is pending', async () => {
    const rows = makeRows(1)
    const settlement = deferred<{ status: 'accepted' }>()
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    vi.mocked(dispatchDeleteMessageScoped).mockResolvedValueOnce({
      status: 'queued',
      mutationId: 'queued-delete',
      settlement: settlement.promise,
    })
    mountHarness(rows)
    await settle()

    target.querySelector<HTMLButtonElement>('button[aria-label="remove"]')?.click()
    await settle()

    expect(chatMocks.alertNormal).toHaveBeenCalledWith(languageMocks.language.messageMutationQueued)
    expect(target.textContent).toContain(languageMocks.language.messageMutationQueued)

    settlement.resolve({ status: 'accepted' })
    await settle()
    expect(target.textContent).not.toContain(languageMocks.language.messageMutationQueued)
  })

  it('keeps the same deletion target across the instant-remove confirmation', async () => {
    const rows = makeRows(3)
    const instantConfirmation = deferred<boolean>()
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    chatMocks.alertConfirm.mockResolvedValueOnce(true).mockReturnValueOnce(instantConfirmation.promise)
    withTestDatabaseWrite(() => {
      getResourceDatabase().askRemoval = true
      getResourceDatabase().instantRemove = true
    })
    mountHarness(rows)
    await settle()

    const removeButtons = target.querySelectorAll<HTMLButtonElement>('button[aria-label="remove"]')
    removeButtons[1]?.click()
    await settle()
    expect(chatMocks.alertConfirm).toHaveBeenCalledTimes(2)

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chats[0].message.splice(0, 1)
    })
    instantConfirmation.resolve(true)
    await settle()

    expect(dispatchDeleteMessageScoped).toHaveBeenCalledWith('row-1', expect.anything())
    expect(dispatchDeleteMessageScoped).not.toHaveBeenCalledWith('row-2', expect.anything())
  })

  it('does not delete a replacement row when the confirmed message disappeared', async () => {
    const rows = makeRows(3)
    const confirmation = deferred<boolean>()
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    chatMocks.alertConfirm.mockReturnValueOnce(confirmation.promise)
    withTestDatabaseWrite(() => {
      getResourceDatabase().askRemoval = true
    })
    mountHarness(rows)
    await settle()

    const removeButtons = target.querySelectorAll<HTMLButtonElement>('button[aria-label="remove"]')
    removeButtons[1]?.click()
    await settle()

    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chats[0].message.splice(1, 1)
    })
    confirmation.resolve(true)
    await settle()

    expect(dispatchDeleteMessageScoped).not.toHaveBeenCalled()
  })
})
