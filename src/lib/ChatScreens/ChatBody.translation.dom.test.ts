import {
  chatBodyMocks,
  setupChatBody,
  flushComponentPromises,
  setChatBodyDatabase,
  deferred,
} from './ChatBody.testSupport'
import { demoteClientSession } from 'src/ts/clientSession'
import { enterClientWriter, repromoteClientWriter } from 'src/ts/__tests__/clientSession'
import { describe, expect, it, vi } from 'vitest'

describe('ChatBody translation', () => {
  const body = setupChatBody()

  it.each([false, true])(
    'skips automatic and requested client translation for read-only display (managed=%s)',
    async (managed) => {
      chatBodyMocks.ParseMarkdown.mockImplementation(async (text: string) => text)
      if (managed) {
        enterClientWriter()
        demoteClientSession()
      }
      body.mount({
        msgDisplay: `readonly source ${managed}`,
        translated: true,
        retranslate: true,
        readOnly: !managed,
      })
      await flushComponentPromises()
      expect(chatBodyMocks.translateHTML).not.toHaveBeenCalled()
      expect(chatBodyMocks.getLLMCache).not.toHaveBeenCalled()
      expect(body.target.textContent).toBe(`readonly source ${managed}`)
      expect((chatBodyMocks.ParseMarkdown.mock.calls[0] as unknown[])?.[5]).toMatchObject({ readOnly: true })
    },
  )

  it('does not start delayed client translation after demotion and promotion', async () => {
    setChatBodyDatabase({ translateBeforeHTMLFormatting: true, translatorType: 'llm' })
    enterClientWriter()
    const delay = deferred<void>()
    chatBodyMocks.sleep.mockReturnValueOnce(delay.promise)
    body.mount({
      msgDisplay: 'delayed writer translation',
      translated: true,
      retranslate: true,
    })
    await flushComponentPromises()
    expect(chatBodyMocks.sleep).toHaveBeenCalledOnce()
    demoteClientSession()
    repromoteClientWriter()
    delay.resolve()
    await flushComponentPromises()
    expect(chatBodyMocks.translateHTML).not.toHaveBeenCalled()
  })

  it('surfaces translateHTML failure once without retrying the full pipeline', async () => {
    chatBodyMocks.ParseMarkdown.mockResolvedValue('marked:source message')
    chatBodyMocks.translateHTML.mockRejectedValue(new Error('translator unavailable'))

    body.mount({
      msgDisplay: 'source message',
      translated: true,
    })
    await flushComponentPromises()

    expect(chatBodyMocks.translateHTML).toHaveBeenCalledTimes(1)
    expect(chatBodyMocks.alertError).toHaveBeenCalledTimes(1)
    expect(chatBodyMocks.alertError.mock.calls[0][0]).toContain('translator unavailable')
    expect(body.target.textContent).toContain('source message')
  })

  it('retries parser failures against already translated HTML only', async () => {
    setChatBodyDatabase({
      translateBeforeHTMLFormatting: true,
      translatorType: 'llm',
    })
    const parseInputs: string[] = []
    chatBodyMocks.translateHTML.mockResolvedValue('translated html')
    chatBodyMocks.ParseMarkdown.mockImplementation(async (text: string) => {
      parseInputs.push(text)
      if (parseInputs.length === 1) {
        throw new Error(`parse failed ${parseInputs.length}`)
      }
      return `parsed:${text}`
    })

    body.mount({
      msgDisplay: 'source message',
      translated: true,
    })
    await flushComponentPromises()

    expect(chatBodyMocks.translateHTML).toHaveBeenCalledTimes(1)
    expect(parseInputs.length).toBeGreaterThan(1)
    expect(new Set(parseInputs)).toEqual(new Set(['translated html']))
    expect(chatBodyMocks.alertError).not.toHaveBeenCalled()
    expect(body.target.textContent).toContain('parsed:translated html')
  })

  it('stops retrying persistent parser failures and displays source without translating again', async () => {
    setChatBodyDatabase({ translateBeforeHTMLFormatting: true, translatorType: 'llm' })
    chatBodyMocks.translateHTML.mockResolvedValue('translated html')
    chatBodyMocks.ParseMarkdown.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          setTimeout(() => reject(new Error('parser unavailable')), 1)
        }),
    )
    const settled = vi.fn()
    body.mount({ msgDisplay: 'readable source', translated: true, onInitialDisplayParseSettled: settled })
    await flushComponentPromises()
    await vi.runAllTimersAsync()
    await flushComponentPromises()

    expect(chatBodyMocks.translateHTML).toHaveBeenCalledOnce()
    expect(chatBodyMocks.alertError).toHaveBeenCalledOnce()
    expect(chatBodyMocks.alertError.mock.calls[0][0]).toContain('parser unavailable')
    expect(body.target.textContent).toBe('readable source')
    expect(settled).toHaveBeenCalledOnce()
    const attempts = chatBodyMocks.ParseMarkdown.mock.calls.length
    await vi.runAllTimersAsync()
    await flushComponentPromises()
    expect(chatBodyMocks.ParseMarkdown).toHaveBeenCalledTimes(attempts)
  })

  it('skips client-path auto-translation for user rows in active-chat bot-only mode', async () => {
    chatBodyMocks.getCurrentChat.mockReturnValue({
      id: 'chat-a',
      autoTranslate: true,
      autoTranslateBotOnly: true,
    } as never)
    body.mount({
      idx: -1,
      msgDisplay: 'preview user message',
      role: 'user',
    })
    await flushComponentPromises()

    expect(chatBodyMocks.translateHTML).not.toHaveBeenCalled()
    expect(body.target.textContent).toContain('preview user message')
  })

  it('fails closed for automatic translation when the active chat owner is missing', async () => {
    chatBodyMocks.chatMetadataOwner = undefined
    body.mount({
      idx: -1,
      msgDisplay: 'ownerless preview message',
    })
    await flushComponentPromises()

    expect(chatBodyMocks.translateHTML).not.toHaveBeenCalled()
    expect(body.target.textContent).toContain('ownerless preview message')
  })
})
