import { chatBodyMocks, setupChatBody, flushComponentPromises } from './ChatBody.testSupport'
import { demoteClientSession } from 'src/ts/clientSession'
import { enterClientWriter, repromoteClientWriter } from 'src/ts/__tests__/clientSession'
import { describe, expect, it } from 'vitest'

describe('ChatBody finalized HTML reuse', () => {
  const body = setupChatBody()

  it('updates cached controls on writer loss and reuses the writable body on restoration', async () => {
    enterClientWriter()
    body.mount({
      msgDisplay: '<button risu-trigger="example">Run action</button>',
      allowClientTranslation: false,
    })
    await flushComponentPromises()
    const button = () => body.target.querySelector('button')!
    expect(button().textContent).toBe('Run action')
    expect(button().disabled).toBe(false)
    expect(button().hasAttribute('aria-disabled')).toBe(false)

    demoteClientSession()
    await flushComponentPromises()
    expect(button().textContent).toBe('Run action')
    expect(button().disabled).toBe(true)
    expect(button().getAttribute('aria-disabled')).toBe('true')
    expect(button().getAttribute('title')).toBeTruthy()

    chatBodyMocks.trimMarkdown.mockClear()
    chatBodyMocks.addMetadataToElement.mockClear()
    repromoteClientWriter()
    await flushComponentPromises()
    expect(button().textContent).toBe('Run action')
    expect(button().disabled).toBe(false)
    expect(button().hasAttribute('aria-disabled')).toBe(false)
    expect(chatBodyMocks.trimMarkdown).not.toHaveBeenCalled()
    expect(chatBodyMocks.addMetadataToElement).not.toHaveBeenCalled()
  })
})
