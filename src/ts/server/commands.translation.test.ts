import { createDeferred, jsonResponse, makeCommandFetch } from './commands.testSupport'
import { describe, expect, it, vi } from 'vitest'
import {
  deferOwnServerCommandReconciliation,
  patchRuntimeSettings,
  runServerCommand,
  translateGreetingCommand,
  translateMessageCommand,
  withDirectServerCommandEventReconciliation,
  setCachedServerCommandRevision,
  setServerCommandSuccessReconciler,
  type ServerCommandLocalEffect,
} from './commands'

describe('translation commands and direct reconciliation', () => {
  it('keeps unqueued translation response reconciliation immediate during an unrelated queued mutation', async () => {
    const queuedResponse = createDeferred<Response>()
    const reconciledRevisions: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/messages/message-1/translate')) {
          return jsonResponse({
            revision: 11,
            event: { type: 'message.updated', revision: 11, resource: 'message', id: 'message-1' },
            chatId: 'chat-1',
            messageId: 'message-1',
            translation: { source: 'raw', text: 'translated' },
          })
        }
        return queuedResponse.promise
      }) as unknown as typeof fetch,
    )
    setCachedServerCommandRevision(10)
    setServerCommandSuccessReconciler(async (event) => {
      reconciledRevisions.push(event.revision)
    })

    const queued = runServerCommand({
      command: (baseRevision) =>
        patchRuntimeSettings({
          baseRevision,
          patch: { maxContext: 8_000 },
        }),
    })
    const translation = await translateMessageCommand({
      baseRevision: 10,
      messageId: 'message-1',
      jobId: 'translation-job-1',
    })

    expect(translation).toMatchObject({ status: 'ok', revision: 11 })
    expect(reconciledRevisions).toEqual([11])

    queuedResponse.resolve(
      jsonResponse({
        revision: 12,
        event: { type: 'settings.updated', revision: 12, resource: 'settings' },
      }),
    )
    await expect(queued).resolves.toMatchObject({ status: 'ok', revision: 12 })
    expect(reconciledRevisions).toEqual([11, 12])
  })

  it('dispatches message translation commands through the typed helper', async () => {
    const translation = {
      text: 'translated raw',
      source: 'raw',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const observedEffects: unknown[] = []
    setServerCommandSuccessReconciler((_event, _coalescedEvents, localEffects) => {
      observedEffects.push(...localEffects.values())
    })
    const commandFetch = makeCommandFetch(() => ({
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
      jobId: 'translation-job-a',
      translation,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      translateMessageCommand({
        baseRevision: 1,
        messageId: 'msg-a',
        jobId: 'translation-job-a',
        automatic: true,
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, messageId: 'msg-a', translation })

    expect(observedEffects).toEqual([
      {
        kind: 'messageTranslation',
        chatId: 'chat-a',
        messageId: 'msg-a',
        translation,
      },
    ])

    expect(commandFetch.calls.map((call) => ({ url: call.url, method: call.method, body: call.body }))).toEqual([
      {
        url: '/api/v1/commands/messages/msg-a/translate',
        method: 'POST',
        body: {
          baseRevision: 1,
          jobId: 'translation-job-a',
          automatic: true,
        },
      },
    ])
  })

  it('dispatches greeting translation immediately outside the durable mutation lane', async () => {
    const translation = {
      text: 'translated greeting',
      source: 'raw',
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'google',
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const reconciled: number[] = []
    setServerCommandSuccessReconciler((event) => {
      reconciled.push(event.revision)
    })
    const commandFetch = makeCommandFetch(() => ({
      revision: 2,
      event: {
        type: 'character.greetingTranslation.updated',
        revision: 2,
        resource: 'greetingTranslation',
        id: 'char a',
      },
      characterId: 'char a',
      chatId: 'chat-a',
      greetingIndex: -1,
      jobId: 'greeting-job-a',
      settingsHash: 'b'.repeat(64),
      translation,
    }))
    vi.stubGlobal('fetch', commandFetch.fetch)

    await expect(
      translateGreetingCommand({
        baseRevision: 1,
        characterId: 'char a',
        chatId: 'chat-a',
        greetingIndex: -1,
        jobId: 'greeting-job-a',
      }),
    ).resolves.toMatchObject({ status: 'ok', revision: 2, greetingIndex: -1, translation })
    expect(reconciled).toEqual([2])
    expect(commandFetch.calls).toEqual([
      expect.objectContaining({
        url: '/api/v1/commands/characters/char%20a/greetings/-1/translate',
        method: 'POST',
        body: { baseRevision: 1, chatId: 'chat-a', jobId: 'greeting-job-a' },
      }),
    ])
  })

  it('defers an own translation SSE echo until the canonical response arrives', async () => {
    const response = createDeferred<Response>()
    const translation = {
      text: 'translated raw',
      source: 'raw' as const,
      sourceHash: 'a'.repeat(64),
      targetLanguage: 'ko',
      inputLanguage: 'en',
      translatorType: 'llm' as const,
      settingsHash: 'b'.repeat(64),
      updatedAt: 123,
    }
    const event = {
      type: 'message.updated',
      revision: 2,
      resource: 'message',
      id: 'msg-a',
      parentId: 'chat-a',
    }
    const commandFetch = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', commandFetch)
    const reconciled: Array<{ revision: number; effects: unknown[] }> = []
    setServerCommandSuccessReconciler((commandEvent, _events, localEffects) => {
      reconciled.push({ revision: commandEvent.revision, effects: [...localEffects.values()] })
    })

    const pending = translateMessageCommand({
      baseRevision: 1,
      messageId: 'msg-a',
      jobId: 'translation-job-a',
    })
    await vi.waitFor(() => expect(commandFetch).toHaveBeenCalledTimes(1))
    expect(deferOwnServerCommandReconciliation(event)).toBe(true)
    expect(reconciled).toEqual([])

    response.resolve(
      jsonResponse({
        revision: 2,
        event,
        chatId: 'chat-a',
        messageId: 'msg-a',
        jobId: 'translation-job-a',
        translation,
      }),
    )
    await expect(pending).resolves.toMatchObject({ status: 'ok', revision: 2 })
    expect(reconciled).toEqual([
      {
        revision: 2,
        effects: [
          {
            kind: 'messageTranslation',
            chatId: 'chat-a',
            messageId: 'msg-a',
            translation,
          },
        ],
      },
    ])
  })

  it('keeps a direct event scope active before and during response reconciliation, then releases it', async () => {
    const event = {
      type: 'character.created',
      revision: 2,
      resource: 'character',
      id: 'char-imported',
    }
    const reconciliationStarted = createDeferred<void>()
    const releaseReconciliation = createDeferred<void>()
    const reconciled: number[] = []
    setServerCommandSuccessReconciler(async (commandEvent) => {
      reconciled.push(commandEvent.revision)
      reconciliationStarted.resolve()
      await releaseReconciliation.promise
    })

    const pending = withDirectServerCommandEventReconciliation(
      (candidate) => candidate.type === 'character.created' && candidate.resource === 'character',
      async (reconcileResponseEvent) => {
        // The SSE echo can lead the raw HTTP response.
        expect(deferOwnServerCommandReconciliation(event)).toBe(true)
        const applyingResponse = reconcileResponseEvent(event)
        await reconciliationStarted.promise

        // Keep buffering the same echo while the response-triggered resource
        // read is in flight, otherwise it could launch a duplicate read.
        expect(deferOwnServerCommandReconciliation(event)).toBe(true)
        releaseReconciliation.resolve()
        await applyingResponse
      },
    )

    await expect(pending).resolves.toBeUndefined()
    expect(reconciled).toEqual([2])
    // An echo delivered after the response reconciliation is no longer held;
    // bootstrap will see the advanced applied cursor and treat it as a no-op.
    expect(deferOwnServerCommandReconciliation(event)).toBe(false)
  })

  it('forwards a direct response local effect through reconciliation', async () => {
    const event = {
      type: 'message.appended',
      revision: 2,
      resource: 'message',
      id: 'message-a',
      parentId: 'chat-a',
    }
    const localEffect: ServerCommandLocalEffect = {
      kind: 'messageMutation',
      operation: 'append',
      chatId: 'chat-a',
      messageId: 'message-a',
      chatBodyProjectionEpoch: 4,
    }
    const reconciledEffects: ServerCommandLocalEffect[] = []
    setServerCommandSuccessReconciler((_event, _events, localEffects) => {
      reconciledEffects.push(...localEffects.values())
    })

    await withDirectServerCommandEventReconciliation(
      (candidate) => candidate.type === 'message.appended' && candidate.id === 'message-a',
      async (reconcileResponseEvent) => reconcileResponseEvent(event, localEffect),
    )

    expect(reconciledEffects).toEqual([localEffect])
  })

  it('releases unmatched and failed direct events through ordinary reconciliation', async () => {
    const unrelatedEvent = {
      type: 'character.created',
      revision: 2,
      resource: 'character',
      id: 'char-unrelated',
    }
    const confirmedEvent = {
      type: 'character.created',
      revision: 3,
      resource: 'character',
      id: 'char-imported',
    }
    const laterEvent = {
      type: 'character.created',
      revision: 4,
      resource: 'character',
      id: 'char-later',
    }
    const failedRequestEvent = {
      type: 'character.created',
      revision: 5,
      resource: 'character',
      id: 'char-after-failure',
    }
    const reconciled: number[][] = []
    setServerCommandSuccessReconciler((_event, events) => {
      reconciled.push(events.map((event) => event.revision))
    })
    const matchesCreatedCharacter = (event: { type: string; resource: string }) =>
      event.type === 'character.created' && event.resource === 'character'

    await withDirectServerCommandEventReconciliation(matchesCreatedCharacter, async (reconcileResponseEvent) => {
      expect(deferOwnServerCommandReconciliation(unrelatedEvent)).toBe(true)
      expect(deferOwnServerCommandReconciliation(laterEvent)).toBe(true)
      await reconcileResponseEvent(confirmedEvent)
    })

    await expect(
      withDirectServerCommandEventReconciliation(matchesCreatedCharacter, async () => {
        expect(deferOwnServerCommandReconciliation(failedRequestEvent)).toBe(true)
        throw new Error('request failed')
      }),
    ).rejects.toThrow('request failed')

    expect(reconciled).toEqual([[2], [3], [4], [5]])
  })
})
