import { setupChatTests, chatMocks, target, makeRows, seedDatabase, settle, mountHarness } from './Chat.testSupport'
import { tick } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import { dispatchUpdateMessageScoped } from 'src/ts/chatCommands'

setupChatTests()

describe('Chat editing', () => {
  it('does not dispatch a message update when edit mode closes without changes', async () => {
    const rows = makeRows(1)
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    mountHarness(rows)
    await settle()

    target.querySelector<HTMLButtonElement>('button[aria-label="edit"]')?.click()
    await settle()

    const textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    expect(textarea?.value).toBe('visible message 0')

    vi.mocked(dispatchUpdateMessageScoped).mockClear()
    target.querySelector<HTMLButtonElement>('button[aria-label="save"]')?.click()
    await settle()

    expect(target.querySelector('.message-edit-area')).toBeNull()
    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
    expect(getResourceDatabase().characters[0].chats[0].message[0].data).toBe('visible message 0')
  })

  it('dispatches a message update when edited text actually changes', async () => {
    const rows = makeRows(1)
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    mountHarness(rows)
    await settle()

    target.querySelector<HTMLButtonElement>('button[aria-label="edit"]')?.click()
    await settle()

    const textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    expect(textarea).not.toBeNull()
    textarea!.value = 'changed message'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    vi.mocked(dispatchUpdateMessageScoped).mockClear()
    target.querySelector<HTMLButtonElement>('button[aria-label="save"]')?.click()
    await settle()

    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith('row-0', { data: 'changed message' }, expect.anything())
    expect(getResourceDatabase().characters[0].chats[0].message[0].data).toBe('visible message 0')
  })

  it('saves an inline message edit when long press closes the editor', async () => {
    const rows = makeRows(1)
    seedDatabase(rows)
    chatMocks.canUseServerCommands.mockReturnValue(true)
    mountHarness(rows)
    await settle()

    target.querySelector<HTMLButtonElement>('button[aria-label="edit"]')?.click()
    await settle()

    const textarea = target.querySelector<HTMLTextAreaElement>('.message-edit-area')
    expect(textarea).not.toBeNull()
    textarea!.value = 'long-press edit'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    vi.mocked(dispatchUpdateMessageScoped).mockClear()
    textarea!.dispatchEvent(new MouseEvent('test-longpress', { bubbles: true }))
    await settle()

    expect(target.querySelector('.message-edit-area')).toBeNull()
    expect(dispatchUpdateMessageScoped).toHaveBeenCalledWith('row-0', { data: 'long-press edit' }, expect.anything())
  })

  it('keeps interactive message content out of click-to-edit mode', async () => {
    const rows = makeRows(1)
    seedDatabase(rows)
    withTestDatabaseWrite(() => {
      getResourceDatabase().clickToEdit = true
    })
    mountHarness(rows)
    await settle()

    const messageBody = target.querySelector<HTMLElement>('.chattext')
    expect(messageBody).not.toBeNull()
    const interactiveButton = document.createElement('button')
    interactiveButton.type = 'button'
    interactiveButton.textContent = 'message action'
    messageBody!.appendChild(interactiveButton)

    interactiveButton.click()
    await settle()
    expect(target.querySelector('.message-edit-area')).toBeNull()

    target.querySelector<HTMLElement>('.chattext .risu-chat')?.click()
    await settle()
    expect(target.querySelector('.message-edit-area')).not.toBeNull()
  })
})
