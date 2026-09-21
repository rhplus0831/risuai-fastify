import { jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  appendMessageCommand,
  deleteMessageCommand,
  persistGenerationResultCommand,
  replaceTailMessagesCommand,
  replaceMessagesCommand,
  truncateMessagesCommand,
  updateMessageCommand,
  setServerCommandSuccessReconciler,
} from './commands'

describe('message command adapters', () => {
  it('dispatches message history commands through typed helpers', async () => {
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch((url) => {
      if (url.endsWith('/messages/truncate')) {
        return {
          revision: 4,
          event: { type: 'message.truncated', revision: 4, resource: 'message', parentId: 'chat-a' },
          chatId: 'chat-a',
          afterMessageId: 'msg-a',
          removedCount: 2,
        }
      }
      if (url.endsWith('/messages/tail')) {
        return {
          revision: 5,
          event: { type: 'messages.replaced', revision: 5, resource: 'message', parentId: 'chat-a' },
          chatId: 'chat-a',
          afterMessageId: 'msg-a',
          replacedCount: 1,
        }
      }
      if (url.endsWith('/chats/chat-a/messages')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'PUT'
          ? {
              revision: 6,
              event: { type: 'messages.replaced', revision: 6, resource: 'message', parentId: 'chat-a' },
              chatId: 'chat-a',
            }
          : {
              revision: 1,
              event: {
                type: 'message.appended',
                revision: 1,
                resource: 'message',
                id: 'msg-a',
                parentId: 'chat-a',
              },
              chatId: 'chat-a',
              messageId: 'msg-a',
            }
      }
      if (url.endsWith('/messages/msg-a')) {
        const method = commandFetch.calls.at(-1)?.method
        return method === 'DELETE'
          ? {
              revision: 3,
              event: {
                type: 'message.deleted',
                revision: 3,
                resource: 'message',
                id: 'msg-a',
                parentId: 'chat-a',
              },
              chatId: 'chat-a',
              messageId: 'msg-a',
            }
          : {
              revision: 2,
              event: {
                type: 'message.updated',
                revision: 2,
                resource: 'message',
                id: 'msg-a',
                parentId: 'chat-a',
              },
              chatId: 'chat-a',
              messageId: 'msg-a',
            }
      }
      if (url.endsWith('/chats/chat-a/generation-result')) {
        return {
          revision: 7,
          event: {
            type: 'generation.persisted',
            revision: 7,
            resource: 'generation',
            id: 'gen-a',
          },
          chatId: 'chat-a',
          messageId: 'gen-a',
        }
      }
      return jsonResponse({ error: 'unexpected' }, 500)
    })
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      appendMessageCommand({
        baseRevision: 0,
        chatId: 'chat-a',
        message: { role: 'user', data: 'hello', chatId: 'msg-a' },
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 1, messageId: 'msg-a' })

    await expect(
      updateMessageCommand({
        baseRevision: 1,
        messageId: 'msg-a',
        patch: { data: 'edited', disabled: true },
        expectedData: 'hello',
        expectedChatId: 'chat-a',
        expectedGenerationId: 'gen-a',
        optimisticChatId: 'chat-a',
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, messageId: 'msg-a' })

    await expect(
      deleteMessageCommand({
        baseRevision: 2,
        messageId: 'msg-a',
        optimisticChatId: 'chat-a',
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 3, messageId: 'msg-a' })

    await expect(
      truncateMessagesCommand({
        baseRevision: 3,
        chatId: 'chat-a',
        afterMessageId: 'msg-a',
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 4, removedCount: 2 })

    await expect(
      replaceTailMessagesCommand({
        baseRevision: 4,
        chatId: 'chat-a',
        afterMessageId: 'msg-a',
        messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 5, chatId: 'chat-a', replacedCount: 1 })

    await expect(
      replaceMessagesCommand({
        baseRevision: 5,
        chatId: 'chat-a',
        messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        optimisticChatBodyProjectionEpoch: 11,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 6, chatId: 'chat-a' })

    await expect(
      persistGenerationResultCommand({
        baseRevision: 6,
        chatId: 'chat-a',
        generationResult: {
          targetMessageId: 'msg-b',
          message: {
            role: 'char',
            data: 'generated',
            chatId: 'gen-a',
            generationInfo: { generationId: 'gen-a' },
            promptInfo: { promptName: 'Preset' },
          },
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 7, messageId: 'gen-a' })

    expect(observedEffects).toEqual([
      {
        kind: 'messageMutation',
        operation: 'append',
        chatId: 'chat-a',
        messageId: 'msg-a',
        chatBodyProjectionEpoch: 11,
      },
      {
        kind: 'messageMutation',
        operation: 'update',
        chatId: 'chat-a',
        messageId: 'msg-a',
        chatBodyProjectionEpoch: 11,
      },
      {
        kind: 'messageMutation',
        operation: 'delete',
        chatId: 'chat-a',
        messageId: 'msg-a',
        chatBodyProjectionEpoch: 11,
      },
      { kind: 'messageMutation', operation: 'truncate', chatId: 'chat-a', chatBodyProjectionEpoch: 11 },
      { kind: 'messageMutation', operation: 'replaceTail', chatId: 'chat-a', chatBodyProjectionEpoch: 11 },
      { kind: 'messageMutation', operation: 'replaceAll', chatId: 'chat-a', chatBodyProjectionEpoch: 11 },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/chats/chat-a/messages',
        method: 'POST',
        body: {
          baseRevision: 0,
          message: { role: 'user', data: 'hello', chatId: 'msg-a' },
        },
      },
      {
        url: '/api/v1/commands/messages/msg-a',
        method: 'PATCH',
        body: {
          baseRevision: 1,
          patch: { data: 'edited', disabled: true },
          expectedData: 'hello',
          expectedChatId: 'chat-a',
          expectedGenerationId: 'gen-a',
        },
      },
      {
        url: '/api/v1/commands/messages/msg-a',
        method: 'DELETE',
        body: {
          baseRevision: 2,
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages/truncate',
        method: 'POST',
        body: {
          baseRevision: 3,
          afterMessageId: 'msg-a',
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages/tail',
        method: 'POST',
        body: {
          baseRevision: 4,
          afterMessageId: 'msg-a',
          messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/messages',
        method: 'PUT',
        body: {
          baseRevision: 5,
          messages: [{ role: 'char', data: 'replacement', chatId: 'msg-b' }],
        },
      },
      {
        url: '/api/v1/commands/chats/chat-a/generation-result',
        method: 'POST',
        body: {
          baseRevision: 6,
          generationResult: {
            targetMessageId: 'msg-b',
            message: {
              role: 'char',
              data: 'generated',
              chatId: 'gen-a',
              generationInfo: { generationId: 'gen-a' },
              promptInfo: { promptName: 'Preset' },
            },
          },
        },
      },
    ])
  })
})
