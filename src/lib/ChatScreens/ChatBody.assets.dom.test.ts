import { chatBodyMocks, setupChatBody, flushComponentPromises, setChatBodyDatabase } from './ChatBody.testSupport'
import { createChatReadOwners } from './chatReadOwners.svelte'
import { CHAT_READ_OWNERS_CONTEXT } from './chatReadOwnersContext'
import type { character as Character } from 'src/ts/storage/database.svelte'
import { describe, expect, it } from 'vitest'

describe('ChatBody assets', () => {
  const body = setupChatBody()

  it('resolves rendered image assets from the selected character and chat owners', async () => {
    setChatBodyDatabase({ newImageHandlingBeta: true })
    const owner = {
      additionalAssets: [['portrait.png', 'owner-asset-id', 'png']],
      prebuiltAssetStyle: 'contain',
      chaId: 'char-a',
      chatPage: 0,
      chats: [chatBodyMocks.getCurrentChat()],
    }
    chatBodyMocks.getSelectedCharacterOwner.mockReturnValue(owner as never)
    chatBodyMocks.getFileSrc.mockResolvedValue('/api/v1/assets/owner-asset-id')
    const bodyRoot = document.createElement('span')
    bodyRoot.innerHTML = '<img src="portrait.png">'
    body.target.appendChild(bodyRoot)

    body.mount({
      bodyRoot,
      msgDisplay: 'image owner body',
      allowClientTranslation: false,
    })
    await flushComponentPromises()

    expect(chatBodyMocks.getModuleAssets).toHaveBeenCalledWith({
      character: owner,
      chat: owner.chats[0],
    })
    expect(chatBodyMocks.getFileSrc).toHaveBeenCalledWith('owner-asset-id')
    expect(bodyRoot.querySelector('img')?.getAttribute('src')).toBe('/api/v1/assets/owner-asset-id')
    expect(bodyRoot.querySelector('img')?.classList.contains('root-loaded-image-contain')).toBe(true)
  })

  it('passes the local reader chat into parser and confirmed image-module reads while canonical owners stay selected', async () => {
    setChatBodyDatabase({ newImageHandlingBeta: true })
    const local = {
      chaId: 'reader-character',
      chatPage: 0,
      additionalAssets: [],
      prebuiltAssetStyle: 'contain',
      chats: [
        { id: 'reader-canonical-chat', message: [], modules: ['canonical-module'] },
        { id: 'reader-local-chat', message: [], modules: ['reader-module'] },
      ],
    } as Character
    const localChat = local.chats[1]
    const owners = createChatReadOwners(
      { status: 'ready', currentChar: 0, characters: [local] },
      () => [],
      () => ({ characterId: local.chaId, chatId: localChat.id! }),
      () => ({
        newImageHandlingBeta: true,
        modules: [
          {
            id: 'reader-module',
            name: 'Reader module',
            description: '',
            assets: [['portrait.png', 'reader-asset-id', 'png']],
          },
          {
            id: 'canonical-module',
            name: 'Writer module',
            description: '',
            assets: [['portrait.png', 'writer-asset-id', 'png']],
          },
        ],
      }),
    )
    chatBodyMocks.getFileSrc.mockResolvedValue('/api/v1/assets/reader-asset-id')
    const bodyRoot = document.createElement('span')
    bodyRoot.innerHTML = '<img src="portrait.png">'
    body.target.appendChild(bodyRoot)
    body.mount(
      {
        character: local.chaId,
        chatId: localChat.id,
        messageId: 'same-message-id',
        bodyRoot,
        msgDisplay: 'local scoped body',
        readOnly: true,
      },
      new Map([[CHAT_READ_OWNERS_CONTEXT, owners]]),
    )
    await flushComponentPromises()
    expect(chatBodyMocks.getModuleAssets).not.toHaveBeenCalled()
    expect(chatBodyMocks.getFileSrc).not.toHaveBeenCalledWith('writer-asset-id')
    expect(chatBodyMocks.getFileSrc).toHaveBeenCalledWith('reader-asset-id')
    expect(bodyRoot.querySelector('img')?.getAttribute('src')).toBe('/api/v1/assets/reader-asset-id')
    expect((chatBodyMocks.ParseMarkdown.mock.calls[0] as unknown[])[5]).toMatchObject({
      chatId: localChat.id,
      messageId: 'same-message-id',
      readOnly: true,
      readContext: { character: local, chat: localChat },
    })
    expect(chatBodyMocks.translateHTML).not.toHaveBeenCalled()
    expect(local.chatPage).toBe(0)
  })

  it('does not rescan module assets for an already resolved server asset URL', async () => {
    setChatBodyDatabase({ newImageHandlingBeta: true })
    const bodyRoot = document.createElement('span')
    bodyRoot.innerHTML = '<img src="/api/v1/assets/already-resolved">'
    body.target.appendChild(bodyRoot)

    body.mount({
      bodyRoot,
      msgDisplay: 'resolved image body',
      allowClientTranslation: false,
    })
    await flushComponentPromises()

    expect(chatBodyMocks.getModuleAssets).not.toHaveBeenCalled()
    expect(chatBodyMocks.getFileSrc).not.toHaveBeenCalled()
    expect(bodyRoot.querySelector('img')?.getAttribute('src')).toBe('/api/v1/assets/already-resolved')
  })
})
