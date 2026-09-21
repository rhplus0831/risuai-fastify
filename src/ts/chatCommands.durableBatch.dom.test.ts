import {
  setupChatCommandTests,
  jsonResponse,
  createDeferred,
  prepareDurableOutbox,
  clearDurableOutbox,
} from './chatCommands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import { type ServerCommandResult } from './server/commands'
import { demoteClientSession } from './clientSession'
import { enterClientWriter, repromoteClientWriter } from './__tests__/clientSession'
import { applyChatMetadataOwnerPatch, applyChatFolderMetadataOwnerPatch } from './server/resourceState.svelte'
import {
  captureChatMetadataPatch,
  captureChatFolderMetadataPatch,
  dispatchChatMetadataPatchWithOutcome,
  dispatchChatFolderMetadataPatchWithOutcome,
  currentChatScopedSnapshot,
  dispatchCharacterOwnedDurableBatch,
  dispatchUpdateMessageScoped,
} from './chatCommands'
import { listPendingMutations, pendingMutationModuleEnabledProjectionTarget } from './server/pendingMutationOutbox'
import { replayPendingMutations } from './server/pendingMutationReplay'
import {
  reapplyRetainedCharacterProjections,
  reapplyRetainedChatBodyProjections,
} from './server/chatRetainedProjection'
import { getResourceDatabase as getDatabase, withTestDatabaseWrite } from 'src/ts/__tests__/resourceDatabaseState'

setupChatCommandTests()

describe('durable chat and folder structure dispatch', () => {
  it('waits for every batch row to persist and reapplies only the latest retained projection', async () => {
    await prepareDurableOutbox('batch-readiness')
    const encryptionGate = createDeferred<void>()
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    let encryptCalls = 0
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        encryptCalls += 1
        if (encryptCalls === 2) await encryptionGate.promise
        return originalEncrypt(algorithm, key, data)
      })
    const commandCalls: string[] = []
    const reapplyFences: boolean[] = []
    const rollback = vi.fn()
    const target = pendingMutationModuleEnabledProjectionTarget('module-a')

    try {
      const batch = dispatchCharacterOwnedDurableBatch('char-a', [
        {
          method: 'PATCH',
          path: '/chats/chat-a',
          body: { patch: { name: 'first' }, select: false },
          projectionTargets: [target],
          command: async () => {
            commandCalls.push('first')
            return { status: 'unavailable' }
          },
          rollback,
          reapply: (isCurrent) => reapplyFences.push(isCurrent(target)),
        },
        {
          method: 'PATCH',
          path: '/chats/chat-a',
          body: { patch: { name: 'second' }, select: false },
          projectionTargets: [target],
          command: async () => {
            commandCalls.push('second')
            return { status: 'unavailable' }
          },
          rollback,
          reapply: (isCurrent) => reapplyFences.push(isCurrent(target)),
        },
      ])

      await vi.waitFor(() => expect(encryptCalls).toBe(2))
      expect(commandCalls).toEqual([])
      encryptionGate.resolve()
      await expect(batch).resolves.toMatchObject({ status: 'retained', acceptedCount: 0 })
      expect(commandCalls).toEqual(['first'])
      expect(reapplyFences).toEqual([false, true])
      expect(rollback).not.toHaveBeenCalled()
    } finally {
      encryptionGate.resolve()
      encryptSpy.mockRestore()
      await clearDurableOutbox()
    }
  })

  it('waits for every exact retained batch handle and fails the aggregate when one is discarded', async () => {
    await prepareDurableOutbox('batch-final-settlement')
    const secondReplayGate = createDeferred<void>()
    const replayPaths: string[] = []
    const firstRollback = vi.fn()
    const secondRollback = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
        const path = url.replace('/api/v1/commands', '')
        if (path === '/chats/chat-a') {
          replayPaths.push(path)
          return jsonResponse({
            revision: 11,
            event: { type: 'chat.updated', revision: 11, resource: 'chat', id: 'chat-a' },
          })
        }
        if (path === '/chats/chat-b') {
          replayPaths.push(path)
          await secondReplayGate.promise
          return jsonResponse({ error: 'invalid retained suffix' }, 400)
        }
        return jsonResponse({ error: `unexpected ${url}` }, 404)
      }) as unknown as typeof fetch,
    )

    try {
      const batch = await dispatchCharacterOwnedDurableBatch('char-a', [
        {
          method: 'PATCH',
          path: '/chats/chat-a',
          body: { patch: { name: 'first' }, select: false },
          command: async () => ({ status: 'unavailable' }),
          rollback: firstRollback,
        },
        {
          method: 'PATCH',
          path: '/chats/chat-b',
          body: { patch: { name: 'second' }, select: false },
          command: async () => ({ status: 'unavailable' }),
          rollback: secondRollback,
        },
      ])
      expect(batch).toMatchObject({
        status: 'retained',
        mutationIds: [expect.any(String), expect.any(String)],
      })
      if (batch.status !== 'retained' || !batch.settlement) throw new Error('Expected a retained batch')

      let aggregateSettled = false
      void batch.settlement.then(() => {
        aggregateSettled = true
      })
      const replay = replayPendingMutations()
      await vi.waitFor(() => expect(replayPaths).toEqual(['/chats/chat-a', '/chats/chat-b']))
      await Promise.resolve()
      expect(aggregateSettled).toBe(false)

      secondReplayGate.resolve()
      await expect(replay).resolves.toMatchObject({ succeeded: 1, discarded: 1, retained: 0 })
      await expect(batch.settlement).resolves.toMatchObject({
        status: 'failed',
        result: { status: 'error', error: 'invalid retained suffix' },
      })
      expect(firstRollback).not.toHaveBeenCalled()
      expect(secondRollback).toHaveBeenCalledOnce()
    } finally {
      secondReplayGate.resolve()
      await clearDurableOutbox()
    }
  })

  it('sends no batch request and rolls back every row when one durable row cannot persist', async () => {
    await prepareDurableOutbox('batch-persistence-failure')
    const originalEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    let encryptCalls = 0
    const encryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        encryptCalls += 1
        if (encryptCalls === 2) throw new Error('simulated suffix persistence failure')
        return originalEncrypt(algorithm, key, data)
      })
    const command = vi.fn(async () => ({ status: 'unavailable' as const }))
    const rollback = vi.fn()

    try {
      await expect(
        dispatchCharacterOwnedDurableBatch('char-a', [
          {
            method: 'PATCH',
            path: '/chats/chat-a',
            body: { patch: { name: 'first' }, select: false },
            command,
            rollback,
          },
          {
            method: 'PATCH',
            path: '/chats/chat-b',
            body: { patch: { name: 'second' }, select: false },
            command,
            rollback,
          },
        ]),
      ).resolves.toMatchObject({
        status: 'failure',
        acceptedCount: 0,
        failure: { status: 'error', reason: 'invalid-request' },
      })
      expect(command).not.toHaveBeenCalled()
      expect(rollback).toHaveBeenCalledTimes(2)
      expect(await listPendingMutations()).toEqual([])
    } finally {
      encryptSpy.mockRestore()
      await clearDurableOutbox()
    }
  })

  it.each(['chat', 'folder', 'message'] as const)(
    'keeps a retained %s result dormant after demotion and repromotion',
    async (kind) => {
      await prepareDurableOutbox(`role-cycle-result-${kind}`, true)
      enterClientWriter()
      const response = createDeferred<Response>()
      const fetchCommand = vi.fn(async () => response.promise)
      vi.stubGlobal('fetch', fetchCommand)
      const chat = () => getDatabase().characters[0].chats[0]
      const folder = () => getDatabase().characters[0].chatFolders[0]
      withTestDatabaseWrite(() => {
        chat().message = [{ role: 'char', data: 'persisted', chatId: 'message-a' }]
      })

      try {
        let mutation: Promise<unknown> | null | undefined
        if (kind === 'chat') {
          const previous = captureChatMetadataPatch('chat-a', { name: 'Old intent' }, 'char-a')!
          applyChatMetadataOwnerPatch('char-a', 'chat-a', previous.attempted)
          mutation = dispatchChatMetadataPatchWithOutcome(previous)
        } else if (kind === 'folder') {
          const previous = captureChatFolderMetadataPatch('folder-a', { name: 'Old intent' }, 'char-a')!
          applyChatFolderMetadataOwnerPatch('char-a', 'folder-a', previous.attempted)
          mutation = dispatchChatFolderMetadataPatchWithOutcome(previous)
        } else {
          mutation = dispatchUpdateMessageScoped('message-a', { data: 'Old intent' }, currentChatScopedSnapshot())
        }
        await vi.waitFor(() => expect(fetchCommand).toHaveBeenCalledOnce())
        demoteClientSession()
        withTestDatabaseWrite(() => {
          chat().name = 'Current canonical chat'
          folder().name = 'Current canonical folder'
          chat().message[0].data = 'Current canonical message'
        })
        reapplyRetainedCharacterProjections('char-a')
        reapplyRetainedChatBodyProjections('chat-a')
        expect(chat().name).toBe('Current canonical chat')
        expect(folder().name).toBe('Current canonical folder')
        expect(chat().message[0].data).toBe('Current canonical message')
        repromoteClientWriter()
        response.resolve(jsonResponse({ error: 'temporarily unavailable' }, 503))
        await expect(mutation).resolves.toMatchObject({ status: 'queued' })
        expect(chat().name).toBe('Current canonical chat')
        expect(folder().name).toBe('Current canonical folder')
        expect(chat().message[0].data).toBe('Current canonical message')

        // Authoritative refreshes service the same retained callbacks later.
        reapplyRetainedCharacterProjections('char-a')
        reapplyRetainedChatBodyProjections('chat-a')
        expect(chat().name).toBe('Current canonical chat')
        expect(folder().name).toBe('Current canonical folder')
        expect(chat().message[0].data).toBe('Current canonical message')
        const pending = await listPendingMutations()
        expect(pending).toHaveLength(1)
        expect(JSON.stringify(pending[0].intent)).toContain('Old intent')
      } finally {
        response.resolve(jsonResponse({ error: 'cleanup' }, 503))
        await clearDurableOutbox()
      }
    },
  )

  it.each(['chat', 'folder'] as const)(
    'does not rebase a newer %s rename when an old generation is discarded',
    async (kind) => {
      await prepareDurableOutbox(`role-cycle-metadata-rebase-${kind}`, true)
      enterClientWriter()
      let discard: 'none' | 'older' | 'both' = 'none'
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
          const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
          const terminal = discard === 'both' || (discard === 'older' && body.patch?.name === 'Old intent')
          return jsonResponse({ error: terminal ? 'invalid rename' : 'temporarily unavailable' }, terminal ? 400 : 503)
        }),
      )
      const currentName = () =>
        kind === 'chat' ? getDatabase().characters[0].chats[0].name : getDatabase().characters[0].chatFolders[0].name
      const rename = (name: string) => {
        if (kind === 'chat') {
          const previous = captureChatMetadataPatch('chat-a', { name }, 'char-a')!
          applyChatMetadataOwnerPatch('char-a', 'chat-a', previous.attempted)
          return dispatchChatMetadataPatchWithOutcome(previous)
        }
        const previous = captureChatFolderMetadataPatch('folder-a', { name }, 'char-a')!
        applyChatFolderMetadataOwnerPatch('char-a', 'folder-a', previous.attempted)
        return dispatchChatFolderMetadataPatchWithOutcome(previous)
      }
      try {
        const older = await rename('Old intent')
        if (older?.status !== 'queued') throw new Error('Expected an older queued mutation')
        demoteClientSession()
        repromoteClientWriter()
        const newer = await rename('Current writer name')
        if (newer?.status !== 'queued') throw new Error('Expected a newer queued mutation')
        discard = 'older'
        await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1, retained: 1 })
        await expect(older.settlement).resolves.toMatchObject({ status: 'failed' })
        expect(currentName()).toBe('Current writer name')
        discard = 'both'
        await expect(replayPendingMutations()).resolves.toMatchObject({ discarded: 1, retained: 0 })
        await expect(newer.settlement).resolves.toMatchObject({ status: 'failed' })
        expect(currentName()).toBe('Old intent')
      } finally {
        await clearDurableOutbox()
      }
    },
  )

  it.each(['accepted', 'failed'] as const)(
    'settles an old retained batch as %s without reviving its projection or rollback',
    async (finalStatus) => {
      await prepareDurableOutbox(`role-cycle-batch-${finalStatus}`, true)
      enterClientWriter()
      const response = createDeferred<ServerCommandResult>()
      const command = vi.fn(() => response.promise)
      const rollback = vi.fn(() => applyChatMetadataOwnerPatch('char-a', 'chat-a', { name: 'Chat A' }))
      const reapply = vi.fn(() => applyChatMetadataOwnerPatch('char-a', 'chat-a', { name: 'Old batch intent' }))
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          if (String(input) === '/api/v1/commands/mutation-receipts/ack') return jsonResponse({ acknowledged: true })
          return finalStatus === 'failed'
            ? jsonResponse({ error: 'invalid batch edit' }, 400)
            : jsonResponse({
                revision: 11,
                event: { type: 'chat.updated', revision: 11, resource: 'chat', id: 'chat-a', parentId: 'char-a' },
              })
        }),
      )
      try {
        applyChatMetadataOwnerPatch('char-a', 'chat-a', { name: 'Old batch intent' })
        const batch = dispatchCharacterOwnedDurableBatch('char-a', [
          {
            method: 'PATCH',
            path: '/chats/chat-a',
            body: { patch: { name: 'Old batch intent' }, select: false },
            command,
            rollback,
            reapply,
          },
        ])
        await vi.waitFor(() => expect(command).toHaveBeenCalledOnce())
        demoteClientSession()
        withTestDatabaseWrite(() => {
          getDatabase().characters[0].chats[0].name = 'Current canonical chat'
        })
        repromoteClientWriter()
        response.resolve({ status: 'unavailable' })
        const retained = await batch
        if (retained.status !== 'retained' || !retained.settlement) throw new Error('Expected a retained batch')
        expect(getDatabase().characters[0].chats[0].name).toBe('Current canonical chat')
        expect(reapply).not.toHaveBeenCalled()
        expect(await listPendingMutations()).toHaveLength(1)
        await expect(replayPendingMutations()).resolves.toMatchObject({
          succeeded: finalStatus === 'accepted' ? 1 : 0,
          discarded: finalStatus === 'failed' ? 1 : 0,
          retained: 0,
        })
        await expect(retained.settlement).resolves.toMatchObject({ status: finalStatus })
        expect(rollback).not.toHaveBeenCalled()
        expect(getDatabase().characters[0].chats[0].name).toBe('Current canonical chat')
        expect(await listPendingMutations()).toEqual([])
      } finally {
        response.resolve({ status: 'unavailable' })
        await clearDurableOutbox()
      }
    },
  )
})
