import {
  setupChatTests,
  chatMocks,
  target,
  makeRows,
  seedDatabase,
  settle,
  mountHarness,
  VisibleIntersectionObserver,
  setRect,
} from './Chat.testSupport'
import { tick } from 'svelte'
import { describe, expect, it, vi } from 'vitest'
import { getResourceDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'
import { dispatchUpdateMessageScoped } from 'src/ts/chatCommands'

setupChatTests()

describe('Chat partial editing', () => {
  it('drops partial edit saves when the live source data changed while the modal was open', async () => {
    stubPartialEditEnvironment()

    const rows = makeRows(1)
    chatMocks.risuChatParser.mockImplementation((message: string) => message)
    seedDatabase(rows)
    withTestDatabaseWrite(() => {
      getResourceDatabase().enableBlockPartialEdit = true
    })
    mountHarness(rows)
    await settle()

    const { textarea } = await openPartialEditOnFirstBlock()
    textarea!.value = 'stale replacement'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    vi.mocked(dispatchUpdateMessageScoped).mockClear()
    withTestDatabaseWrite(() => {
      getResourceDatabase().characters[0].chats[0].message[0].data = 'newer live data'
    })

    document.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
    await settle()

    expect(dispatchUpdateMessageScoped).not.toHaveBeenCalled()
    expect(getResourceDatabase().characters[0].chats[0].message[0].data).toBe('newer live data')
  })

  function stubPartialEditEnvironment() {
    vi.stubGlobal('IntersectionObserver', VisibleIntersectionObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(1)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  }

  function makeRawTranslation(text: string) {
    return {
      source: 'raw' as const,
      text,
      sourceHash: 'source-hash',
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google' as const,
      settingsHash: 'settings-hash',
      updatedAt: 1,
    }
  }

  async function openPartialEditOnFirstBlock() {
    const bodyRoot = target.querySelector<HTMLElement>('.chattext')
    const block = target.querySelector<HTMLElement>('.chattext .risu-chat')
    expect(bodyRoot).not.toBeNull()
    expect(block).not.toBeNull()
    setRect(bodyRoot!, 20, 80, 260, 60)
    setRect(block!, 20, 80, 260, 60)
    vi.spyOn(document, 'elementFromPoint').mockImplementation((x: number, y: number) => {
      const rect = block!.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return block
      }
      return null
    })

    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 100, bubbles: true }))
    await settle()
    document.querySelector<HTMLButtonElement>('.partial-edit-btn-edit')?.click()
    await settle()

    const textarea = document.querySelector<HTMLTextAreaElement>('.partial-edit-textarea')
    expect(textarea).not.toBeNull()
    return { block: block!, textarea: textarea! }
  }

  it('routes translation-view partial edits to the persisted translation and keeps the original', async () => {
    stubPartialEditEnvironment()

    const rows = makeRows(1)
    chatMocks.risuChatParser.mockImplementation((message: string) => message)
    seedDatabase(rows)
    withTestDatabaseWrite(() => {
      const db = getResourceDatabase()
      db.enableBlockPartialEdit = true
      db.translator = 'ko'
      db.translatorType = 'google'
      db.characters[0].chats[0].autoTranslate = true
      db.characters[0].chats[0].message[0].translation = makeRawTranslation('translated body line')
    })
    mountHarness(rows)
    await settle()

    const { block, textarea } = await openPartialEditOnFirstBlock()
    expect(block.textContent).toContain('translated body line')
    expect(textarea.value).toBe('translated body line')

    textarea.value = 'polished translation line'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    vi.mocked(dispatchUpdateMessageScoped).mockClear()
    document.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
    await settle()

    const liveMessage = getResourceDatabase().characters[0].chats[0].message[0]
    expect(liveMessage.data).toBe('visible message 0')
    expect(liveMessage.translation?.text).toBe('polished translation line')

    const call = vi.mocked(dispatchUpdateMessageScoped).mock.calls.at(-1)
    expect(call?.[0]).toBe('row-0')
    expect(call?.[1]).toMatchObject({
      translation: { source: 'raw', text: 'polished translation line' },
    })
    expect(call?.[1]).not.toHaveProperty('data')
  })

  it('invalidates a stale translation when an original-layer partial edit saves', async () => {
    stubPartialEditEnvironment()
    chatMocks.canUseServerCommands.mockReturnValue(true)

    const rows = makeRows(1)
    chatMocks.risuChatParser.mockImplementation((message: string) => message)
    seedDatabase(rows)
    withTestDatabaseWrite(() => {
      const db = getResourceDatabase()
      db.enableBlockPartialEdit = true
      db.characters[0].chats[0].message[0].translation = makeRawTranslation('translated body line')
    })
    mountHarness(rows)
    await settle()

    const { block, textarea } = await openPartialEditOnFirstBlock()
    expect(block.textContent).toContain('visible message 0')
    expect(textarea.value).toBe('visible message 0')

    textarea.value = 'visible edited 0'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()

    vi.mocked(dispatchUpdateMessageScoped).mockClear()
    document.querySelector<HTMLButtonElement>('.partial-edit-save-btn')?.click()
    await settle()

    // A source edit must invalidate the raw translation just like the full
    // message editor; otherwise the old translation remains visibly attached
    // to content with a different source hash.
    const call = vi.mocked(dispatchUpdateMessageScoped).mock.calls.at(-1)
    expect(call?.[0]).toBe('row-0')
    expect(call?.[1]).toEqual({ data: 'visible edited 0', translation: null })
  })
})
