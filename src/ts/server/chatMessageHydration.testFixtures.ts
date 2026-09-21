// Shared data builders for the hydration suites; mocks and lifecycle hooks stay with each suite.
import { testDatabaseState } from '../__tests__/resourceDatabaseState'
import { selectedCharID } from '../stores.svelte'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

export function okResult(chatId: string, message: Array<Record<string, unknown>>) {
  return { status: 'ok' as const, revision: 1, chatId, message, alternates: [] }
}

export function okWindowResult(
  chatId: string,
  message: Array<Record<string, unknown>>,
  messageStart: number,
  messageTotal: number,
) {
  return {
    status: 'ok' as const,
    revision: 1,
    chatId,
    message,
    messageStart,
    messageTotal,
    alternates: [],
  }
}

export function okBulkResult(chatIds: string[]) {
  return {
    status: 'ok' as const,
    revision: 1,
    chats: chatIds.map((chatId) => ({
      chatId,
      message: [{ role: 'user', data: chatId, chatId: `m-${chatId}` }],
      alternates: [],
    })),
    missing: [],
  }
}

export function seedTwoStubChats() {
  // Direct stub state: two chats with empty (stubbed) message arrays.
  ;(testDatabaseState as { db: unknown }).db = {
    currentChar: 0,
    characters: [
      {
        chaId: 'char-1',
        chatPage: 0,
        chats: [
          { id: 'chat-1', message: [] },
          { id: 'chat-2', message: [] },
        ],
      },
    ],
  }
  selectedCharID.set(0)
}

export function acceptedSendTarget() {
  return {
    selectedCharID: 0,
    chatPage: 0,
    characterId: 'char-1',
    chatId: 'chat-1',
  }
}

export const db = () =>
  (
    testDatabaseState as {
      db: { characters: Array<{ chatPage: number; chats: Array<{ id: string; message: Array<Record<string, any>> }> }> }
    }
  ).db
